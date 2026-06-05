import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { ToolPolicyManager } from "../src/permissions/tool-policy.js";
import { PathSandbox } from "../src/sandbox/path-sandbox.js";
import type { ToolDefinition } from "../src/tools/schemas.js";

const tool: ToolDefinition = {
  name: "bash",
  description: "Run shell",
  params: {},
  capabilities: ["process.exec"],
};

const bashTool: ToolDefinition = {
  name: "bash",
  description: "Run shell",
  params: {},
  capabilities: ["process.exec", "fs.read", "fs.write"],
};

describe("ToolPolicyManager", () => {
  it("prioritizes deny over ask over allow", () => {
    const policy = new ToolPolicyManager({
      rules: [
        { id: "allow-bash", decision: "allow", toolName: "bash", reason: "allowed" },
        { id: "ask-exec", decision: "ask", capability: "process.exec", reason: "ask first" },
        { id: "deny-rm", decision: "deny", subjectIncludes: "rm -rf", reason: "destructive command" },
      ],
    });

    const decision = policy.evaluate({
      sessionId: "s1",
      tool,
      args: { command: "rm -rf build" },
    });

    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("destructive command");
  });

  it("asks for sensitive read paths even though normal reads are allowed", () => {
    const policy = new ToolPolicyManager();
    const decision = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "read_file",
        description: "Read",
        params: {},
        capabilities: ["fs.read"],
      },
      args: { file_path: ".env" },
    });

    expect(decision.decision).toBe("ask");
    expect(decision.reason).toContain("sensitive");
  });

  it("allows pure fs.write tools inside allowed workspace roots by default", () => {
    const policy = new ToolPolicyManager();
    const decision = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "write_file",
        description: "Write",
        params: {},
        capabilities: ["fs.write"],
      },
      args: { file_path: resolve("src/generated.ts") },
      pathSandbox: new PathSandbox({ projectRoot: resolve(".") }),
    });

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain("workspace roots");
  });

  it("still asks for pure fs.write tools outside allowed workspace roots", () => {
    const policy = new ToolPolicyManager();
    const decision = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "write_file",
        description: "Write",
        params: {},
        capabilities: ["fs.write"],
      },
      args: { file_path: "/tmp/forge-policy-outside.txt" },
      pathSandbox: new PathSandbox({ projectRoot: resolve(".") }),
    });

    expect(decision.decision).toBe("ask");
  });

  it("allows common read-only bash inspection commands inside the workspace", () => {
    const policy = new ToolPolicyManager();
    const pathSandbox = new PathSandbox({ projectRoot: resolve(".") });

    for (const command of [
      "pwd",
      "ls -la src",
      "cd src && find . -maxdepth 2 -type f | head -n 20",
      "rg \"ToolPolicyManager\" src tests",
      "git status --short",
      "git diff -- src/permissions/tool-policy.ts",
    ]) {
      const decision = policy.evaluate({
        sessionId: "s1",
        tool: bashTool,
        args: { command },
        pathSandbox,
      });

      expect(decision.decision, command).toBe("allow");
    }
  });

  it("still asks for bash commands that can write, escape, or run unclassified work", () => {
    const policy = new ToolPolicyManager();
    const pathSandbox = new PathSandbox({ projectRoot: resolve(".") });

    for (const command of [
      "find . -name '*.ts' -delete",
      "ls src > files.txt",
      "cd /tmp && ls",
      "npm test",
      "git checkout main",
      "ls $(pwd)",
    ]) {
      const decision = policy.evaluate({
        sessionId: "s1",
        tool: bashTool,
        args: { command },
        pathSandbox,
      });

      expect(decision.decision, command).toBe("ask");
    }
  });

  it("dangerous free mode bypasses approval prompts but not explicit deny rules", () => {
    const policy = new ToolPolicyManager({
      rules: [
        { id: "deny-rm", decision: "deny", subjectIncludes: "rm -rf /", reason: "blocked" },
        { id: "ask-exec", decision: "ask", capability: "process.exec", reason: "ask first" },
      ],
    });
    policy.setDangerouslyAllowAllTools("s1", true);

    const allowed = policy.evaluate({
      sessionId: "s1",
      tool,
      args: { command: "npm test" },
    });
    expect(allowed.decision).toBe("allow");
    expect(allowed.reason).toContain("Dangerous free mode");

    const denied = policy.evaluate({
      sessionId: "s1",
      tool,
      args: { command: "rm -rf /" },
    });
    expect(denied.decision).toBe("deny");
  });
});
