import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreAPI } from "../../src/core/core-api.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { HttpGateway } from "../../src/gateways/http/http-gateway.js";
import { createHttpServer } from "../../src/gateways/http/http-server.js";
import { ProviderConfigStore, type SetupStatus } from "../../src/config/provider-config-store.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";

type ResponseData = {
  status: number;
  data: unknown;
  headers: http.IncomingHttpHeaders;
};

let root: string;
let baseUrl: string;
let server: http.Server;
let api: CoreAPI;
let gateway: HttpGateway;
let applied: SetupStatus[];

function request(method: string, path: string, body?: unknown): Promise<ResponseData> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      url,
      {
        method,
        headers: { "Content-Type": "application/json" },
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
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe("HTTP product UI contract", () => {
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "forgeagent-product-ui-"));
    const uiDir = join(root, "ui");
    mkdirSync(join(uiDir, "assets"), { recursive: true });
    writeFileSync(join(uiDir, "index.html"), "<!doctype html><div id=\"root\">ForgeAgent UI</div>", "utf-8");
    writeFileSync(join(uiDir, "assets", "app.js"), "console.log('ok')", "utf-8");

    applied = [];
    api = new CoreAPI(new ToolRegistry(), { dataDir: join(root, "data") });
    api.initMemoryManager({ autoRun: false });
    api.initSkillEcosystem({ autoRun: false });
    gateway = new HttpGateway(api);
    server = createHttpServer(api, gateway, {
      authMode: "disabled",
      enableUi: true,
      uiDir,
      discovery: { dataDir: join(root, "data") },
      providerConfigStore: new ProviderConfigStore(join(root, "data", "config")),
      applyProviderConfig: (status) => {
        applied.push(status);
      },
      testProviderConfig: vi.fn(async () => ({ ok: true, message: "Provider test succeeded." })),
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
    rmSync(root, { recursive: true, force: true });
  });

  it("serves the built UI without taking over API routes", async () => {
    const rootResponse = await request("GET", "/");
    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers["content-type"]).toContain("text/html");
    expect(String(rootResponse.data)).toContain("ForgeAgent UI");

    const apiPriority = await request("GET", "/sessions/local-preview");
    expect(apiPriority.status).toBe(404);
    expect(apiPriority.headers["content-type"]).toContain("application/json");

    const unknownApi = await request("GET", "/extensions/not-a-real-route");
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.headers["content-type"]).toContain("application/json");
    expect(unknownApi.data).toMatchObject({ error: "Unknown ForgeAgent API route." });

    const spaFallback = await request("GET", "/console/session/local-preview");
    expect(spaFallback.status).toBe(200);
    expect(String(spaFallback.data)).toContain("ForgeAgent UI");

    const asset = await request("GET", "/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");

    const traversal = await request("GET", "/..%2Fpackage.json");
    expect(traversal.status).toBe(404);

    const health = await request("GET", "/health");
    expect(health.status).toBe(200);
    expect(health.data).toMatchObject({ app: "ForgeAgent" });
  });

  it("saves provider setup with masked status and no diagnostic secret leak", async () => {
    const secret = "sk-test-secret-1234567890";
    const saved = await request("POST", "/setup/provider", {
      apiKey: secret,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-test",
      contextWindowTokens: 123456,
    });
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({
      provider: {
        configured: true,
        source: "local_config",
        apiKeyMasked: "sk-t••••7890",
        model: "deepseek-test",
        contextWindowTokens: 123456,
      },
    });
    expect(applied).toHaveLength(1);

    const status = await request("GET", "/setup/status");
    expect(JSON.stringify(status.data)).not.toContain(secret);

    const diagnostics = await request("GET", "/diagnostics");
    expect(diagnostics.status).toBe(200);
    expect(JSON.stringify(diagnostics.data)).not.toContain(secret);
  });

  it("tests provider config through the injectable tester", async () => {
    const tested = await request("POST", "/setup/provider/test", {
      apiKey: "sk-test",
      model: "deepseek-test",
    });
    expect(tested.status).toBe(200);
    expect(tested.data).toEqual({ ok: true, message: "Provider test succeeded." });
  });

  it("renames sessions through the product session update route", async () => {
    const created = await request("POST", "/sessions", { title: "New session" });
    expect(created.status).toBe(201);
    const id = (created.data as { id: string }).id;

    const renamed = await request("PATCH", `/sessions/${id}`, { title: "Readable title" });

    expect(renamed.status).toBe(200);
    expect(renamed.data).toMatchObject({ id, title: "Readable title" });
  });

  it("lists and reads session artifacts through authenticated product routes", async () => {
    const session = api.createSession("artifacts");
    const store = new ArtifactStore(join(root, "data", "artifacts"));
    const info = store.store(session.id, "artifact body", "text/plain");

    const list = await request("GET", `/sessions/${session.id}/artifacts`);
    expect(list.status).toBe(200);
    expect(list.data).toMatchObject([{ artifactId: info.artifactId, sessionId: session.id }]);

    const artifact = await request("GET", `/artifacts/${info.artifactId}?offset=0&limit=8`);
    expect(artifact.status).toBe(200);
    expect(artifact.data).toMatchObject({
      encoding: "utf8",
      content: "artifact",
      truncated: true,
    });
  });
});
