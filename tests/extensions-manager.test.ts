import { describe, expect, it, vi } from "vitest";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import type { ExtensionManagerDeps } from "../src/extensions/extension-manager.js";
import type { ExtensionInstallInput } from "../src/extensions/types.js";
import type { McpCatalogEntry, McpServerConfig, McpServerStatus } from "../src/mcp/types.js";
import type { SkillManifest, SkillSource, SkillStatusSummary } from "../src/skills/types.js";

function skill(name = "research-helper"): SkillManifest {
  return {
    packageId: `${name}@1.0.0`,
    name,
    version: "1.0.0",
    description: "Reusable research workflow",
    status: "active",
    trust: "local",
    source: "local",
    sourceId: "local",
    location: `/tmp/${name}/SKILL.md`,
    directory: `/tmp/${name}`,
    updatedAt: new Date(0).toISOString(),
    tags: ["research"],
    capabilities: ["fs.read"],
  };
}

function source(): SkillSource {
  return {
    id: "local",
    kind: "local",
    name: "Local skills",
    enabled: true,
    addedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function status(): SkillStatusSummary {
  return {
    active: 1,
    disabled: 0,
    invalid: 0,
    quarantined: 0,
    generated: 0,
    total: 1,
    sources: 1,
    promptBudgetTokens: 4000,
    promptTruncated: false,
    manifestPath: "/tmp/MANIFEST.md",
  };
}

function mcpStatus(config: McpServerConfig, state: McpServerStatus["state"] = "disabled"): McpServerStatus {
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    transport: config.transport,
    launchMode: config.launchMode,
    trust: config.trust,
    state,
    tools: 0,
    resources: 0,
    resourceTemplates: 0,
    prompts: 0,
  };
}

function createDeps(): {
  deps: ExtensionManagerDeps;
  servers: McpServerConfig[];
  catalog: McpCatalogEntry[];
} {
  const skills = [skill()];
  const servers: McpServerConfig[] = [];
  const catalog: McpCatalogEntry[] = [
    {
      id: "filesystem",
      name: "Filesystem",
      description: "Read and write project files through MCP",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      trust: "trusted",
    },
  ];
  const deps: ExtensionManagerDeps = {
    listSkills: () => skills,
    getSkillStatus: status,
    listSkillSources: () => [source()],
    installSkill: vi.fn(async (input: Extract<ExtensionInstallInput, { kind: "skill" }>) => ({
      skill: skill(input.name),
    })),
    installExternalSkill: vi.fn(async (input: Extract<ExtensionInstallInput, { kind: "skill_github" }> & { skillMd: string; skillJson?: Record<string, unknown> }) => ({
      skill: skill(input.name ?? "external-skill"),
    })),
    enableSkill: vi.fn((name: string) => skill(name)),
    listMcpServers: () => servers.map((server) => mcpStatus(server)),
    listMcpTools: () => [],
    listMcpCatalog: () => catalog,
    addMcpCatalogEntry: vi.fn((entry: McpCatalogEntry) => {
      catalog.push(entry);
      return entry;
    }),
    installMcpCatalogEntry: vi.fn(async (id: string) => {
      const entry = catalog.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Unknown catalog entry: ${id}`);
      const server: McpServerConfig = {
        id,
        name: entry.name,
        enabled: false,
        transport: entry.transport,
        launchMode: "lazy",
        trust: entry.trust ?? "untrusted",
        ...(entry.command !== undefined ? { command: entry.command } : {}),
        ...(entry.args !== undefined ? { args: entry.args } : {}),
        ...(entry.url !== undefined ? { url: entry.url } : {}),
        source: "catalog",
      };
      servers.push(server);
      return server;
    }),
    addMcpServer: vi.fn((input: Omit<McpServerConfig, "id"> & { id?: string }) => {
      const server: McpServerConfig = {
        id: input.id ?? input.name.toLowerCase(),
        name: input.name,
        enabled: input.enabled,
        transport: input.transport,
        launchMode: input.launchMode,
        trust: input.trust,
        ...(input.command !== undefined ? { command: input.command } : {}),
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
      };
      servers.push(server);
      return server;
    }),
    enableMcpServer: vi.fn(async (id: string) => {
      const server = servers.find((candidate) => candidate.id === id || candidate.name === id);
      if (!server) throw new Error(`Unknown server: ${id}`);
      server.enabled = true;
      return server;
    }),
  };
  return { deps, servers, catalog };
}

function mockGitHubSkillFetch(skillMd: string, supportFiles?: Record<string, string>): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) {
      const tree = [
        { path: "skills/external-skill/SKILL.md", type: "blob", mode: "100644", size: skillMd.length },
        ...Object.entries(supportFiles ?? {}).map(([path, content]) => ({
          path: `skills/external-skill/${path}`,
          type: "blob",
          mode: "100644",
          size: content.length,
        })),
      ];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: async () => ({ tree }),
      } as Response;
    }
    const match = /\/skills\/external-skill\/(.+)$/.exec(url);
    const rel = match?.[1] ?? "SKILL.md";
    const content = rel === "SKILL.md" ? skillMd : supportFiles?.[rel] ?? "";
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode(content).buffer,
    } as Response;
  });
}

function mockRootGitHubSkillFetch(skillMd: string, supportFiles?: Record<string, string>): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) {
      const tree = [
        { path: "SKILL.md", type: "blob", mode: "100644", size: skillMd.length },
        ...Object.entries(supportFiles ?? {}).map(([path, content]) => ({
          path,
          type: "blob",
          mode: "100644",
          size: content.length,
        })),
      ];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: async () => ({ tree }),
      } as Response;
    }
    const pathname = new URL(url).pathname;
    const rel = decodeURIComponent(pathname.split("/HEAD/")[1] ?? "SKILL.md");
    const content = rel === "SKILL.md" ? skillMd : supportFiles?.[rel] ?? "";
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode(content).buffer,
    } as Response;
  });
}

describe("ExtensionManager", () => {
  it("combines installed skills with MCP catalog search results", () => {
    const { deps } = createDeps();
    const manager = new ExtensionManager(deps);

    const research = manager.search({ query: "research", includeInstalled: true });
    expect(research).toEqual([
      expect.objectContaining({
        kind: "skill",
        name: "research-helper",
        installed: true,
        enabled: true,
      }),
    ]);

    const filesystem = manager.search({ query: "filesystem" });
    expect(filesystem[0]).toEqual(expect.objectContaining({
      kind: "mcp_server",
      name: "Filesystem",
      installed: false,
      enabled: false,
    }));
  });

  it("creates npm MCP candidates without enabling them during install", async () => {
    const { deps, servers } = createDeps();
    const manager = new ExtensionManager(deps);
    const [candidate] = manager.search({ query: "@modelcontextprotocol/server-everything" });

    expect(candidate).toEqual(expect.objectContaining({
      kind: "mcp_server",
      sourceLabel: "npm",
      installed: false,
    }));

    const result = await manager.install(candidate!.installInput);
    expect(result.status).toBe("installed");
    expect(servers[0]).toEqual(expect.objectContaining({
      enabled: false,
      command: "npx",
    }));
  });

  it("installs catalog MCP entries disabled, then enables them explicitly", async () => {
    const { deps, servers } = createDeps();
    const manager = new ExtensionManager(deps);

    const installed = await manager.install({ kind: "mcp_catalog", catalogId: "filesystem" });
    expect(installed.status).toBe("installed");
    expect(servers[0]?.enabled).toBe(false);

    const [candidate] = manager.search({ query: "filesystem" });
    expect(candidate?.source).toBe("filesystem");

    const enabled = await manager.enable("mcp_server", candidate!.source);
    expect(enabled.status).toBe("active");
    expect(servers[0]?.enabled).toBe(true);
  });

  it("recognizes raw GitHub SKILL.md links as skill candidates", () => {
    const { deps } = createDeps();
    const manager = new ExtensionManager(deps);
    const [candidate] = manager.search({
      link: "https://raw.githubusercontent.com/example/repo/main/skills/code-reviewer/SKILL.md",
    });

    expect(candidate).toEqual(expect.objectContaining({
      kind: "skill",
      name: "code-reviewer",
      sourceLabel: "GitHub skill",
      installInput: expect.objectContaining({
        kind: "skill_github",
      }),
    }));
  });

  it("recognizes GitHub repository roots as complete skill package candidates", () => {
    const { deps } = createDeps();
    const manager = new ExtensionManager(deps);
    const [candidate] = manager.search({
      query: "帮我安装 https://github.com/leileqiTHU/serenity-invest-skill 这个 skill",
    });

    expect(candidate).toEqual(expect.objectContaining({
      kind: "skill",
      name: "serenity-invest-skill",
      sourceLabel: "GitHub skill",
      installInput: expect.objectContaining({
        kind: "skill_github",
        url: "https://github.com/leileqiTHU/serenity-invest-skill",
      }),
    }));
  });

  it("installs GitHub skills through the external skill dependency", async () => {
    const { deps } = createDeps();
    const manager = new ExtensionManager(deps);
    mockGitHubSkillFetch("---\nname: external-skill\ndescription: External skill\n---\n# External\n", {
      "references/guide.md": "# Guide\n",
    });

    const result = await manager.install({
      kind: "skill_github",
      url: "https://raw.githubusercontent.com/example/repo/main/skills/external-skill/SKILL.md",
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "skill",
      name: "external-skill",
      status: "active",
    }));
    expect(deps.installExternalSkill).toHaveBeenCalledWith(expect.objectContaining({
      kind: "skill_github",
      skillMd: expect.stringContaining("# External"),
      supportFiles: [expect.objectContaining({ path: "references/guide.md" })],
    }));
    vi.restoreAllMocks();
  });

  it("installs GitHub repository root skills with support files", async () => {
    const { deps } = createDeps();
    const manager = new ExtensionManager(deps);
    mockRootGitHubSkillFetch("---\nname: serenity-invest-skill\ndescription: Serenity investing\n---\n# Serenity\n", {
      ".github/workflows/validate.yml": "name: validate\n",
      "references/framework.md": "# Framework\n",
      "examples/a-share.md": "# A-share example\n",
      "scripts/screen.py": "print('screen')\n",
    });

    const result = await manager.install({
      kind: "skill_github",
      url: "https://github.com/leileqiTHU/serenity-invest-skill",
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "skill",
      status: "active",
    }));
    expect(deps.installExternalSkill).toHaveBeenCalledWith(expect.objectContaining({
      kind: "skill_github",
      skillMd: expect.stringContaining("# Serenity"),
      supportFiles: expect.arrayContaining([
        expect.objectContaining({ path: "references/framework.md" }),
        expect.objectContaining({ path: "examples/a-share.md" }),
        expect.objectContaining({ path: "scripts/screen.py" }),
      ]),
    }));
    expect(deps.installExternalSkill).not.toHaveBeenCalledWith(expect.objectContaining({
      supportFiles: expect.arrayContaining([
        expect.objectContaining({ path: ".github/workflows/validate.yml" }),
      ]),
    }));
    vi.restoreAllMocks();
  });

  it("installs built-in bundles by expanding skill and MCP items", async () => {
    const { deps, servers } = createDeps();
    const manager = new ExtensionManager(deps);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          json: async () => ({
            tree: [{ path: "skills/.curated/quality/code-reviewer/SKILL.md", type: "blob", mode: "100644", size: 70 }],
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        arrayBuffer: async () => new TextEncoder().encode("---\nname: code-reviewer\ndescription: Code review\n---\n# Code Review\n").buffer,
      } as Response;
    });
    const [candidate] = manager.search({ query: "code review workspace bundle" });

    expect(candidate).toEqual(expect.objectContaining({
      kind: "bundle",
      name: "code-review-workspace",
    }));
    const result = await manager.install(candidate!.installInput);

    expect(result).toEqual(expect.objectContaining({
      kind: "bundle",
      status: "active",
    }));
    expect(result.items).toHaveLength(2);
    expect(servers.some((server) => server.name === "Filesystem" && server.enabled)).toBe(true);
    vi.restoreAllMocks();
  });
});
