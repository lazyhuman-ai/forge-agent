import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CoreAPI } from "../../src/core/core-api.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { AuthStore } from "../../src/auth/auth-store.js";
import { HttpGateway } from "../../src/gateways/http/http-gateway.js";
import { createHttpServer } from "../../src/gateways/http/http-server.js";
import type { ModelProvider, ModelResponse, ModelMessage } from "../../src/agent/model-provider.js";

const DATA_DIR = ".forge-test-http-auth";

function makeProvider(responses: ModelResponse[]): ModelProvider {
  let i = 0;
  return {
    generate: vi.fn().mockImplementation(async (_msgs: ModelMessage[]) => {
      const r = responses[i] ?? { text: `response ${i}`, finishReason: "stop" as const };
      i++;
      return r;
    }),
  };
}

type ResponseData = {
  status: number;
  data: unknown;
  headers: http.IncomingHttpHeaders;
};

let baseUrl: string;
let server: http.Server;
let api: CoreAPI;
let gateway: HttpGateway;
let authStore: AuthStore;
let registry: ToolRegistry;

function request(
  method: string,
  path: string,
  options?: {
    body?: unknown;
    token?: string;
    origin?: string;
    rawBody?: string | Buffer;
    headers?: Record<string, string>;
  },
): Promise<ResponseData> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyRaw = options?.rawBody ?? (options?.body ? JSON.stringify(options.body) : undefined);
    const headers: Record<string, string> = { ...(options?.headers ?? {}) };
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (options?.token) headers["Authorization"] = `Bearer ${options.token}`;
    if (options?.origin) headers["Origin"] = options.origin;
    const req = http.request(
      url,
      {
        method,
        headers,
        timeout: 5000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, data: raw ? JSON.parse(raw) : null, headers: res.headers });
          } catch {
            resolve({ status: res.statusCode!, data: raw, headers: res.headers });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    if (bodyRaw) req.write(bodyRaw);
    req.end();
  });
}

function multipartBody(files: Array<{ field: string; filename: string; contentType: string; content: string | Buffer }>): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `forge-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(Buffer.from([
      `--${boundary}`,
      `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"`,
      `Content-Type: ${file.contentType}`,
      "",
      "",
    ].join("\r\n")));
    chunks.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function pairDevice(name = "Pixel 9"): Promise<{ token: string; deviceId: string }> {
  const code = authStore.issuePairingCode();
  const paired = await request("POST", "/auth/pair", {
    body: { code: code.code, name, kind: "android" },
  });
  expect(paired.status).toBe(201);
  return {
    token: (paired.data as { token: string }).token,
    deviceId: (paired.data as { device: { id: string } }).device.id,
  };
}

async function wait(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPendingPermission(token: string): Promise<{ id: string }> {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    const pending = await request("GET", "/permission-requests?status=pending", { token });
    expect(pending.status).toBe(200);
    const items = pending.data as Array<{ id: string }>;
    if (items.length > 0) return items[0]!;
    await wait(10);
  }
  throw new Error("Timed out waiting for permission request");
}

async function waitForSessionNotRunning(token: string, sessionId: string): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < 1500) {
    const resp = await request("GET", "/sessions", { token });
    expect(resp.status).toBe(200);
    const session = (resp.data as Array<Record<string, unknown>>).find((item) => item.id === sessionId);
    if (session && session.status !== "running") return session;
    await wait(20);
  }
  throw new Error("Timed out waiting for session to stop running");
}

describe("HTTP Gateway auth and multi-device sync", () => {
  beforeEach(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    registry = new ToolRegistry();
    api = new CoreAPI(registry, { dataDir: DATA_DIR });
    api.registerBuiltInTools();
    api.initSupervisor(2);
    api.initScheduler();
    api.initToolPolicy({ timeoutMs: 1000, projectRoot: DATA_DIR });
    api.setModelProvider(makeProvider([
      { text: "hello", finishReason: "stop" },
      { text: "second", finishReason: "stop" },
    ]));

    authStore = new AuthStore(join(DATA_DIR, "auth"));
    gateway = new HttpGateway(api);
    server = createHttpServer(api, gateway, {
      authStore,
      allowedOrigins: ["http://allowed.test"],
      maxBodyBytes: 1024,
    });
    server.listen(0);
    await once(server, "listening");
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    gateway.destroy();
    server.close();
    await once(server, "close").catch(() => undefined);
  });

  it("requires bearer auth for business APIs and accepts a paired device token", async () => {
    const unauth = await request("GET", "/sessions");
    expect(unauth.status).toBe(401);

    const { token } = await pairDevice();
    const created = await request("POST", "/sessions", {
      token,
      body: { title: "phone session" },
    });
    expect(created.status).toBe(201);

    const sessions = await request("GET", "/sessions", { token });
    expect(sessions.status).toBe(200);
    expect((sessions.data as unknown[]).length).toBe(1);
  });

  it("exposes unauthenticated health and discovery for local clients", async () => {
    const identity = await request("GET", "/identity");
    expect(identity.status).toBe(200);
    expect(identity.data).toMatchObject({
      app: "ForgeAgent",
      protocolVersion: 1,
    });
    expect((identity.data as { coreId: string }).coreId).toMatch(/^forge-core-/);
    const persisted = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf-8")) as { coreId: string };
    expect(persisted.coreId).toBe((identity.data as { coreId: string }).coreId);

    const health = await request("GET", "/health");
    expect(health.status).toBe(200);
    expect(health.data).toMatchObject({
      app: "ForgeAgent",
      status: "ready",
      auth: { mode: "device" },
      coreId: (identity.data as { coreId: string }).coreId,
    });

    const discovery = await request("GET", "/discovery", {
      origin: "chrome-extension://forgewebridge-test",
    });
    expect(discovery.status).toBe(200);
    expect(discovery.headers["access-control-allow-origin"]).toBe("chrome-extension://forgewebridge-test");
    expect(discovery.data).toMatchObject({
      app: "ForgeAgent",
      discoveryVersion: 1,
      capabilities: {
        deviceAuth: true,
        loopbackAutoPair: true,
        sseStreamTokens: true,
      },
    });
    expect((discovery.data as { endpoints: { pairingCodes: string } }).endpoints.pairingCodes).toContain("/auth/pairing-codes");
  });

  it("returns desktop identity and endpoint candidates when pairing Android", async () => {
    const identity = await request("GET", "/identity");
    const code = authStore.issuePairingCode();
    const paired = await request("POST", "/auth/pair", {
      body: { code: code.code, name: "Pixel 9", kind: "android" },
    });
    expect(paired.status).toBe(201);
    expect(paired.data).toMatchObject({
      coreId: (identity.data as { coreId: string }).coreId,
      desktopName: (identity.data as { desktopName: string }).desktopName,
      protocolVersion: 1,
    });
    expect((paired.data as { token: string }).token).toMatch(/^fa_dev_/);
    expect((paired.data as { networkUrls: { preferredUrl: string } }).networkUrls.preferredUrl).toMatch(/^http:\/\//);
  });

  it("revokes devices", async () => {
    const { token, deviceId } = await pairDevice();
    const before = await request("GET", "/sessions", { token });
    expect(before.status).toBe(200);

    const revoked = await request("DELETE", `/auth/devices/${deviceId}`, { token });
    expect(revoked.status).toBe(200);

    const after = await request("GET", "/sessions", { token });
    expect(after.status).toBe(401);
  });

  it("enforces CORS allow-list and returns allowed CORS headers", async () => {
    const denied = await request("GET", "/auth/status", { origin: "http://evil.test" });
    expect(denied.status).toBe(403);

    const allowed = await request("GET", "/auth/status", { origin: "http://allowed.test" });
    expect(allowed.status).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://allowed.test");
  });

  it("rejects oversized JSON bodies", async () => {
    const { token } = await pairDevice();
    const large = JSON.stringify({ title: "x".repeat(2000) });
    const resp = await request("POST", "/sessions", { token, rawBody: large });
    expect(resp.status).toBe(413);
  });

  it("creates pairing codes from loopback or an authenticated device", async () => {
    const loopback = await request("POST", "/auth/pairing-codes", {
      body: { baseUrl },
    });
    expect(loopback.status).toBe(201);
    expect((loopback.data as { pairingUrl: string }).pairingUrl).toContain("forgeagent://pair");

    const { token } = await pairDevice("Desktop");
    const authed = await request("POST", "/auth/pairing-codes", {
      token,
      body: { baseUrl },
    });
    expect(authed.status).toBe(201);
    expect((authed.data as { code: string }).code).toBeDefined();
  });

  it("allows a Chrome extension on loopback to auto-pair without a manual code", async () => {
    const code = await request("POST", "/auth/pairing-codes", {
      origin: "chrome-extension://forgewebridge-test",
      body: { baseUrl, ttlMs: 300_000 },
    });
    expect(code.status).toBe(201);

    const paired = await request("POST", "/auth/pair", {
      origin: "chrome-extension://forgewebridge-test",
      body: {
        code: (code.data as { code: string }).code,
        name: "ForgeWebridge Chrome",
        kind: "web",
      },
    });
    expect(paired.status).toBe(201);
    expect((paired.data as { token: string }).token).toMatch(/^fa_dev_/);
  });

  it("stores device state per authenticated device", async () => {
    const one = await pairDevice("Phone");
    const two = await pairDevice("Tablet");

    const patched = await request("PATCH", "/device-state", {
      token: one.token,
      body: {
        selectedSessionId: "s1",
        selectedBranchBySession: { s1: "main" },
        sessionReadSeq: { s1: 7 },
        mutedSessionIds: ["s2"],
        notificationSettings: { enabled: true, lastNotifiedSeq: 12 },
      },
    });
    expect(patched.status).toBe(200);

    const oneState = await request("GET", "/device-state", { token: one.token });
    expect(oneState.data).toMatchObject({
      selectedSessionId: "s1",
      selectedBranchBySession: { s1: "main" },
      sessionReadSeq: { s1: 7 },
      notificationSettings: { enabled: true, lastNotifiedSeq: 12 },
    });

    const twoState = await request("GET", "/device-state", { token: two.token });
    expect((twoState.data as { selectedSessionId?: string }).selectedSessionId).toBeUndefined();
  });

  it("projects per-device unread session state from read seq", async () => {
    const one = await pairDevice("Web One");
    const two = await pairDevice("Web Two");
    const created = await request("POST", "/sessions", { token: one.token, body: { title: "unread" } });
    const sessionId = (created.data as { id: string }).id;

    await request("POST", `/sessions/${sessionId}/messages`, { token: one.token, body: { text: "hello" } });
    const unread = await waitForSessionNotRunning(one.token, sessionId) as {
      latestSeq: number;
      latestAgentResultSeq: number;
      unread: boolean;
    };

    expect(unread.latestSeq).toBeGreaterThan(0);
    expect(unread.latestAgentResultSeq).toBeGreaterThan(0);
    expect(unread.unread).toBe(true);

    const patched = await request("PATCH", "/device-state", {
      token: one.token,
      body: { sessionReadSeq: { [sessionId]: unread.latestAgentResultSeq } },
    });
    expect(patched.status).toBe(200);

    const oneList = await request("GET", "/sessions", { token: one.token });
    const oneSession = (oneList.data as Array<{ id: string; unread: boolean }>).find((item) => item.id === sessionId)!;
    expect(oneSession.unread).toBe(false);

    const twoList = await request("GET", "/sessions", { token: two.token });
    const twoSession = (twoList.data as Array<{ id: string; unread: boolean }>).find((item) => item.id === sessionId)!;
    expect(twoSession.unread).toBe(true);
  });

  it("supports incremental thread and system event reads", async () => {
    const { token } = await pairDevice();
    const created = await request("POST", "/sessions", { token, body: { title: "sync" } });
    const sessionId = (created.data as { id: string }).id;

    await request("POST", `/sessions/${sessionId}/messages`, { token, body: { text: "hello" } });
    await wait();

    const full = await request("GET", `/sessions/${sessionId}/thread`, { token });
    const events = full.data as Array<{ seq: number; type: string }>;
    expect(events.length).toBeGreaterThan(0);

    const afterFirst = await request("GET", `/sessions/${sessionId}/thread?afterSeq=${events[0]!.seq}`, { token });
    const incremental = afterFirst.data as Array<{ seq: number }>;
    expect(incremental.every((event) => event.seq > events[0]!.seq)).toBe(true);

    const system = await request("GET", "/system-events?afterSeq=0", { token });
    expect(system.status).toBe(200);
    expect(Array.isArray(system.data)).toBe(true);
  });

  it("creates same-session message variants and serves branch-specific thread views", async () => {
    const { token } = await pairDevice("Web");
    const created = await request("POST", "/sessions", { token, body: { title: "branch sync" } });
    const sessionId = (created.data as { id: string }).id;

    await request("POST", `/sessions/${sessionId}/messages`, { token, body: { text: "original prompt" } });
    await waitForSessionNotRunning(token, sessionId);
    const mainThread = await request("GET", `/sessions/${sessionId}/thread?branchId=main`, { token });
    const source = (mainThread.data as Array<{ seq: number; type: string; text?: string }>).find((event) => event.type === "user_message")!;

    const createdVariant = await request("POST", `/sessions/${sessionId}/messages/${source.seq}/variants`, {
      token,
      body: { replacementText: "edited prompt" },
    });
    expect(createdVariant.status).toBe(202);
    const activeBranchId = (createdVariant.data as { activeBranchId: string }).activeBranchId;
    expect(activeBranchId).not.toBe("main");
    await waitForSessionNotRunning(token, sessionId);

    const branches = await request("GET", `/sessions/${sessionId}/branches`, { token });
    expect((branches.data as { variantGroups: Array<{ variants: unknown[] }> }).variantGroups[0]!.variants).toHaveLength(2);

    const originalView = await request("GET", `/sessions/${sessionId}/thread?branchId=main`, { token });
    expect((originalView.data as Array<{ type: string; text?: string }>)
      .filter((event) => event.type === "user_message")
      .map((event) => event.text)).toEqual(["original prompt"]);

    const editedView = await request("GET", `/sessions/${sessionId}/thread?branchId=${activeBranchId}`, { token });
    const editedEvents = editedView.data as Array<{ type: string; text?: string }>;
    expect(editedEvents.map((event) => event.type)).toContain("branch_event");
    expect(editedEvents
      .filter((event) => event.type === "user_message")
      .map((event) => event.text)).toEqual(["edited prompt"]);

    await request("PATCH", "/device-state", {
      token,
      body: { selectedBranchBySession: { [sessionId]: "main" } },
    });
    const defaultView = await request("GET", `/sessions/${sessionId}/thread`, { token });
    expect((defaultView.data as Array<{ type: string; text?: string }>)
      .filter((event) => event.type === "user_message")
      .map((event) => event.text)).toEqual(["original prompt"]);
  });

  it("previews only workspace html files", async () => {
    const { token } = await pairDevice();
    mkdirSync(DATA_DIR, { recursive: true });
    const htmlPath = resolve(DATA_DIR, "preview.html");
    const textPath = resolve(DATA_DIR, "preview.txt");
    writeFileSync(htmlPath, "<!doctype html><h1>Hello</h1>", "utf-8");
    writeFileSync(textPath, "not html", "utf-8");

    const ok = await request("GET", `/files/preview?path=${encodeURIComponent(htmlPath)}`, { token });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({
      path: htmlPath,
      content: "<!doctype html><h1>Hello</h1>",
      truncated: false,
    });

    const nonHtml = await request("GET", `/files/preview?path=${encodeURIComponent(textPath)}`, { token });
    expect(nonHtml.status).toBe(400);
    expect((nonHtml.data as { error: string }).error).toContain("Only .html and .htm");

    const outside = await request("GET", `/files/preview?path=${encodeURIComponent("/tmp/outside.html")}`, { token });
    expect(outside.status).toBe(400);
    expect((outside.data as { error: string }).error).toContain("outside the allowed workspace");
  });

  it("exposes pending permission requests and accepts device responses", async () => {
    registry.register({
      name: "writer",
      description: "Writes",
      params: {},
      capabilities: ["fs.write"],
      handler: async () => "approved write",
    });
    api.setModelProvider(makeProvider([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "tc1", name: "writer", args: {} }] },
      { text: "done", finishReason: "stop" },
    ]));

    const { token } = await pairDevice();
    const created = await request("POST", "/sessions", { token, body: { title: "perm" } });
    const sessionId = (created.data as { id: string }).id;

    const posted = await request("POST", `/sessions/${sessionId}/messages`, {
      token,
      body: { text: "write" },
    });
    expect(posted.status).toBe(202);

    const pending = await waitForPendingPermission(token);
    const response = await request("POST", `/permission-requests/${pending.id}/respond`, {
      token,
      body: { decision: "allow_once" },
    });
    expect(response.status).toBe(200);

    await wait(100);
    const thread = await request("GET", `/sessions/${sessionId}/thread`, { token });
    const events = thread.data as Array<{ type: string; result?: unknown }>;
    expect(events.some((event) => event.type === "permission_request")).toBe(true);
    expect(events.some((event) => event.type === "permission_response")).toBe(true);
    expect(events.some((event) => event.type === "tool_result" && event.result === "approved write")).toBe(true);
  });

  it("enables dangerous free mode for the session and approves pending tool requests", async () => {
    registry.register({
      name: "writer",
      description: "Writes",
      params: {},
      capabilities: ["fs.write"],
      handler: async () => "approved by dangerous mode",
    });
    api.setModelProvider(makeProvider([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "tc-danger", name: "writer", args: {} }] },
      { text: "done", finishReason: "stop" },
    ]));

    const { token } = await pairDevice();
    const created = await request("POST", "/sessions", { token, body: { title: "danger mode" } });
    const sessionId = (created.data as { id: string }).id;
    await request("POST", `/sessions/${sessionId}/messages`, {
      token,
      body: { text: "write without waiting forever" },
    });

    const pending = await waitForPendingPermission(token);
    expect(pending.id).toBeTruthy();
    const enabled = await request("PATCH", `/sessions/${sessionId}`, {
      token,
      body: { dangerouslyAllowAllTools: true },
    });
    expect(enabled.status).toBe(200);
    expect((enabled.data as { dangerouslyAllowAllTools: boolean }).dangerouslyAllowAllTools).toBe(true);

    await wait(120);
    const afterPending = await request("GET", "/permission-requests?status=pending", { token });
    expect(afterPending.status).toBe(200);
    expect(afterPending.data).toEqual([]);

    const thread = await request("GET", `/sessions/${sessionId}/thread`, { token });
    const events = thread.data as Array<{ type: string; detail?: string; decision?: string; result?: unknown }>;
    expect(events.some((event) => event.type === "runtime_event" && event.detail === "permission_mode")).toBe(true);
    expect(events.some((event) => event.type === "permission_response" && event.decision === "allow_session")).toBe(true);
    expect(events.some((event) => event.type === "tool_result" && event.result === "approved by dangerous mode")).toBe(true);
  });

  it("uploads files into the session workspace", async () => {
    const { token } = await pairDevice();
    const created = await request("POST", "/sessions", { token, body: { title: "upload" } });
    const sessionId = (created.data as { id: string }).id;
    const multipart = multipartBody([
      {
        field: "files",
        filename: "notes.txt",
        contentType: "text/plain",
        content: "hello uploaded file",
      },
    ]);

    const uploaded = await request("POST", `/sessions/${sessionId}/uploads`, {
      token,
      rawBody: multipart.body,
      headers: { "Content-Type": multipart.contentType },
    });

    expect(uploaded.status).toBe(201);
    const file = (uploaded.data as { files: Array<{ name: string; path: string; sizeBytes: number; mimeType: string }> }).files[0]!;
    expect(file).toMatchObject({
      name: "notes.txt",
      sizeBytes: "hello uploaded file".length,
      mimeType: "text/plain",
    });
    expect(file.path).toContain(`workspaces/session_${sessionId}/uploads/`);
    expect(existsSync(file.path)).toBe(true);
    expect(readFileSync(file.path, "utf-8")).toBe("hello uploaded file");
  });

  it("uses one-shot stream tokens and replays missed SSE events", async () => {
    const { token } = await pairDevice();
    const created = await request("POST", "/sessions", { token, body: { title: "sse" } });
    const sessionId = (created.data as { id: string }).id;
    await request("POST", `/sessions/${sessionId}/messages`, { token, body: { text: "hello" } });
    await wait();

    const streamToken = await request("POST", "/auth/stream-token", { token });
    expect(streamToken.status).toBe(201);
    const code = (streamToken.data as { code: string }).code;

    const replay = await readSse(`/events?cursor=0&stream_token=${encodeURIComponent(code)}`, "session_event");
    expect(replay).toContain("event: session_event");

    const reused = await request("GET", `/events?stream_token=${encodeURIComponent(code)}`);
    expect(reused.status).toBe(401);
  });
});

function readSse(path: string, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, baseUrl), { method: "GET", timeout: 5000 }, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk.toString();
        if (raw.includes(`event: ${expected}`)) {
          req.destroy();
          resolve(raw);
        }
      });
      res.on("end", () => resolve(raw));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET" && expected) return;
      reject(err);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("SSE timed out")); });
    req.end();
  });
}
