import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ToolRuntime } from "../src/tools/tool-runtime.js";
import { PermissionBroker } from "../src/permissions/tool-policy.js";
import { PathSandbox } from "../src/sandbox/path-sandbox.js";
import type { PermissionRequestEvent, PermissionResponseEvent } from "../src/streams/event-types.js";

describe("ToolRuntime", () => {
  let registry: ToolRegistry;
  let runtime: ToolRuntime;

  beforeEach(() => {
    registry = new ToolRegistry();
    runtime = new ToolRuntime(registry);
  });

  it("executes a registered tool and returns output", async () => {
    registry.register({
      name: "greet",
      description: "Greets",
      params: { name: { type: "string", description: "Name" } },
      handler: async (args) => `Hello, ${args.name}!`,
    });

    const result = await runtime.execute("greet", { name: "World" }, "s1");
    expect(result.isError).toBe(false);
    expect(result.output).toBe("Hello, World!");
    expect(result.toolName).toBe("greet");
  });

  it("returns error for unknown tool", async () => {
    const result = await runtime.execute("nonexistent", {}, "s1");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool");
  });

  it("returns error when handler throws", async () => {
    registry.register({
      name: "crash",
      description: "Always crashes",
      params: {},
      handler: async () => {
        throw new Error("boom");
      },
    });

    const result = await runtime.execute("crash", {}, "s1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("boom");
  });

  it("preserves structured handler errors", async () => {
    registry.register({
      name: "structured_error",
      description: "Returns a structured error",
      params: {},
      handler: async () => ({ output: "bad input", isError: true }),
    });

    const result = await runtime.execute("structured_error", {}, "s1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("bad input");
  });

  it("passes sessionId to handler", async () => {
    let receivedSid = "";

    registry.register({
      name: "track",
      description: "Tracks session",
      params: {},
      handler: async (_args, sessionId) => {
        receivedSid = sessionId;
        return "ok";
      },
    });

    await runtime.execute("track", {}, "my-session");
    expect(receivedSid).toBe("my-session");
  });

  it("handles multiple tools independently", async () => {
    registry.register({
      name: "upper",
      description: "Uppercases",
      params: { text: { type: "string", description: "Input" } },
      handler: async (args) => String(args.text).toUpperCase(),
    });

    registry.register({
      name: "len",
      description: "Length",
      params: { text: { type: "string", description: "Input" } },
      handler: async (args) => String(args.text).length,
    });

    const r1 = await runtime.execute("upper", { text: "hello" }, "s1");
    const r2 = await runtime.execute("len", { text: "hello" }, "s1");

    expect(r1.output).toBe("HELLO");
    expect(r2.output).toBe(5);
  });

  it("returns readable permission errors before executing denied tools", async () => {
    let called = false;
    const events: Array<PermissionRequestEvent | PermissionResponseEvent> = [];
    const broker = new PermissionBroker({
      timeoutMs: 50,
      nextSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      now: () => new Date(0).toISOString(),
      appendSessionEvent: (_sid, event) => events.push(event),
    });

    registry.register({
      name: "writer",
      description: "Writes",
      params: {},
      capabilities: ["fs.write"],
      handler: async () => {
        called = true;
        return "wrote";
      },
    });

    const result = await runtime.execute("writer", {}, "s1", {
      permissionBroker: broker,
      source: { kind: "trigger", interactive: false },
    });

    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain("Tool permission denied before execution.");
    expect(String(result.output)).toContain("Tool: writer");
    expect(String(result.output)).toContain("Requested action: fs.write");
    expect(String(result.output)).toContain("no interactive approval channel");
    expect(String(result.output)).toContain("Recovery:");
    expect(events.map((event) => event.type)).toEqual(["permission_request", "permission_response"]);
  });

  it("allows workspace fs.write tools without approval", async () => {
    let called = false;
    const events: Array<PermissionRequestEvent | PermissionResponseEvent> = [];
    const broker = new PermissionBroker({
      timeoutMs: 50,
      nextSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      now: () => new Date(0).toISOString(),
      appendSessionEvent: (_sid, event) => events.push(event),
    });

    registry.register({
      name: "writer",
      description: "Writes",
      params: {},
      capabilities: ["fs.write"],
      handler: async () => {
        called = true;
        return "wrote";
      },
    });

    const result = await runtime.execute(
      "writer",
      { file_path: resolve("src/generated.ts") },
      "s1",
      {
        permissionBroker: broker,
        pathSandbox: new PathSandbox({ projectRoot: resolve(".") }),
        source: { kind: "trigger", interactive: false },
      },
    );

    expect(called).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.output).toBe("wrote");
    expect(events).toEqual([]);
  });

  it("allows read-only capability tools by default policy", async () => {
    const broker = new PermissionBroker({
      nextSeq: () => 1,
      now: () => new Date(0).toISOString(),
      appendSessionEvent: () => undefined,
    });
    registry.register({
      name: "reader",
      description: "Reads",
      params: {},
      capabilities: ["fs.read"],
      handler: async () => "read",
    });

    const result = await runtime.execute("reader", {}, "s1", {
      permissionBroker: broker,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toBe("read");
  });
});
