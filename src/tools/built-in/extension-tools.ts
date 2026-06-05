import type { ExtensionInstallInput } from "../../extensions/types.js";
import { buildTool } from "../schemas.js";
import { formatExtensionValue, getExtensionManagerForTools } from "./extension-shared.js";

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function objectArg(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseBundleItem(raw: unknown): Extract<ExtensionInstallInput, { kind: "bundle" }>["items"][number] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("extension_install bundle items must be objects.");
  }
  const parsed = parseInstallInput(raw as Record<string, unknown>);
  if (parsed.kind === "bundle") throw new Error("extension_install does not support nested bundles.");
  return parsed;
}

function parseInstallInput(args: Record<string, unknown>): ExtensionInstallInput {
  const raw = objectArg(args, "install_input") ?? args;
  const kind = stringArg(raw, "kind");
  if (kind === "skill") {
    const name = stringArg(raw, "name");
    if (!name) throw new Error("extension_install requires name for kind=skill.");
    const input: ExtensionInstallInput = {
      kind: "skill",
      name,
    };
    const version = stringArg(raw, "version");
    const sourceId = stringArg(raw, "sourceId");
    const registryUrl = stringArg(raw, "registryUrl");
    const trustUnsigned = boolArg(raw, "trustUnsigned");
    const force = boolArg(raw, "force");
    if (version) input.version = version;
    if (sourceId) input.sourceId = sourceId;
    if (registryUrl) input.registryUrl = registryUrl;
    if (trustUnsigned !== undefined) input.trustUnsigned = trustUnsigned;
    if (force !== undefined) input.force = force;
    return input;
  }
  if (kind === "skill_github") {
    const url = stringArg(raw, "url");
    if (!url) throw new Error("extension_install requires url for kind=skill_github.");
    const input: ExtensionInstallInput = {
      kind: "skill_github",
      url,
    };
    const name = stringArg(raw, "name");
    const version = stringArg(raw, "version");
    const force = boolArg(raw, "force");
    if (name) input.name = name;
    if (version) input.version = version;
    if (force !== undefined) input.force = force;
    return input;
  }
  if (kind === "mcp_catalog") {
    const catalogId = stringArg(raw, "catalogId") ?? stringArg(raw, "catalog_id");
    if (!catalogId) throw new Error("extension_install requires catalogId for kind=mcp_catalog.");
    const input: ExtensionInstallInput = {
      kind: "mcp_catalog",
      catalogId,
    };
    const enable = boolArg(raw, "enable");
    if (enable !== undefined) input.enable = enable;
    return input;
  }
  if (kind === "mcp_server") {
    const serverRaw = objectArg(raw, "server") ?? raw;
    const name = stringArg(serverRaw, "name");
    if (!name) throw new Error("extension_install requires name for kind=mcp_server.");
    const transport = stringArg(serverRaw, "transport");
    if (transport !== "stdio" && transport !== "streamable-http" && transport !== "sse") {
      throw new Error("extension_install mcp_server transport must be stdio, streamable-http, or sse.");
    }
    const command = stringArg(serverRaw, "command");
    const url = stringArg(serverRaw, "url");
    const argsValue = serverRaw.args;
    const serverArgs = Array.isArray(argsValue) ? argsValue.map(String) : undefined;
    const trust = stringArg(serverRaw, "trust");
    const launchMode = stringArg(serverRaw, "launchMode");
    const input: ExtensionInstallInput = {
      kind: "mcp_server",
      server: {
        name,
        enabled: false,
        transport,
        launchMode: launchMode === "eager" || launchMode === "background"
          ? launchMode
          : "lazy",
        trust: trust === "trusted" || trust === "quarantined" ? trust : "untrusted",
        ...(command ? { command } : {}),
        ...(serverArgs ? { args: serverArgs } : {}),
        ...(url ? { url } : {}),
        source: "local",
      },
    };
    const enable = boolArg(raw, "enable") ?? boolArg(serverRaw, "enable");
    if (enable !== undefined) input.enable = enable;
    return input;
  }
  if (kind === "bundle") {
    const name = stringArg(raw, "name");
    if (!name) throw new Error("extension_install requires name for kind=bundle.");
    const rawItems = raw.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new Error("extension_install requires non-empty items for kind=bundle.");
    }
    const input: ExtensionInstallInput = {
      kind: "bundle",
      name,
      items: rawItems.map(parseBundleItem),
    };
    const enable = boolArg(raw, "enable");
    if (enable !== undefined) input.enable = enable;
    return input;
  }
  throw new Error("extension_install requires kind=skill, kind=skill_github, kind=mcp_catalog, kind=mcp_server, or kind=bundle.");
}

export const extensionSearchTool = buildTool({
  name: "extension_search",
  description: [
    "Search ForgeAgent extensions: skills, MCP servers, and installable catalog entries.",
    "Use this when the user asks to install or find an extension/tool/skill/MCP server.",
    "If the user provides a link, pass it as link.",
  ].join(" "),
  params: {
    query: {
      type: "string",
      description: "Search query such as 'filesystem mcp', 'github', or a package name.",
      optional: true,
    },
    link: {
      type: "string",
      description: "Optional URL supplied by the user.",
      optional: true,
    },
    include_installed: {
      type: "boolean",
      description: "Whether to include installed extensions.",
      optional: true,
    },
  },
  handler: async (args) => {
    const manager = getExtensionManagerForTools();
    const searchInput: Parameters<typeof manager.search>[0] = {
      includeInstalled: boolArg(args, "include_installed") === true,
    };
    const query = stringArg(args, "query");
    const link = stringArg(args, "link");
    if (query) searchInput.query = query;
    if (link) searchInput.link = link;
    const candidates = manager.search(searchInput);
    if (candidates.length === 0) return "No matching ForgeAgent extensions were found.";
    return [
      `Found ${candidates.length} extension candidate(s).`,
      ...candidates.slice(0, 20).map((candidate, index) => [
        `${index + 1}. ${candidate.title}`,
        `   id: ${candidate.id}`,
        `   kind: ${candidate.kind}`,
        `   status: ${candidate.status}${candidate.enabled ? " enabled" : ""}`,
        `   source: ${candidate.sourceLabel}`,
        `   trust: ${candidate.trust}`,
        candidate.reviewState ? `   attention: ${candidate.reviewState}${candidate.reviewAction ? ` (${candidate.reviewAction})` : ""}` : "",
        candidate.setupRequired ? "   setup_required: true" : "",
        candidate.postInstall ? `   post_install: ${candidate.postInstall}` : "",
        `   risk: ${candidate.riskSummary}`,
        `   install_input: ${JSON.stringify(candidate.installInput)}`,
      ].filter(Boolean).join("\n")),
    ].join("\n\n");
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["extension.read"],
});

export const extensionStatusTool = buildTool({
  name: "extension_status",
  description: "Show installed ForgeAgent skills, MCP servers, tools, catalog, and extension health.",
  params: {},
  handler: async () => formatExtensionValue(getExtensionManagerForTools().getStatus()),
  isConcurrencySafe: true,
  isReadOnly: true,
  capabilities: ["extension.read"],
});

export const extensionInstallTool = buildTool({
  name: "extension_install",
  description: [
    "Install a ForgeAgent extension from an extension_search install_input.",
    "For MCP servers, installation configures the server but does not need to enable it unless enable=true is explicitly provided.",
    "Return errors are readable and can be used to correct the install request.",
  ].join(" "),
  params: {
    install_input: {
      type: "object",
      description: "The install_input object returned by extension_search.",
      optional: true,
      properties: {},
    },
    kind: {
      type: "string",
      description: "Fallback install kind: skill, skill_github, mcp_catalog, mcp_server, or bundle.",
      optional: true,
    },
    name: { type: "string", description: "Skill or MCP server name.", optional: true },
    catalogId: { type: "string", description: "MCP catalog id.", optional: true },
    version: { type: "string", description: "Skill version.", optional: true },
    sourceId: { type: "string", description: "Skill source id.", optional: true },
    registryUrl: { type: "string", description: "Skill registry URL.", optional: true },
    trustUnsigned: { type: "boolean", description: "Allow unsigned skill registry, installed into quarantine when needed.", optional: true },
    force: { type: "boolean", description: "Force-enable caution skill scans.", optional: true },
    transport: { type: "string", description: "MCP transport: stdio, streamable-http, or sse.", optional: true },
    command: { type: "string", description: "MCP stdio command.", optional: true },
    args: { type: "array", description: "MCP stdio args.", optional: true, items: { type: "string", description: "arg" } },
    url: { type: "string", description: "MCP HTTP/SSE URL.", optional: true },
    enable: { type: "boolean", description: "Enable after install.", optional: true },
    items: { type: "array", description: "Bundle install items.", optional: true, items: { type: "object", description: "extension install input" } },
  },
  handler: async (args) => {
    const result = await getExtensionManagerForTools().install(parseInstallInput(args));
    return [
      result.message,
      `kind: ${result.kind}`,
      `id: ${result.id}`,
      `status: ${result.status}`,
      result.skill ? `skill_location: ${result.skill.location}` : "",
      result.items?.length ? `items: ${result.items.map((item) => `${item.kind}:${item.name}:${item.status}${item.skill ? `:${item.skill.location}` : ""}`).join(", ")}` : "",
      result.scan ? `scan: ${result.scan.verdict} (${result.scan.findings.length} finding(s))` : "",
    ].filter(Boolean).join("\n");
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["extension.install"],
});

export const extensionEnableTool = buildTool({
  name: "extension_enable",
  description: "Enable an installed ForgeAgent skill, MCP server, or bundle after user intent is clear.",
  params: {
    kind: {
      type: "string",
      description: "Extension kind: skill, mcp_server, or bundle.",
    },
    id_or_name: {
      type: "string",
      description: "Skill name or MCP server id.",
    },
    version: {
      type: "string",
      description: "Optional skill version.",
      optional: true,
    },
    trust_warnings: {
      type: "boolean",
      description: "For skills with scanner warnings only, trust the warnings and enable. Blocking findings still cannot be enabled.",
      optional: true,
    },
  },
  handler: async (args) => {
    const kind = stringArg(args, "kind");
    const idOrName = stringArg(args, "id_or_name");
    if (!idOrName) throw new Error("extension_enable requires id_or_name.");
    if (kind !== "skill" && kind !== "mcp_server" && kind !== "bundle") {
      throw new Error("extension_enable kind must be skill, mcp_server, or bundle.");
    }
    const trustWarnings = boolArg(args, "trust_warnings") ?? boolArg(args, "trustWarnings");
    const result = await getExtensionManagerForTools().enable(
      kind,
      idOrName,
      stringArg(args, "version"),
      trustWarnings !== undefined ? { trustWarnings } : undefined,
    );
    return result.message;
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["extension.manage"],
});

export const extensionTools = [
  extensionSearchTool,
  extensionStatusTool,
  extensionInstallTool,
  extensionEnableTool,
];
