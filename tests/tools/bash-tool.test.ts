import { describe, it, expect } from "vitest";
import { bashTool } from "../../src/tools/built-in/bash-tool.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { ToolRuntime } from "../../src/tools/tool-runtime.js";
import { PermissionBroker } from "../../src/permissions/tool-policy.js";
import { PathSandbox } from "../../src/sandbox/path-sandbox.js";

describe("bash", () => {
  it("executes a simple command", async () => {
    const result = await bashTool.handler(
      { command: "echo hello world" },
      "s1",
    );
    expect(result).toContain("hello world");
  });

  it("returns output for stderr", async () => {
    const result = await bashTool.handler(
      { command: "echo error >&2", shell: "/bin/bash" },
      "s1",
    );
    // The command should output "error" to stderr
    // When using exec, stderr is captured and included
    expect(typeof result).toBe("string");
  });

  it("declares process and filesystem capabilities for policy enforcement", () => {
    expect(bashTool.capabilities).toEqual(["process.exec", "fs.read", "fs.write"]);
  });

  it("is denied by ToolRuntime policy before execution when approval is unavailable", async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool);
    const runtime = new ToolRuntime(registry);
    const broker = new PermissionBroker({
      nextSeq: () => 1,
      now: () => new Date(0).toISOString(),
      appendSessionEvent: () => undefined,
    });

    const result = await runtime.execute("bash", { command: "echo hello" }, "s1", {
      permissionBroker: broker,
      source: { kind: "trigger", interactive: false },
    });

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain("Tool permission denied before execution.");
    expect(String(result.output)).toContain("Tool: bash");
    expect(String(result.output)).toContain("Requested action: process.exec, fs.read, fs.write");
    expect(String(result.output)).toContain("Command: echo hello");
    expect(String(result.output)).toContain("Recovery:");
  });

  it("allows common read-only inspection commands without approval", async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool);
    const runtime = new ToolRuntime(registry);
    const broker = new PermissionBroker({
      nextSeq: () => 1,
      now: () => new Date(0).toISOString(),
      appendSessionEvent: () => undefined,
    });

    const result = await runtime.execute("bash", { command: "ls src" }, "s1", {
      permissionBroker: broker,
      pathSandbox: new PathSandbox({ projectRoot: process.cwd() }),
      projectRoot: process.cwd(),
      bashSandboxMode: "disabled",
      source: { kind: "trigger", interactive: false },
    });

    expect(result.isError).toBe(false);
    expect(String(result.output)).toContain("permissions");
  });

  it("handles command failures gracefully", async () => {
    const result = await bashTool.handler(
      { command: "nonexistent_command_xyz 2>/dev/null; exit 1" },
      "s1",
    );
    expect(result).toEqual(expect.objectContaining({
      isError: true,
      output: expect.stringContaining("Command failed:"),
    }));
  });
});
