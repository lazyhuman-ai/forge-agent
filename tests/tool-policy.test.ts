import { describe, it, expect } from "vitest";
import { ToolPolicyManager } from "../src/permissions/tool-policy.js";
import type { ToolDefinition } from "../src/tools/schemas.js";

const tool: ToolDefinition = {
  name: "bash",
  description: "Run shell",
  params: {},
  capabilities: ["process.exec"],
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

  it("allows workspace write tools by default while sandbox remains responsible for path boundaries", () => {
    const policy = new ToolPolicyManager();
    const decision = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "write_file",
        description: "Write",
        params: {},
        capabilities: ["fs.write"],
      },
      args: { file_path: "notes.md", content: "ok" },
    });

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain("PathSandbox");
  });

  it("allows safe shell commands but asks for package installation", () => {
    const policy = new ToolPolicyManager();

    const safe = policy.evaluate({
      sessionId: "s1",
      tool,
      args: { command: "npm run typecheck" },
    });
    expect(safe.decision).toBe("allow");

    const risky = policy.evaluate({
      sessionId: "s1",
      tool,
      args: { command: "npm install left-pad" },
    });
    expect(risky.decision).toBe("ask");
    expect(risky.reason).toContain("package installation");
  });

  it("lets agents install extension packages but asks before enabling runtime capability", () => {
    const policy = new ToolPolicyManager();

    const skillInstall = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "extension_install",
        description: "Install extension",
        params: {},
        capabilities: ["extension.install"],
      },
      args: { install_input: { kind: "skill", name: "research" } },
    });
    expect(skillInstall.decision).toBe("allow");

    const mcpInstallDisabled = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "extension_install",
        description: "Install extension",
        params: {},
        capabilities: ["extension.install"],
      },
      args: { install_input: { kind: "mcp_catalog", catalogId: "filesystem" } },
    });
    expect(mcpInstallDisabled.decision).toBe("allow");

    const mcpInstallEnabled = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "extension_install",
        description: "Install extension",
        params: {},
        capabilities: ["extension.install"],
      },
      args: { install_input: { kind: "mcp_catalog", catalogId: "filesystem", enable: true } },
    });
    expect(mcpInstallEnabled.decision).toBe("ask");

    const skillEnable = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "extension_enable",
        description: "Enable extension",
        params: {},
        capabilities: ["extension.manage"],
      },
      args: { kind: "skill", id_or_name: "research" },
    });
    expect(skillEnable.decision).toBe("allow");

    const enable = policy.evaluate({
      sessionId: "s1",
      tool: {
        name: "extension_enable",
        description: "Enable extension",
        params: {},
        capabilities: ["extension.manage"],
      },
      args: { kind: "mcp_server", id_or_name: "filesystem" },
    });
    expect(enable.decision).toBe("ask");
  });
});
