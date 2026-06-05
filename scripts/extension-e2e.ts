import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { CoreAPI } from "../src/core/core-api.js";
import { DeepSeekProvider } from "../src/agent/deepseek-provider.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ToolRuntime } from "../src/tools/tool-runtime.js";
import { HttpGateway } from "../src/gateways/http/http-gateway.js";
import { createHttpServer } from "../src/gateways/http/http-server.js";
import { ProviderConfigStore } from "../src/config/provider-config-store.js";
import type { PermissionResponseDecision, ToolRequestSource } from "../src/permissions/tool-policy.js";
import type { SessionEvent } from "../src/streams/event-types.js";
import type { ToolDefinition } from "../src/tools/schemas.js";

type Report = {
  startedAt: string;
  dataDir: string;
  workspaceDir: string;
  scenarios: Array<{ name: string; ok: boolean; detail: string; durationMs: number }>;
};

const DATA_DIR = resolve(process.env.EXTENSION_E2E_DATA_DIR ?? ".forge-extension-e2e");
const CORE_DIR = join(DATA_DIR, "core");
const WORKSPACE_DIR = join(DATA_DIR, "workspace");
const REPORT_DIR = join(DATA_DIR, "reports");
const WAIT_MS = Number(process.env.EXTENSION_E2E_WAIT_MS ?? "180000");
const HOST = "127.0.0.1";
const DEVICE_SOURCE: ToolRequestSource = {
  kind: "cli",
  interactive: true,
  deviceId: "extension-e2e-device",
  deviceName: "Extension E2E Harness",
};
const CODE_REVIEWER_SKILL_URL =
  "https://raw.githubusercontent.com/vadimcomanescu/codex-skills/main/skills/.curated/quality/code-reviewer/SKILL.md";
const FRONTEND_DESIGN_SKILL_URL =
  "https://raw.githubusercontent.com/vadimcomanescu/codex-skills/main/skills/.curated/design/frontend-design/SKILL.md";
const SERENITY_INVEST_SKILL_URL = "https://github.com/leileqiTHU/serenity-invest-skill";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function providerConfigured(): boolean {
  return existsSync(".env") || Boolean(process.env.API_KEY || process.env.DEEPSEEK_API_KEY);
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close();
        reject(new Error("Could not allocate a free port."));
        return;
      }
      const port = address.port;
      server.close(() => resolvePromise(port));
    });
  });
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((err) => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      if (err) reject(err);
      else resolvePromise();
    });
  });
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasEnableTrue(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasEnableTrue);
  const record = value as Record<string, unknown>;
  if (record.enable === true || record.enabled === true) return true;
  return Object.values(record).some(hasEnableTrue);
}

async function waitForSessionStatus(api: CoreAPI, sessionId: string, statuses: string[]): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    const status = api.getSession(sessionId)?.status;
    if (status && statuses.includes(status)) return;
    if (status === "blocked" && !statuses.includes("blocked")) {
      const tail = api.getThread(sessionId).slice(-8).map((event) => ({
        type: event.type,
        seq: event.seq,
        text: "text" in event ? event.text : undefined,
        message: "message" in event ? event.message : undefined,
        runtimeKind: "runtimeKind" in event ? event.runtimeKind : undefined,
      }));
      throw new Error(`Session ${sessionId} became blocked while waiting for ${statuses.join("/")}. Thread tail=${JSON.stringify(tail, null, 2)}`);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for session ${sessionId}; current status=${api.getSession(sessionId)?.status}`);
}

function lastAssistantText(events: SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "assistant_message") return event.text;
  }
  return "";
}

function assertToolPairs(events: SessionEvent[]): void {
  const calls = new Map<string, string>();
  const results = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_call") calls.set(event.toolUseId ?? `seq_${event.seq}`, event.toolName);
    if (event.type === "tool_result") results.add(event.toolUseId ?? `seq_${event.seq - 1}`);
  }
  const missing = [...calls.keys()].filter((id) => !results.has(id));
  assert(missing.length === 0, `Dangling tool_call(s): ${missing.map((id) => `${id}:${calls.get(id)}`).join(", ")}`);
}

function assertToolCall(events: SessionEvent[], predicate: (event: Extract<SessionEvent, { type: "tool_call" }>) => boolean, message: string): void {
  assert(events.some((event) => event.type === "tool_call" && predicate(event)), message);
}

function assertToolResult(events: SessionEvent[], predicate: (event: Extract<SessionEvent, { type: "tool_result" }>) => boolean, message: string): void {
  assert(events.some((event) => event.type === "tool_result" && predicate(event)), message);
}

async function runAgentTask(
  api: CoreAPI,
  sessionTitle: string,
  projectId: string,
  prompt: string,
): Promise<SessionEvent[]> {
  const session = api.createSession(sessionTitle, { projectId });
  api.appendUserMessage(session.id, prompt, { source: DEVICE_SOURCE });
  await waitForSessionStatus(api, session.id, ["idle"]);
  const events = api.getThread(session.id);
  assertToolPairs(events);
  return events;
}

function findTool(registry: ToolRegistry, serverId: string, originalName: string): ToolDefinition {
  const tool = registry.list().find((candidate) => (
    candidate.source?.kind === "mcp" &&
    candidate.source.serverId === serverId &&
    candidate.source.originalName === originalName
  ));
  assert(tool, `Missing MCP tool ${serverId}/${originalName}. Available=${registry.list().map((item) => item.name).join(", ")}`);
  return tool;
}

async function runScenario(
  report: Report,
  name: string,
  fn: () => Promise<string>,
): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    report.scenarios.push({ name, ok: true, detail, durationMs: Date.now() - started });
  } catch (err) {
    report.scenarios.push({
      name,
      ok: false,
      detail: err instanceof Error ? err.stack ?? err.message : String(err),
      durationMs: Date.now() - started,
    });
  }
}

async function main(): Promise<void> {
  if (!providerConfigured()) {
    throw new Error("No real provider configuration found. Provide .env, API_KEY, or DEEPSEEK_API_KEY before running extension E2E.");
  }
  if (!existsSync(resolve("web/dist/index.html"))) {
    throw new Error("web/dist is missing. Run npm run product:build before npm run extensions:e2e.");
  }

  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  mkdirSync(REPORT_DIR, { recursive: true });

  const port = await freePort();
  const baseUrl = `http://${HOST}:${port}`;
  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, {
    dataDir: CORE_DIR,
    memoryDir: join(CORE_DIR, "memory"),
    artifactDir: join(CORE_DIR, "artifacts"),
    contextWindowTokens: Number(process.env.EXTENSION_E2E_CONTEXT_WINDOW_TOKENS ?? "1000000"),
  });
  api.registerBuiltInTools();
  api.initSupervisor(2);
  api.initScheduler();
  api.initMemoryManager({ autoRun: false });
  api.initSkillEcosystem({ autoRun: false });
  const project = api.createProject({
    name: "Extension E2E Workspace",
    path: WORKSPACE_DIR,
    create: true,
    trustState: "trusted",
  });
  api.initToolPolicy({
    projectRoot: WORKSPACE_DIR,
    timeoutMs: Number(process.env.EXTENSION_E2E_PERMISSION_TIMEOUT_MS ?? "30000"),
  });
  api.setModelProvider(new DeepSeekProvider({
    requestTimeoutMs: Number(process.env.EXTENSION_E2E_PROVIDER_TIMEOUT_MS ?? "120000"),
    maxRetries: Number(process.env.EXTENSION_E2E_PROVIDER_RETRIES ?? "1"),
  }));
  api.initMcpEcosystem({
    projectRoot: WORKSPACE_DIR,
    baseUrl,
    baseDelayMs: 250,
    maxDelayMs: 1_000,
    keepaliveMs: 120_000,
    failureCooldownMs: 1_000,
  });
  api.initExtensionEcosystem({ replace: true });

  const autoResponses = new Map<string, PermissionResponseDecision>();
  api.onSessionEvent((sessionId, event) => {
    if (event.type !== "permission_request") return;
    const decision = autoResponses.get(sessionId) ?? "allow_once";
    setTimeout(() => {
      try {
        api.respondToPermissionRequest(event.permissionRequestId, {
          decision,
          message: decision === "deny"
            ? "Extension E2E intentionally denied this permission request."
            : "Extension E2E auto-approved this permission request.",
          deviceId: DEVICE_SOURCE.deviceId,
          deviceName: DEVICE_SOURCE.deviceName,
        });
      } catch {
        // Request may have been answered, interrupted, or timed out.
      }
    }, 10);
  });

  const gateway = new HttpGateway(api);
  const server = createHttpServer(api, gateway, {
    enableUi: true,
    uiDir: resolve("web/dist"),
    providerConfigStore: new ProviderConfigStore(join(CORE_DIR, "config")),
    discovery: { host: HOST, port, dataDir: CORE_DIR },
  });
  await listen(server, port);

  const report: Report = {
    startedAt: new Date().toISOString(),
    dataDir: DATA_DIR,
    workspaceDir: WORKSPACE_DIR,
    scenarios: [],
  };
  const browser = await chromium.launch();

  try {
    await runScenario(report, "control-page-install-filesystem-and-call-real-mcp", async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(baseUrl);
      await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Extensions" }).click();
      await expect(page.locator(".extensions-center")).toBeVisible();
      await page.locator(".extension-search-panel input").first().fill("filesystem");
      await page.locator(".extension-search-panel button.primary").click();
      const card = page.locator(".extension-card", { hasText: "Filesystem" }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByRole("button", { name: "Install" }).click();
      await expect(page.locator(".extension-message")).toContainText("installed", { timeout: 60_000 });
      const refreshed = page.locator(".extension-card", { hasText: "Filesystem" }).first();
      await expect(refreshed.getByRole("button", { name: "Enable" })).toBeVisible({ timeout: 15_000 });
      await refreshed.getByRole("button", { name: "Enable" }).click();
      await expect(page.locator(".extension-message")).toContainText("enabled", { timeout: 60_000 });
      await page.close();

      await api.retryMcpServer("filesystem");
      const runtime = new ToolRuntime(registry);
      const session = api.createSession("Extension E2E control MCP call", { projectId: project.id });
      const target = join(WORKSPACE_DIR, "control-page-filesystem.txt");
      const writeTool = findTool(registry, "filesystem", "write_file");
      const readTool = findTool(registry, "filesystem", "read_file");
      const write = await runtime.execute(writeTool.name, { path: target, content: "CONTROL_EXTENSION_OK" }, session.id, {
        source: DEVICE_SOURCE,
        signal: new AbortController().signal,
      });
      assert(!write.isError, `Filesystem MCP write failed:\n${serialize(write.output)}`);
      const read = await runtime.execute(readTool.name, { path: target }, session.id, {
        source: DEVICE_SOURCE,
        signal: new AbortController().signal,
      });
      assert(!read.isError, `Filesystem MCP read failed:\n${serialize(read.output)}`);
      assert(serialize(read.output).includes("CONTROL_EXTENSION_OK"), `Filesystem MCP read content mismatch:\n${serialize(read.output)}`);
      assert(readFileSync(target, "utf-8").includes("CONTROL_EXTENSION_OK"), "Filesystem MCP did not write to workspace.");
      return `installed filesystem via Web Console; called ${writeTool.name}/${readTool.name}`;
    });

    await runScenario(report, "control-page-install-github-skill-and-agent-uses-it", async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(baseUrl);
      await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Extensions" }).click();
      await expect(page.locator(".extensions-center")).toBeVisible();
      await page.locator(".extension-search-panel input").nth(1).fill(CODE_REVIEWER_SKILL_URL);
      await page.locator(".extension-search-panel button.primary").click();
      const card = page.locator(".extension-card", { hasText: "code-reviewer" }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByRole("button", { name: "Install" }).click();
      await expect(page.locator(".extension-message")).toContainText("Skill installed", { timeout: 60_000 });
      await page.close();

      const events = await runAgentTask(
        api,
        "Extension E2E control skill use",
        project.id,
        [
          "This is a release gate for ForgeAgent skills installed from the Web Console.",
          "Use the installed code-reviewer skill. First read its SKILL.md with read_file, then apply it.",
          "Review this tiny patch: `function sum(a,b){ return a - b }` should add numbers.",
          "Finish with prefix SKILL_CONTROL_OK and mention the concrete bug.",
        ].join(" "),
      );
      assertToolCall(events, (event) => event.toolName === "read_file" && serialize(event.args).includes("code-reviewer"), "Agent did not read the installed code-reviewer SKILL.md.");
      assertToolResult(events, (event) => event.toolName === "read_file" && !event.isError && serialize(event.result).includes("# Code Reviewer"), "Agent read_file did not successfully return code-reviewer SKILL.md.");
      const answer = lastAssistantText(events);
      assert(answer.includes("SKILL_CONTROL_OK"), `Agent did not finish with expected skill marker. Answer=${answer}`);
      assert(/a\s*-\s*b|subtract|减/.test(answer), `Agent did not apply the code-reviewer skill to the patch. Answer=${answer}`);
      return `installed code-reviewer via Web Console; agent read SKILL.md and reviewed patch`;
    });

    await runScenario(report, "control-page-install-bundle-and-agent-uses-components", async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(baseUrl);
      await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Extensions" }).click();
      await expect(page.locator(".extensions-center")).toBeVisible();
      await page.locator(".extension-search-panel input").first().fill("design reference bundle");
      await page.locator(".extension-search-panel button.primary").click();
      const card = page.locator(".extension-card", { hasText: "Design Reference Bundle" }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByRole("button", { name: "Install" }).click();
      await expect(page.locator(".extension-message")).toContainText("Bundle installed", { timeout: 90_000 });
      await page.close();

      const events = await runAgentTask(
        api,
        "Extension E2E control bundle use",
        project.id,
        [
          "This is a release gate for a ForgeAgent bundle installed from the Web Console.",
          "Use the installed frontend-design skill: first read its SKILL.md with read_file.",
          "Then connect to the Everything MCP server and call its echo tool with text BUNDLE_CONTROL_TOOL_OK.",
          "Finish with prefix BUNDLE_CONTROL_OK and include the echoed text.",
        ].join(" "),
      );
      assertToolCall(events, (event) => event.toolName === "read_file" && serialize(event.args).includes("frontend-design"), "Agent did not read the installed frontend-design SKILL.md from the bundle.");
      assertToolResult(events, (event) => event.toolName === "read_file" && !event.isError && serialize(event.result).includes("# Frontend Design"), "Agent read_file did not successfully return frontend-design SKILL.md.");
      assertToolCall(events, (event) => event.toolName.includes("__connect"), "Agent did not connect the bundled MCP server.");
      assertToolCall(events, (event) => event.toolName.includes("__echo"), "Agent did not call the bundled Everything MCP echo tool.");
      const answer = lastAssistantText(events);
      assert(answer.includes("BUNDLE_CONTROL_OK"), `Agent did not finish with expected bundle marker. Answer=${answer}`);
      assert(answer.includes("BUNDLE_CONTROL_TOOL_OK"), `Agent did not include bundled MCP echo text. Answer=${answer}`);
      return `installed Design Reference Bundle via Web Console; agent used skill and Everything MCP`;
    });

    await runScenario(report, "natural-language-install-everything-and-call-real-mcp", async () => {
      const session = api.createSession("Extension E2E natural language MCP", { projectId: project.id });
      autoResponses.set(session.id, "allow_once");
      api.appendUserMessage(
        session.id,
        [
          "This is a release gate for ForgeAgent extensions.",
          "Use the extension tools, not bash and not npm directly.",
          "Call extension_search for @modelcontextprotocol/server-everything. Then call extension_install with the npm install_input even if Everything already appears installed.",
          "Enable it. After enabling, call the MCP connect tool that becomes available.",
          "Then call the Everything MCP echo tool with text EXTENSION_NL_TOOL_OK.",
          "When the echo result is visible, answer with exactly the prefix EXTENSION_NL_OK and include the echoed text.",
        ].join(" "),
        { source: DEVICE_SOURCE },
      );
      await waitForSessionStatus(api, session.id, ["idle"]);
      autoResponses.delete(session.id);
      const events = api.getThread(session.id);
      assertToolPairs(events);
      assert(events.some((event) => event.type === "tool_call" && event.toolName === "extension_search"), `Agent did not use extension_search. Thread=${events.map((e) => e.type).join(" -> ")}`);
      assert(events.some((event) => event.type === "tool_call" && event.toolName === "extension_install"), "Agent did not use extension_install.");
      assert(events.some((event) => (
        event.type === "tool_call" &&
        (
          event.toolName === "extension_enable" ||
          (event.toolName === "extension_install" && hasEnableTrue(event.args))
        )
      )), "Agent did not enable the MCP extension via extension_enable or extension_install enable=true.");
      assert(events.some((event) => event.type === "tool_call" && event.toolName.includes("__connect")), "Agent did not connect the installed MCP server.");
      assert(events.some((event) => event.type === "tool_call" && event.toolName.includes("__echo")), "Agent did not call the installed MCP echo tool.");
      const answer = lastAssistantText(events);
      assert(answer.includes("EXTENSION_NL_OK"), `Agent did not finish with expected marker. Answer=${answer}`);
      assert(answer.includes("EXTENSION_NL_TOOL_OK"), `Agent did not include echo text. Answer=${answer}`);
      return `agent installed and used Everything MCP in ${events.length} thread events`;
    });

    await runScenario(report, "natural-language-install-github-skill-and-agent-uses-it", async () => {
      const session = api.createSession("Extension E2E natural language skill", { projectId: project.id });
      autoResponses.set(session.id, "allow_once");
      api.appendUserMessage(
        session.id,
        [
          "This is a release gate for natural-language skill installation.",
          "Use extension_search with this link, then extension_install with the returned install_input:",
          FRONTEND_DESIGN_SKILL_URL,
          "After extension_install returns, read the installed skill's SKILL.md using the skill_location from the tool result.",
          "Apply the skill to this UI request: make a composer less visually noisy while preserving clear primary action.",
          "Finish with prefix SKILL_NL_OK and include one concrete design recommendation.",
        ].join(" "),
        { source: DEVICE_SOURCE },
      );
      await waitForSessionStatus(api, session.id, ["idle"]);
      autoResponses.delete(session.id);
      const events = api.getThread(session.id);
      assertToolPairs(events);
      assertToolCall(events, (event) => event.toolName === "extension_search", "Agent did not search for the GitHub skill link.");
      assertToolCall(events, (event) => event.toolName === "extension_install", "Agent did not install the GitHub skill via extension_install.");
      assertToolCall(events, (event) => event.toolName === "read_file" && serialize(event.args).includes("frontend-design"), "Agent did not read the installed frontend-design SKILL.md.");
      assertToolResult(events, (event) => event.toolName === "read_file" && !event.isError && serialize(event.result).includes("# Frontend Design"), "Agent read_file did not successfully return frontend-design SKILL.md after natural-language install.");
      const answer = lastAssistantText(events);
      assert(answer.includes("SKILL_NL_OK"), `Agent did not finish with expected natural skill marker. Answer=${answer}`);
      return `agent installed and used GitHub skill in ${events.length} thread events`;
    });

    await runScenario(report, "natural-language-install-serenity-root-skill-and-analyze-a-share", async () => {
      const session = api.createSession("Extension E2E serenity A-share skill", { projectId: project.id });
      autoResponses.set(session.id, "allow_once");
      api.appendUserMessage(
        session.id,
        [
          "这是 ForgeAgent 发布验收：请像普通用户一样完成这个请求：",
          `帮我安装 leileqiTHU/serenity-invest-skill 这个 skill：${SERENITY_INVEST_SKILL_URL}`,
          "安装必须通过 extension_search 和 extension_install，不要用 bash/git/curl 手动安装。",
          "安装后必须使用 read_file 读取已安装 skill_location 指向的 SKILL.md。",
          "然后调用这个 skill 的框架分析 A 股市场：不需要实时行情或个股价格，不构成投资建议；请基于 supply-chain bottleneck / 上游瓶颈框架，给出 3 个 A 股可研究方向、每个方向的瓶颈节点、A 股公司类型、验证证据和反证信号。",
          "最后用前缀 SERENITY_A_SHARE_OK 开头。",
        ].join(" "),
        { source: DEVICE_SOURCE },
      );
      await waitForSessionStatus(api, session.id, ["idle"]);
      autoResponses.delete(session.id);
      const events = api.getThread(session.id);
      assertToolPairs(events);
      assertToolCall(events, (event) => event.toolName === "extension_search", "Agent did not search for serenity-invest-skill.");
      assertToolCall(events, (event) => event.toolName === "extension_install", "Agent did not install serenity-invest-skill.");
      assertToolCall(events, (event) => event.toolName === "read_file" && serialize(event.args).includes("serenity-invest-skill"), "Agent did not read the installed serenity-invest-skill SKILL.md.");
      assertToolResult(events, (event) => (
        event.toolName === "read_file" &&
        !event.isError &&
        serialize(event.result).includes("# Serenity Invest Skill")
      ), "Agent read_file did not successfully return serenity-invest-skill SKILL.md.");
      const answer = lastAssistantText(events);
      assert(answer.includes("SERENITY_A_SHARE_OK"), `Agent did not finish with expected serenity marker. Answer=${answer}`);
      assert(/A\s*股|A-share/i.test(answer), `Agent answer did not analyze A-share market. Answer=${answer}`);
      assert(/瓶颈|bottleneck|供应链|supply-chain/i.test(answer), `Agent answer did not apply the bottleneck skill framework. Answer=${answer}`);
      return `agent installed serenity repo-root skill and analyzed A-share market in ${events.length} thread events`;
    });

    await runScenario(report, "natural-language-install-bundle-and-agent-uses-components", async () => {
      const session = api.createSession("Extension E2E natural language bundle", { projectId: project.id });
      autoResponses.set(session.id, "allow_once");
      api.appendUserMessage(
        session.id,
        [
          "This is a release gate for natural-language bundle installation.",
          "Use extension_search for 'code review workspace bundle', then call extension_install with the bundle install_input even if related items already appear installed.",
          "After installing, use the code-reviewer skill by reading its SKILL.md.",
          "Then connect to the Filesystem MCP server.",
          "You must use Filesystem MCP tools for the workspace file; do not use the built-in write_file or read_file for that file.",
          "Use mcp__Filesystem__write_file to write bundle-natural-language.txt in the project workspace with content BUNDLE_NL_TOOL_OK, then use the Filesystem MCP text-read tool (mcp__Filesystem__read_file or mcp__Filesystem__read_text_file, whichever the connected server exposes) to read it back.",
          "Finish with prefix BUNDLE_NL_OK and include the file content you read.",
        ].join(" "),
        { source: DEVICE_SOURCE },
      );
      await waitForSessionStatus(api, session.id, ["idle"]);
      autoResponses.delete(session.id);
      const events = api.getThread(session.id);
      assertToolPairs(events);
      assertToolCall(events, (event) => event.toolName === "extension_search", "Agent did not search for the bundle.");
      assertToolCall(events, (event) => event.toolName === "extension_install", "Agent did not install the bundle.");
      assertToolCall(events, (event) => event.toolName === "read_file" && serialize(event.args).includes("code-reviewer"), "Agent did not read the bundled code-reviewer SKILL.md.");
      assertToolResult(events, (event) => event.toolName === "read_file" && !event.isError && serialize(event.result).includes("# Code Reviewer"), "Agent read_file did not successfully return bundled code-reviewer SKILL.md.");
      assertToolCall(events, (event) => event.toolName.includes("__connect"), "Agent did not connect an MCP server after bundle install.");
      assertToolCall(events, (event) => event.toolName === "mcp__Filesystem__write_file", "Agent did not use bundled Filesystem MCP write_file.");
      assertToolCall(events, (event) => event.toolName === "mcp__Filesystem__read_file" || event.toolName === "mcp__Filesystem__read_text_file", "Agent did not use bundled Filesystem MCP read tool.");
      assertToolResult(events, (event) => (
        (event.toolName === "mcp__Filesystem__read_file" || event.toolName === "mcp__Filesystem__read_text_file") &&
        !event.isError &&
        serialize(event.result).includes("BUNDLE_NL_TOOL_OK")
      ), "Bundled Filesystem MCP read tool did not return the written content.");
      const answer = lastAssistantText(events);
      assert(answer.includes("BUNDLE_NL_OK"), `Agent did not finish with expected natural bundle marker. Answer=${answer}`);
      assert(answer.includes("BUNDLE_NL_TOOL_OK"), `Agent did not include bundled file content. Answer=${answer}`);
      return `agent installed and used bundle in ${events.length} thread events`;
    });
  } finally {
    await browser.close().catch(() => undefined);
    gateway.destroy();
    await closeServer(server).catch(() => undefined);
    await api.shutdown({ waitMs: 1_000 }).catch(() => undefined);
  }

  const reportPath = join(REPORT_DIR, `extension-e2e-${Date.now()}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const failed = report.scenarios.filter((scenario) => !scenario.ok);
  console.log(`report=${reportPath}`);
  for (const scenario of report.scenarios) {
    console.log(`${scenario.ok ? "PASS" : "FAIL"} ${scenario.name} (${scenario.durationMs}ms): ${scenario.detail.split("\n")[0]}`);
  }
  if (failed.length > 0) {
    throw new Error(`Extension E2E failed: ${failed.map((scenario) => scenario.name).join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
