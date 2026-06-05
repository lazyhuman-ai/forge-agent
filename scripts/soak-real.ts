import http, { type IncomingMessage } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CoreAPI } from "../src/core/core-api.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { buildTool } from "../src/tools/schemas.js";
import { AnthropicProvider } from "../src/agent/anthropic-provider.js";
import { OpenAIProvider } from "../src/agent/openai-provider.js";
import { DeepSeekProvider } from "../src/agent/deepseek-provider.js";
import { HttpGateway } from "../src/gateways/http/http-gateway.js";
import { createHttpServer } from "../src/gateways/http/http-server.js";
import { AuthStore } from "../src/auth/auth-store.js";
import { compact } from "../src/agent/compactor.js";
import type { ModelMessage, ModelProvider } from "../src/agent/model-provider.js";
import type { SessionEvent, ToolCall, ToolResult } from "../src/streams/event-types.js";

type ScenarioResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  detail: string;
};

type SoakContext = {
  api: CoreAPI;
  registry: ToolRegistry;
  provider: ModelProvider;
  dataDir: string;
  workspaceDir: string;
  autoResponses: Map<string, "allow_once" | "allow_session" | "deny">;
};

const DATA_DIR = resolve(process.env.SOAK_DATA_DIR ?? ".forge-soak-real");
const RUN_ID = `soak_${new Date().toISOString().replace(/[:.]/g, "-")}`;
const WORKSPACE_DIR = resolve(DATA_DIR, "workspace");
const DEFAULT_WAIT_MS = Number(process.env.SOAK_WAIT_MS ?? "180000");
const CYCLES = Number(process.env.SOAK_CYCLES ?? "1");
const PROVIDER_KIND = (process.env.SOAK_PROVIDER ?? "deepseek").toLowerCase();

function now(): number {
  return Date.now();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeProvider(): ModelProvider {
  if (PROVIDER_KIND === "openai") {
    return new OpenAIProvider({
      requestTimeoutMs: Number(process.env.SOAK_PROVIDER_TIMEOUT_MS ?? "120000"),
      maxRetries: Number(process.env.SOAK_PROVIDER_RETRIES ?? "1"),
    });
  }
  if (PROVIDER_KIND === "anthropic") {
    return new AnthropicProvider({
      requestTimeoutMs: Number(process.env.SOAK_PROVIDER_TIMEOUT_MS ?? "120000"),
      maxRetries: Number(process.env.SOAK_PROVIDER_RETRIES ?? "1"),
    });
  }
  return new DeepSeekProvider({
    requestTimeoutMs: Number(process.env.SOAK_PROVIDER_TIMEOUT_MS ?? "120000"),
    maxRetries: Number(process.env.SOAK_PROVIDER_RETRIES ?? "1"),
  });
}

function registerSoakTools(registry: ToolRegistry): void {
  registry.register(buildTool({
    name: "soak_echo",
    description: "Soak test echo tool. Use when the user asks for a soak echo.",
    params: {
      text: { type: "string", description: "Text to echo back" },
    },
    capabilities: ["fs.read"],
    isConcurrencySafe: true,
    isReadOnly: true,
    handler: async (args) => `SOAK_ECHO:${String(args.text ?? "")}`,
  }));

  registry.register(buildTool({
    name: "soak_large_output",
    description: "Soak test large output tool. Use when the user asks to produce a large artifact.",
    params: {
      label: { type: "string", description: "Label for the generated large output" },
    },
    capabilities: ["fs.read"],
    isConcurrencySafe: true,
    isReadOnly: true,
    handler: async (args) => {
      const label = String(args.label ?? "large");
      return `${label}\n${"x".repeat(70_000)}`;
    },
  }));
}

function setupCore(): SoakContext {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(WORKSPACE_DIR, { recursive: true });

  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, {
    dataDir: DATA_DIR,
    memoryDir: join(DATA_DIR, "memory"),
    artifactDir: join(DATA_DIR, "artifacts"),
  });
  api.registerBuiltInTools();
  registerSoakTools(registry);
  api.initSupervisor(2);
  api.initScheduler();
  api.initMemoryManager({ autoRun: false, proposalThreshold: 2 });
  api.initToolPolicy({
    timeoutMs: Number(process.env.SOAK_PERMISSION_TIMEOUT_MS ?? "30000"),
    projectRoot: process.cwd(),
  });
  const provider = makeProvider();
  api.setModelProvider(provider);

  const autoResponses = new Map<string, "allow_once" | "allow_session" | "deny">();
  api.onSessionEvent((sessionId, event) => {
    if (event.type !== "permission_request") return;
    const decision = autoResponses.get(sessionId) ?? "allow_once";
    setTimeout(() => {
      try {
        api.respondToPermissionRequest(event.permissionRequestId, {
          decision,
          message: decision === "deny"
            ? "Soak test intentionally denied this permission request."
            : "Soak test auto-approved this permission request.",
          deviceId: "soak-device",
          deviceName: "Soak Harness",
        });
      } catch {
        // The request may already have timed out or been interrupted.
      }
    }, 10);
  });

  return { api, registry, provider, dataDir: DATA_DIR, workspaceDir: WORKSPACE_DIR, autoResponses };
}

async function waitForSessionIdleOr(
  api: CoreAPI,
  sessionId: string,
  statuses: string[],
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<void> {
  const started = now();
  while (now() - started < timeoutMs) {
    const status = api.getSession(sessionId)?.status;
    if (status && statuses.includes(status)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for session ${sessionId}; current status=${api.getSession(sessionId)?.status}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario(
  name: string,
  fn: () => Promise<string>,
): Promise<ScenarioResult> {
  const started = now();
  try {
    const detail = await fn();
    return { name, ok: true, durationMs: now() - started, detail };
  } catch (err) {
    return {
      name,
      ok: false,
      durationMs: now() - started,
      detail: err instanceof Error ? err.stack ?? err.message : String(err),
    };
  }
}

function threadTypes(events: SessionEvent[]): string {
  return events.map((event) => event.type).join(" -> ");
}

function assertToolPairs(events: SessionEvent[]): void {
  const calls = new Map<string, ToolCall>();
  const results = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_call") {
      calls.set(event.toolUseId ?? `call_${event.seq}`, event);
    } else if (event.type === "tool_result") {
      results.add(event.toolUseId ?? `call_${event.seq - 1}`);
    }
  }
  const missing = [...calls.keys()].filter((id) => !results.has(id));
  assert(missing.length === 0, `Dangling tool_call(s): ${missing.join(", ")}`);
}

function lastAssistantText(events: SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "assistant_message") return event.text;
  }
  return "";
}

async function scenarioSimpleChat(ctx: SoakContext): Promise<string> {
  const session = ctx.api.createSession(`${RUN_ID} simple chat`);
  ctx.api.appendUserMessage(
    session.id,
    "Reply with exactly this prefix and a short sentence: SOAK_SIMPLE_OK",
    { source: { kind: "cli", interactive: true, deviceId: "soak-device", deviceName: "Soak Harness" } },
  );
  await waitForSessionIdleOr(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assert(events.some((event) => event.type === "assistant_message"), "No assistant_message produced");
  assert(lastAssistantText(events).includes("SOAK_SIMPLE_OK"), `Unexpected assistant text: ${lastAssistantText(events)}`);
  assertToolPairs(events);
  return threadTypes(events);
}

async function scenarioCustomTool(ctx: SoakContext): Promise<string> {
  const session = ctx.api.createSession(`${RUN_ID} custom tool`);
  ctx.api.appendUserMessage(
    session.id,
    [
      "You must call the tool soak_echo with text='tool-path-ok'.",
      "After receiving the tool result, answer with the exact prefix SOAK_TOOL_OK and include the tool result.",
    ].join(" "),
    { source: { kind: "cli", interactive: true, deviceId: "soak-device", deviceName: "Soak Harness" } },
  );
  await waitForSessionIdleOr(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assert(events.some((event) => event.type === "tool_call" && event.toolName === "soak_echo"), "Model did not call soak_echo");
  assert(events.some((event) => event.type === "tool_result" && event.toolName === "soak_echo" && String(event.result).includes("SOAK_ECHO:tool-path-ok")), "Missing soak_echo tool_result");
  assert(lastAssistantText(events).includes("SOAK_TOOL_OK"), `Unexpected assistant text: ${lastAssistantText(events)}`);
  assertToolPairs(events);
  return threadTypes(events);
}

async function scenarioArtifact(ctx: SoakContext): Promise<string> {
  const session = ctx.api.createSession(`${RUN_ID} artifact`);
  ctx.api.appendUserMessage(
    session.id,
    [
      "You must call soak_large_output with label='artifact-ok'.",
      "After the tool result, answer with the exact prefix SOAK_ARTIFACT_OK and mention the artifact id if visible.",
    ].join(" "),
    { source: { kind: "cli", interactive: true, deviceId: "soak-device", deviceName: "Soak Harness" } },
  );
  await waitForSessionIdleOr(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  const pointer = events.find((event) => event.type === "artifact_pointer");
  assert(pointer?.type === "artifact_pointer", `No artifact_pointer; thread=${threadTypes(events)}`);
  const artifact = ctx.api.retrieveArtifact(pointer.artifactId);
  assert(artifact && artifact.toString("utf-8").includes("artifact-ok"), "Artifact content missing expected label");
  const result = events.find((event) => event.type === "tool_result" && event.toolName === "soak_large_output");
  assert(result?.type === "tool_result", "Missing large output tool_result preview");
  assert(String(result.result).includes("<persisted-output>"), "Large output was not replaced with persisted-output preview");
  assertToolPairs(events);
  return `artifact=${pointer.artifactId}; ${threadTypes(events)}`;
}

async function scenarioPermissionDeniedRecovery(ctx: SoakContext): Promise<string> {
  const session = ctx.api.createSession(`${RUN_ID} permission deny`);
  ctx.autoResponses.set(session.id, "deny");
  ctx.api.appendUserMessage(
    session.id,
    [
      "You must call bash with command='rm -rf /tmp/forgeagent-soak-denied'.",
      "If the tool result says permission denied, do not retry bash.",
      "Instead answer with the exact prefix SOAK_PERMISSION_DENIED_OK and summarize the denial reason.",
    ].join(" "),
    { source: { kind: "cli", interactive: true, deviceId: "soak-device", deviceName: "Soak Harness" } },
  );
  await waitForSessionIdleOr(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  ctx.autoResponses.delete(session.id);
  assert(events.some((event) => event.type === "permission_request"), "No permission_request written");
  assert(events.some((event) => event.type === "permission_response"), "No permission_response written");
  const toolResult = events.find((event): event is ToolResult => event.type === "tool_result" && event.toolName === "bash");
  assert(toolResult, "No bash tool_result");
  assert(toolResult.isError, "Denied bash result is not marked isError");
  assert(String(toolResult.result).includes("Tool permission denied before execution."), "Denied bash result lacks readable permission text");
  assert(lastAssistantText(events).includes("SOAK_PERMISSION_DENIED_OK"), `Unexpected assistant recovery text: ${lastAssistantText(events)}`);
  assertToolPairs(events);
  return threadTypes(events);
}

async function scenarioAskUser(ctx: SoakContext): Promise<string> {
  const session = ctx.api.createSession(`${RUN_ID} ask user`);
  ctx.api.appendUserMessage(
    session.id,
    [
      "You must call ask_user with question='What is the soak confirmation code?'.",
      "After the user replies, answer with the exact prefix SOAK_ASK_USER_OK and include the reply.",
    ].join(" "),
    { source: { kind: "cli", interactive: true, deviceId: "soak-device", deviceName: "Soak Harness" } },
  );
  await waitForSessionIdleOr(ctx.api, session.id, ["waiting_user"]);
  ctx.api.appendUserMessage(
    session.id,
    "The soak confirmation code is 12345.",
    { source: { kind: "cli", interactive: true, deviceId: "soak-device", deviceName: "Soak Harness" } },
  );
  await waitForSessionIdleOr(ctx.api, session.id, ["idle"]);
  const events = ctx.api.getThread(session.id);
  assert(events.some((event) => event.type === "tool_call" && event.toolName === "ask_user"), "No ask_user tool_call");
  assert(lastAssistantText(events).includes("SOAK_ASK_USER_OK"), `Unexpected assistant text: ${lastAssistantText(events)}`);
  assertToolPairs(events);
  return threadTypes(events);
}

async function scenarioHttpSse(ctx: SoakContext): Promise<string> {
  const authStore = new AuthStore(join(ctx.dataDir, "auth-http-soak"));
  const gateway = new HttpGateway(ctx.api);
  const server = createHttpServer(ctx.api, gateway, {
    authStore,
    allowedOrigins: ["http://localhost"],
    maxBodyBytes: 1024 * 1024,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object", "HTTP server did not expose a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const code = authStore.issuePairingCode();
    const paired = await jsonRequest(baseUrl, "POST", "/auth/pair", {
      code: code.code,
      name: "Soak Phone",
      kind: "android",
    });
    assert(paired.status === 201, `pair failed: ${paired.status} ${JSON.stringify(paired.body)}`);
    const token = (paired.body as { token?: string }).token;
    assert(token, "No token returned from pairing");

    const created = await jsonRequest(baseUrl, "POST", "/sessions", { title: `${RUN_ID} http` }, token);
    assert(created.status === 201, `create session failed: ${created.status}`);
    const sessionId = (created.body as { id?: string }).id;
    assert(sessionId, "No session id returned");

    const stream = await jsonRequest(baseUrl, "POST", "/auth/stream-token", {}, token);
    assert(stream.status === 201, `stream token failed: ${stream.status}`);
    const streamToken = (stream.body as { code?: string }).code;
    assert(streamToken, "No stream token");

    const beforeSeq = Math.max(0, ...ctx.api.getThread(sessionId).map((event) => event.seq));
    const posted = await jsonRequest(baseUrl, "POST", `/sessions/${sessionId}/messages`, {
      text: "Reply with exactly this prefix and a short sentence: SOAK_HTTP_OK",
    }, token);
    assert(posted.status === 202, `post message failed: ${posted.status} ${JSON.stringify(posted.body)}`);
    await waitForSessionIdleOr(ctx.api, sessionId, ["idle"]);

    const thread = await jsonRequest(baseUrl, "GET", `/sessions/${sessionId}/thread?afterSeq=${beforeSeq}`, undefined, token);
    assert(thread.status === 200, `thread read failed: ${thread.status}`);
    const events = thread.body as SessionEvent[];
    assert(events.some((event) => event.type === "assistant_message"), "HTTP thread delta missing assistant_message");

    const sse = await readSseUntil(baseUrl, `/events?cursor=${beforeSeq}&stream_token=${encodeURIComponent(streamToken)}`, "session_event");
    assert(sse.includes("event: session_event"), "SSE replay did not include session_event");
    return `httpEvents=${events.length}; sseBytes=${sse.length}`;
  } finally {
    gateway.destroy();
    server.close();
    await once(server, "close").catch(() => undefined);
  }
}

async function scenarioCompaction(ctx: SoakContext): Promise<string> {
  const sessionId = `${RUN_ID}_compaction`;
  const events: SessionEvent[] = [
    { type: "user_message", seq: 1, timestamp: new Date().toISOString(), sessionId, text: "We decided the soak compaction marker is SOAK_COMPACTION_FACT." },
    { type: "assistant_message", seq: 2, timestamp: new Date().toISOString(), sessionId, text: "Acknowledged. The marker is SOAK_COMPACTION_FACT." },
    { type: "tool_call", seq: 3, timestamp: new Date().toISOString(), sessionId, toolName: "soak_echo", args: { text: "compaction" }, toolUseId: "tc_compact" },
    { type: "tool_result", seq: 4, timestamp: new Date().toISOString(), sessionId, toolName: "soak_echo", result: "SOAK_ECHO:compaction", isError: false, toolUseId: "tc_compact" },
  ];
  const block = await compact({
    events,
    seq: 5,
    sessionId,
    modelProvider: ctx.provider,
    timestamp: new Date().toISOString(),
  });
  assert(block.summary.includes("SOAK_COMPACTION_FACT"), `Compaction summary lost marker: ${block.summary}`);
  return `summaryChars=${block.summary.length}`;
}

async function scenarioMemoryMaintenance(ctx: SoakContext): Promise<string> {
  const session = ctx.api.createSession(`${RUN_ID} memory`);
  ctx.api.appendUserMessage(
    session.id,
    "Remember this stable project fact: ForgeAgent soak marker is SOAK_MEMORY_FACT.",
    { source: { kind: "cli", interactive: true, deviceId: "soak-device", deviceName: "Soak Harness" } },
  );
  await waitForSessionIdleOr(ctx.api, session.id, ["idle"]);
  const report = await ctx.api.runMemoryMaintenance({ force: true, consolidate: true });
  assert(report.extractedProposals >= 0, "Memory maintenance report missing extraction count");
  const status = ctx.api.getMemoryStatus();
  assert(status.state === "idle" || status.state === "degraded", `Unexpected memory status: ${status.state}`);
  return `memoryState=${status.state}; extracted=${report.extractedProposals}; promoted=${report.promoted}`;
}

async function scenarioRehydrate(ctx: SoakContext): Promise<string> {
  const session = ctx.api.createSession(`${RUN_ID} rehydrate`);
  ctx.api.appendUserMessage(
    session.id,
    "Reply with exactly this prefix: SOAK_REHYDRATE_OK",
    { dispatch: false, source: { kind: "cli", interactive: true, deviceId: "soak-device", deviceName: "Soak Harness" } },
  );
  ctx.api.flush();

  const registry = new ToolRegistry();
  const api2 = new CoreAPI(registry, {
    dataDir: ctx.dataDir,
    memoryDir: join(ctx.dataDir, "memory"),
    artifactDir: join(ctx.dataDir, "artifacts"),
  });
  api2.registerBuiltInTools();
  registerSoakTools(registry);
  api2.initSupervisor(2);
  api2.initScheduler();
  api2.initMemoryManager({ autoRun: false });
  api2.initToolPolicy({ projectRoot: process.cwd() });
  api2.setModelProvider(ctx.provider);
  api2.loadSessions();
  const report = await api2.rehydrateAfterStartup();
  const blocked = api2.getSession(session.id);
  assert(blocked?.status === "blocked", `Restarted running session should be blocked, got ${blocked?.status}`);
  assert(report.startupBlockedSessions.includes(session.id), `Rehydrate report did not include startup blocked session: ${JSON.stringify(report)}`);
  let events = api2.getThread(session.id);
  assert(
    events.some((event) => event.type === "runtime_event" && event.message.includes("blocked instead of automatically resuming")),
    `Missing readable startup blocked runtime_event. Thread=${threadTypes(events)}`,
  );
  const retryLimit = Number(process.env.SOAK_REHYDRATE_RETRY_LIMIT ?? "3");
  for (let attempt = 1; attempt <= retryLimit; attempt++) {
    if (api2.getSession(session.id)?.status === "blocked") {
      api2.retryBlockedSession(session.id);
    }
    await waitForSessionIdleOr(api2, session.id, ["idle", "blocked"]);
    if (api2.getSession(session.id)?.status === "idle") break;
    if (attempt < retryLimit) await sleep(1_500 * attempt);
  }
  events = api2.getThread(session.id);
  assert(api2.getSession(session.id)?.status === "idle", `Rehydrate retry did not reach idle; current status=${api2.getSession(session.id)?.status}`);
  assert(lastAssistantText(events).includes("SOAK_REHYDRATE_OK"), `Rehydrated turn did not finish correctly: ${lastAssistantText(events)}`);
  api2.flush();
  return `startupBlocked=${report.startupBlockedSessions.length}; requeued=${report.requeuedSessions.length}; repaired=${report.repairedToolResults}; retry=ok`;
}

async function jsonRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolvePromise, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (raw !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(new URL(path, baseUrl), { method, headers, timeout: DEFAULT_WAIT_MS }, (res: IncomingMessage) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolvePromise({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
        } catch {
          resolvePromise({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP ${method} ${path} timed out`));
    });
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}

function readSseUntil(baseUrl: string, path: string, expectedEvent: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(new URL(path, baseUrl), { method: "GET", timeout: DEFAULT_WAIT_MS }, (res: IncomingMessage) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk.toString();
        if (raw.includes(`event: ${expectedEvent}`)) {
          req.destroy();
          resolvePromise(raw);
        }
      });
      res.on("end", () => resolvePromise(raw));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET" && expectedEvent) return;
      reject(err);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("SSE timed out"));
    });
    req.end();
  });
}

async function main(): Promise<void> {
  if (!existsSync(".env") && !process.env.API_KEY) {
    throw new Error("No .env file or API_KEY environment variable found. Real soak requires a provider key.");
  }

  const ctx = setupCore();
  const scenarios: Array<[string, (ctx: SoakContext) => Promise<string>]> = [
    ["simple_chat", scenarioSimpleChat],
    ["custom_tool", scenarioCustomTool],
    ["artifact_large_output", scenarioArtifact],
    ["permission_denied_recovery", scenarioPermissionDeniedRecovery],
    ["ask_user", scenarioAskUser],
    ["http_sse_sync", scenarioHttpSse],
    ["llm_compaction", scenarioCompaction],
    ["memory_maintenance", scenarioMemoryMaintenance],
    ["startup_rehydrate", scenarioRehydrate],
  ];
  const selected = process.env.SOAK_SCENARIOS
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const runList = selected && selected.length > 0
    ? scenarios.filter(([name]) => selected.includes(name))
    : scenarios;
  assert(runList.length > 0, `No soak scenarios selected. Available: ${scenarios.map(([name]) => name).join(", ")}`);

  const results: ScenarioResult[] = [];
  console.log(`[soak] run=${RUN_ID} provider=${PROVIDER_KIND} cycles=${CYCLES} dataDir=${DATA_DIR}`);
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    console.log(`[soak] cycle ${cycle + 1}/${CYCLES}`);
    for (const [name, scenario] of runList) {
      const result = await runScenario(`${name}#${cycle + 1}`, () => scenario(ctx));
      results.push(result);
      const mark = result.ok ? "PASS" : "FAIL";
      console.log(`[soak] ${mark} ${result.name} ${result.durationMs}ms ${result.detail.split("\n")[0]}`);
      if (!result.ok && process.env.SOAK_CONTINUE_ON_FAILURE !== "1") break;
    }
    if (results.some((result) => !result.ok) && process.env.SOAK_CONTINUE_ON_FAILURE !== "1") break;
  }

  ctx.api.flush();
  const failed = results.filter((result) => !result.ok);
  const reportPath = join(DATA_DIR, "soak-report.json");
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    runId: RUN_ID,
    provider: PROVIDER_KIND,
    cycles: CYCLES,
    results,
    sessions: ctx.api.listSessions(),
    systemEvents: ctx.api.getSystemEvents(),
  }, null, 2), "utf-8");

  console.log(`[soak] report=${reportPath}`);
  console.log(`[soak] summary pass=${results.length - failed.length} fail=${failed.length}`);
  if (failed.length > 0) {
    for (const failure of failed) {
      console.error(`[soak] failure ${failure.name}\n${failure.detail}`);
    }
    process.exitCode = 1;
  }

  if (process.env.SOAK_PRINT_LAST_REPORT === "1") {
    console.log(readFileSync(reportPath, "utf-8"));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
