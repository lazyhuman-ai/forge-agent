import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpRuntimeManager } from "../src/mcp/runtime-manager.js";
import { McpConfigStore } from "../src/mcp/config-store.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { SessionEvent, SystemEvent } from "../src/streams/event-types.js";

const ROOTS: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(process.cwd(), "tests", "tmp", prefix));
  ROOTS.push(root);
  return root;
}

function writeMockServer(root: string): string {
  const path = join(root, "mock-mcp-server.mjs");
  writeFileSync(path, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mock", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "fail",
      description: "Return an MCP tool error",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "fail") {
    return { isError: true, content: [{ type: "text", text: "mock failure detail" }] };
  }
  return { content: [{ type: "text", text: "echo:" + request.params.arguments.text }] };
});

await server.connect(new StdioServerTransport());
`, "utf-8");
  return path;
}

function createManager(root: string, registry = new ToolRegistry()): McpRuntimeManager {
  let seq = 1;
  const events: SessionEvent[] = [];
  const systemEvents: SystemEvent[] = [];
  return new McpRuntimeManager({
    rootDir: join(root, ".forge", "mcp"),
    projectRoot: root,
    registry,
    modelProvider: () => undefined,
    nextSeq: () => seq++,
    now: () => new Date(0).toISOString(),
    appendSessionEvent: (_sessionId, event) => events.push(event),
    appendSystemEvent: (event) => systemEvents.push(event),
    keepaliveMs: 0x7fffffff,
  });
}

afterEach(() => {
  for (const root of ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("McpRuntimeManager", () => {
  it("exposes built-in MCP catalog entries for product discovery", () => {
    const root = tempRoot("mcp-catalog-");
    const store = new McpConfigStore({
      rootDir: join(root, ".forge", "mcp"),
      projectRoot: root,
      nextSeq: () => 1,
      now: () => new Date(0).toISOString(),
    });

    expect(store.listCatalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "modelcontextprotocol-filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "{{projectRoot}}"],
        trust: "trusted",
      }),
      expect.objectContaining({
        id: "modelcontextprotocol-everything",
        command: "npx",
        trust: "trusted",
      }),
    ]));
  });

  it("resolves built-in catalog projectRoot placeholders when installing", async () => {
    const root = tempRoot("mcp-catalog-install-");
    const registry = new ToolRegistry();
    const manager = createManager(root, registry);

    const server = await manager.installCatalogEntry("modelcontextprotocol-filesystem");

    expect(server.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", root]);
  });

  it("discovers project .mcp.json as disabled untrusted project servers", () => {
    const root = tempRoot("mcp-config-");
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        localFs: {
          command: "node",
          args: ["server.js"],
        },
      },
    }), "utf-8");

    const store = new McpConfigStore({
      rootDir: join(root, ".forge", "mcp"),
      projectRoot: root,
      nextSeq: () => 1,
      now: () => new Date(0).toISOString(),
    });

    expect(store.listServers()).toEqual([
      expect.objectContaining({
        name: "localFs",
        enabled: false,
        trust: "untrusted",
        source: "project",
        sourcePath: join(root, ".mcp.json"),
      }),
    ]);
  });

  it("connects a real stdio MCP server and projects tools into Forge registry", async () => {
    const root = tempRoot("mcp-runtime-");
    const script = writeMockServer(root);
    const registry = new ToolRegistry();
    const manager = createManager(root, registry);
    manager.addServer({
      name: "mock",
      enabled: true,
      transport: "stdio",
      launchMode: "eager",
      trust: "trusted",
      command: process.execPath,
      args: [script],
      timeoutMs: 5_000,
      connectTimeoutMs: 5_000,
    });

    await manager.start();
    const status = manager.getStatus();
    expect(status.connected).toBe(1);
    expect(status.tools).toBeGreaterThanOrEqual(2);

    const echo = registry.get("mcp__mock__echo");
    expect(echo).toBeDefined();
    expect(echo?.source).toEqual({ kind: "mcp", serverId: "mock", originalName: "echo" });
    expect(echo?.isReadOnly).toBe(true);

    const result = await echo!.handler({ text: "hello" }, "session-1");
    expect(result).toEqual({ output: "echo:hello", isError: false });

    const fail = registry.get("mcp__mock__fail");
    expect(fail?.capabilities).toContain("mcp.tool");
    const failed = await fail!.handler({}, "session-1");
    expect(failed).toMatchObject({ isError: true });
    expect(String((failed as { output: unknown }).output)).toContain("mock failure detail");

    manager.stop();
  });

  it("returns readable tool errors when lazy connection fails", async () => {
    const root = tempRoot("mcp-fail-");
    const registry = new ToolRegistry();
    const manager = createManager(root, registry);
    manager.addServer({
      name: "missing",
      enabled: true,
      transport: "stdio",
      launchMode: "lazy",
      trust: "trusted",
      command: process.execPath,
      args: [join(root, "does-not-exist.mjs")],
      timeoutMs: 500,
      connectTimeoutMs: 500,
    });

    await manager.start();
    const connect = registry.get("mcp__missing__connect");
    expect(connect).toBeDefined();
    const result = await connect!.handler({}, "session-1");
    expect(result).toMatchObject({ isError: true });
    expect(String((result as { output: unknown }).output)).toContain("MCP operation failed.");
    expect(String((result as { output: unknown }).output)).toContain("Recovery:");

    manager.stop();
  });
});
