import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { McpCatalogEntry, McpServerConfig, McpServerStatus } from "../mcp/types.js";
import type { SkillManifest, SkillPackageManifest, SkillReviewAction, SkillReviewState, SkillSource, SkillTrust } from "../skills/types.js";
import type {
  ExtensionCandidate,
  ExtensionBundleItem,
  ExtensionEventRecord,
  ExtensionKind,
  ExtensionInstallInput,
  ExtensionInstallResult,
  ExtensionRegistryEntry,
  ExtensionRegistrySource,
  ExtensionStatus,
  ExtensionTrust,
} from "./types.js";
import { CODE_REVIEWER_SKILL_URL, FRONTEND_DESIGN_SKILL_URL } from "./official-registry.js";
import type { AddExtensionRegistrySourceInput, ExtensionRegistryStore } from "./registry-store.js";

export type ExtensionManagerDeps = {
  listSkills: (filter?: { includeInactive?: boolean }) => SkillManifest[];
  getSkillStatus: () => ExtensionStatus["skills"]["status"];
  listSkillSources: () => SkillSource[];
  installSkill: (input: Extract<ExtensionInstallInput, { kind: "skill" }>) => Promise<{
    skill: SkillManifest;
    scan?: ExtensionInstallResult["scan"];
  }>;
  installExternalSkill: (input: Extract<ExtensionInstallInput, { kind: "skill_github" }> & {
    skillMd: string;
    sourceUrl: string;
    skillJson?: Partial<SkillPackageManifest>;
    supportFiles?: Array<{ path: string; content: string | Uint8Array }>;
  }) => Promise<{
    skill: SkillManifest;
    scan?: ExtensionInstallResult["scan"];
  }>;
  enableSkill: (name: string, version?: string, options?: { trustWarnings?: boolean }) => SkillManifest;
  listMcpServers: () => McpServerStatus[];
  listMcpTools: () => ExtensionStatus["mcp"]["tools"];
  listMcpCatalog: () => McpCatalogEntry[];
  addMcpCatalogEntry: (entry: McpCatalogEntry) => McpCatalogEntry;
  installMcpCatalogEntry: (id: string) => Promise<McpServerConfig>;
  addMcpServer: (server: Omit<McpServerConfig, "id"> & { id?: string }) => McpServerConfig;
  enableMcpServer: (id: string) => Promise<McpServerConfig>;
  registryStore?: ExtensionRegistryStore;
};

const githubSkillPackageCache = new Map<string, {
  sourceUrl: string;
  skillMd: string;
  skillJson?: Partial<SkillPackageManifest>;
  supportFiles: Array<{ path: string; content: Uint8Array }>;
}>();
const SKILL_PACKAGE_SUPPORT_DIRS = new Set(["references", "scripts", "templates", "assets", "tests", "examples"]);

export type ExtensionSearchOptions = {
  query?: string;
  link?: string;
  includeInstalled?: boolean;
};

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function includesNeedle(value: string | undefined, needle: string): boolean {
  if (!needle) return true;
  return (value ?? "").toLowerCase().includes(needle);
}

function extractFirstHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /https?:\/\/[^\s<>)\]]+/i.exec(value);
  return match?.[0]?.replace(/[.,;，。；、]+$/u, "");
}

function skillTrustToExtensionTrust(trust: SkillTrust): ExtensionTrust {
  if (trust === "official") return "official";
  if (trust === "project" || trust === "local" || trust === "legacy") return "local";
  if (trust === "generated") return "trusted";
  return "community";
}

function mcpTrustToExtensionTrust(trust: McpCatalogEntry["trust"] | McpServerStatus["trust"] | undefined): ExtensionTrust {
  if (trust === "trusted") return "trusted";
  if (trust === "quarantined") return "quarantined";
  if (trust === "untrusted") return "untrusted";
  return "community";
}

function skillReviewState(skill: SkillManifest): SkillReviewState {
  const scanState = skill.scanSummary?.reviewState
    ?? (skill.scanVerdict === "dangerous"
      ? "blocked"
      : skill.scanVerdict === "caution"
        ? "warning"
        : "safe");
  if (skill.status === "invalid" && scanState !== "warning") return "blocked";
  if (skill.status === "quarantined" && scanState !== "blocked") return "warning";
  return scanState;
}

function skillReviewAction(skill: SkillManifest): SkillReviewAction {
  const state = skillReviewState(skill);
  if (state === "blocked") return "fix_required";
  if (state === "warning" && skill.status !== "active") return "trust_enable";
  return "none";
}

function skillRiskSummary(skill: SkillManifest): string {
  const state = skillReviewState(skill);
  if (state === "blocked") {
    return skill.invalidReason ?? "This skill has blocking scanner findings and cannot be enabled until fixed.";
  }
  if (state === "warning") {
    return "Static scan found warnings. You can trust and enable this skill; runtime tool permissions and sandbox still apply.";
  }
  return "Skill content is exposed as readable instructions; scripts still run through normal ForgeAgent tools and permissions.";
}

function skillInstallMessage(prefix: string, skill: SkillManifest): string {
  const enabled = skill.status === "active" ? "enabled" : "installed";
  const warning = skillReviewState(skill) === "warning" ? " with scanner warnings" : "";
  return `${prefix} ${enabled}${warning}: ${skill.name} ${skill.version}`;
}

function skillCandidate(skill: SkillManifest, sourceLabel: string): ExtensionCandidate {
  const reviewState = skillReviewState(skill);
  const reviewAction = skillReviewAction(skill);
  return {
    id: `skill:${skill.packageId}`,
    kind: "skill",
    name: skill.name,
    title: skill.name,
    description: skill.description,
    source: skill.sourceId,
    sourceLabel,
    trust: skillTrustToExtensionTrust(skill.trust),
    installed: true,
    enabled: skill.status === "active",
    status: skill.status === "active"
      ? "active"
      : skill.status === "disabled"
        ? "disabled"
        : skill.status === "quarantined"
          ? "quarantined"
          : skill.status === "invalid"
            ? "invalid"
            : "installed",
    capabilities: skill.capabilities ?? [],
    riskSummary: skillRiskSummary(skill),
    installInput: {
      kind: "skill",
      name: skill.name,
      version: skill.version,
      sourceId: skill.sourceId,
    },
    metadata: {
      location: skill.location,
      directory: skill.directory,
      manifestPath: skill.manifestPath,
      version: skill.version,
      whenToUse: skill.whenToUse,
      tags: skill.tags,
      invalidReason: skill.invalidReason,
      scanVerdict: skill.scanVerdict,
      scanSummary: skill.scanSummary,
    },
    reviewState,
    reviewAction,
  };
}

function mcpServerCandidate(server: McpServerStatus): ExtensionCandidate {
  return {
    id: `mcp:${server.id}`,
    kind: "mcp_server",
    name: server.name,
    title: server.name,
    description: server.lastError ? `MCP server. Last error: ${server.lastError}` : "Configured MCP server.",
    source: server.id,
    sourceLabel: "MCP server",
    trust: mcpTrustToExtensionTrust(server.trust),
    installed: true,
    enabled: server.enabled,
    status: server.enabled ? "active" : "disabled",
    capabilities: [
      `${server.tools} tools`,
      `${server.resources} resources`,
      `${server.prompts} prompts`,
      server.transport,
    ],
    riskSummary: server.transport === "stdio"
      ? "This MCP server may launch a local process. Enable only if you trust the command and package source."
      : "This MCP server communicates over the network. Check the URL and auth before enabling.",
    installInput: {
      kind: "mcp_server",
      server: {
        name: server.name,
        enabled: false,
        transport: server.transport,
        launchMode: server.launchMode,
        trust: server.trust,
      },
    },
    metadata: {
      state: server.state,
      cacheAgeMs: server.cacheAgeMs,
      stderrTail: server.stderrTail,
    },
  };
}

function mcpCatalogCandidate(entry: McpCatalogEntry, installedServers: McpServerStatus[]): ExtensionCandidate {
  const installedServer = installedServers.find((server) => server.name === entry.name);
  const installed = installedServer !== undefined;
  const enabled = installedServer?.enabled === true;
  return {
    id: `mcp-catalog:${entry.id}`,
    kind: "mcp_server",
    name: entry.name,
    title: entry.name,
    description: entry.description ?? `MCP server from catalog: ${entry.name}`,
    source: installedServer?.id ?? entry.id,
    sourceLabel: "MCP catalog",
    trust: mcpTrustToExtensionTrust(entry.trust),
    installed,
    enabled,
    status: enabled ? "active" : installed ? "installed" : "available",
    capabilities: [entry.transport, ...(entry.command ? [`command: ${entry.command}`] : []), ...(entry.url ? [`url: ${entry.url}`] : [])],
    riskSummary: entry.transport === "stdio"
      ? "Installing this MCP entry configures a local process. It starts only after enabling."
      : "Installing this MCP entry configures a network server. It starts only after enabling.",
    installInput: {
      kind: "mcp_catalog",
      catalogId: entry.id,
    },
    metadata: {
      catalogId: entry.id,
      serverId: installedServer?.id,
      command: entry.command,
      args: entry.args,
      url: entry.url,
      packageName: entry.packageName,
      packageVersion: entry.packageVersion,
      auth: entry.auth,
      setupRequired: entry.setupRequired,
      postInstall: entry.postInstall,
    },
    ...(entry.setupRequired === true
      ? { setupRequired: true, reviewState: "setup_required" as const, reviewAction: "setup_required" as const }
      : { reviewState: "safe" as const, reviewAction: "none" as const }),
  };
}

function registryCandidate(params: {
  entry: ExtensionRegistryEntry;
  skills: SkillManifest[];
  servers: McpServerStatus[];
  catalog: McpCatalogEntry[];
  lock?: ReturnType<ExtensionRegistryStore["getLock"]>;
}): ExtensionCandidate {
  const entry = params.entry;
  const catalogId = entry.installInput.kind === "mcp_catalog" ? entry.installInput.catalogId : undefined;
  const installedServer = catalogId
    ? params.servers.find((server) => server.id === catalogId || server.name === params.catalog.find((item) => item.id === catalogId)?.name)
    : undefined;
  const skillInstallName = entry.installInput.kind === "skill" || entry.installInput.kind === "skill_github"
    ? entry.installInput.name
    : undefined;
  const installedSkill = skillInstallName !== undefined || entry.kind === "skill"
    ? params.skills.find((skill) => skill.name === entry.name || skill.name === skillInstallName)
    : undefined;
  const installed = params.lock !== undefined || installedServer !== undefined || installedSkill !== undefined;
  const enabled = params.lock?.status === "active" || installedServer?.enabled === true || installedSkill?.status === "active";
  const status: ExtensionCandidate["status"] = enabled
    ? "active"
    : installed
      ? params.lock?.status === "quarantined"
        ? "quarantined"
        : params.lock?.status === "invalid"
          ? "invalid"
          : "installed"
      : "available";
  const reviewState = entry.setupRequired === true
    ? "setup_required"
    : status === "invalid"
      ? "blocked"
      : status === "quarantined"
        ? "warning"
        : "safe";
  const reviewAction = reviewState === "setup_required"
    ? "setup_required"
    : reviewState === "blocked"
      ? "fix_required"
      : reviewState === "warning"
        ? "trust_enable"
        : "none";
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    title: entry.title,
    description: entry.description,
    source: installedServer?.id ?? installedSkill?.location ?? entry.source,
    sourceLabel: entry.sourceLabel,
    trust: entry.trust,
    installed,
    enabled,
    status,
    capabilities: entry.capabilities,
    riskSummary: entry.riskSummary,
    installInput: entry.installInput,
    metadata: {
      ...(entry.metadata ?? {}),
      version: entry.version,
      tags: entry.tags,
      provenance: entry.provenance,
      catalogId,
      mcpServerId: installedServer?.id,
      skillLocation: installedSkill?.location,
    },
    ...(entry.recommended !== undefined ? { recommended: entry.recommended } : {}),
    ...(entry.setupRequired !== undefined ? { setupRequired: entry.setupRequired } : {}),
    reviewState,
    reviewAction,
    ...(entry.postInstall !== undefined ? { postInstall: entry.postInstall } : {}),
    ...(entry.registrySourceId !== undefined ? { registrySourceId: entry.registrySourceId } : {}),
    ...(params.lock !== undefined ? { lock: params.lock } : {}),
  };
}

function bundleCandidate(params: {
  skills: SkillManifest[];
  catalog: McpCatalogEntry[];
  installedServers: McpServerStatus[];
}): ExtensionCandidate | null {
  const filesystemEntry = params.catalog.find((entry) => (
    entry.id === "modelcontextprotocol-filesystem" ||
    entry.name.toLowerCase() === "filesystem"
  ));
  if (!filesystemEntry) return null;
  const skill = params.skills.find((candidate) => candidate.name === "code-reviewer");
  const server = params.installedServers.find((candidate) => (
    candidate.id === filesystemEntry.id ||
    candidate.name.toLowerCase() === filesystemEntry.name.toLowerCase()
  ));
  const installed = skill !== undefined && server !== undefined;
  const enabled = skill?.status === "active" && server?.enabled === true;
  const status = enabled
    ? "active"
    : installed
      ? "installed"
      : "available";
  const items: ExtensionBundleItem[] = [
    {
      kind: "skill_github",
      url: CODE_REVIEWER_SKILL_URL,
    },
    {
      kind: "mcp_catalog",
      catalogId: filesystemEntry.id,
      enable: true,
    },
  ];
  return {
    id: "bundle:code-review-workspace",
    kind: "bundle",
    name: "code-review-workspace",
    title: "Code Review Workspace Bundle",
    description: "Installs a real GitHub code-review skill and the official Filesystem MCP server for project-file review workflows.",
    source: "forge-builtin-bundle:code-review-workspace",
    sourceLabel: "ForgeAgent bundle",
    trust: "trusted",
    installed,
    enabled,
    status,
    capabilities: ["skill", "mcp_server", "fs.read", "fs.write"],
    riskSummary: "Bundle installation expands into normal skill and MCP installs; MCP launch and file access still go through ForgeAgent policy and sandbox.",
    installInput: {
      kind: "bundle",
      name: "code-review-workspace",
      enable: true,
      items,
    },
    metadata: {
      skillName: "code-reviewer",
      skillUrl: CODE_REVIEWER_SKILL_URL,
      mcpCatalogId: filesystemEntry.id,
      mcpServerId: server?.id,
    },
  };
}

function designBundleCandidate(params: {
  skills: SkillManifest[];
  catalog: McpCatalogEntry[];
  installedServers: McpServerStatus[];
}): ExtensionCandidate | null {
  const everythingEntry = params.catalog.find((entry) => (
    entry.id === "modelcontextprotocol-everything" ||
    entry.name.toLowerCase() === "everything"
  ));
  if (!everythingEntry) return null;
  const skill = params.skills.find((candidate) => candidate.name === "frontend-design");
  const server = params.installedServers.find((candidate) => (
    candidate.id === everythingEntry.id ||
    candidate.name.toLowerCase() === everythingEntry.name.toLowerCase()
  ));
  const installed = skill !== undefined && server !== undefined;
  const enabled = skill?.status === "active" && server?.enabled === true;
  const status = enabled
    ? "active"
    : installed
      ? "installed"
      : "available";
  return {
    id: "bundle:design-reference",
    kind: "bundle",
    name: "design-reference",
    title: "Design Reference Bundle",
    description: "Installs a real GitHub frontend-design skill and the official Everything MCP reference server for extension verification workflows.",
    source: "forge-builtin-bundle:design-reference",
    sourceLabel: "ForgeAgent bundle",
    trust: "trusted",
    installed,
    enabled,
    status,
    capabilities: ["skill", "mcp_server", "mcp.tool", "design"],
    riskSummary: "Bundle installation expands into normal skill and MCP installs; the MCP server still launches through ForgeAgent permissions.",
    installInput: {
      kind: "bundle",
      name: "design-reference",
      enable: true,
      items: [
        {
          kind: "skill_github",
          url: FRONTEND_DESIGN_SKILL_URL,
        },
        {
          kind: "mcp_catalog",
          catalogId: everythingEntry.id,
          enable: true,
        },
      ],
    },
    metadata: {
      skillName: "frontend-design",
      skillUrl: FRONTEND_DESIGN_SKILL_URL,
      mcpCatalogId: everythingEntry.id,
      mcpServerId: server?.id,
    },
  };
}

function parseNpmMcpQuery(query: string): Omit<McpServerConfig, "id"> | null {
  const trimmed = query.trim();
  const npmMatch = /^(?:npm:)?(@?[\w.-]+\/[\w.-]+|@?[\w.-]+)(?:@[\w.-]+)?$/.exec(trimmed);
  if (!npmMatch) return null;
  const pkg = npmMatch[1]!;
  if (
    !trimmed.toLowerCase().includes("mcp") &&
    !pkg.toLowerCase().includes("mcp") &&
    !pkg.toLowerCase().includes("modelcontextprotocol")
  ) return null;
  return {
    name: pkg.replace(/^@/, "").replace(/[^\w-]+/g, "-"),
    enabled: false,
    transport: "stdio",
    launchMode: "lazy",
    trust: "untrusted",
    command: "npx",
    args: ["-y", trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed],
    source: "local",
  };
}

function candidateFromLink(link: string): ExtensionCandidate | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const skillLink = resolveGitHubSkillLink(url);
  if (skillLink) {
    return {
      id: `link-skill:${url.href}`,
      kind: "skill",
      name: skillLink.name,
      title: skillLink.name,
      description: `Skill candidate resolved from ${skillLink.sourceLabel}. ForgeAgent will download the complete SKILL.md package directory, scan it, and enable it only if the package is clean or explicitly force-enabled.`,
      source: url.href,
      sourceLabel: skillLink.sourceLabel,
      trust: "community",
      installed: false,
      enabled: false,
      status: "available",
      capabilities: ["skill"],
      riskSummary: "External skills are readable instruction packages. They are scanned before activation; scripts still require explicit tool calls and normal ForgeAgent permissions.",
      installInput: {
        kind: "skill_github",
        url: url.href,
        name: skillLink.name,
      },
      metadata: {
        skillUrl: skillLink.skillUrl,
        skillJsonUrl: skillLink.skillJsonUrl,
        owner: skillLink.owner,
        repo: skillLink.repo,
      },
    };
  }
  const isGitHub = url.hostname.toLowerCase() === "github.com";
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (isGitHub && pathParts.length >= 2) {
    const owner = pathParts[0]!;
    const repo = pathParts[1]!;
    const name = repo.toLowerCase().includes("mcp") ? repo : `${repo}-mcp`;
    return {
      id: `link:${url.href}`,
      kind: "mcp_server",
      name,
      title: name,
      description: `MCP server candidate resolved from GitHub repository ${owner}/${repo}. Review the command before enabling.`,
      source: url.href,
      sourceLabel: "GitHub link",
      trust: "untrusted",
      installed: false,
      enabled: false,
      status: "available",
      capabilities: ["stdio", "process launch"],
      riskSummary: "A GitHub link cannot prove its runtime command automatically. ForgeAgent stages an npx-based MCP candidate and keeps it disabled until enabled.",
      installInput: {
        kind: "mcp_server",
        server: {
          name,
          enabled: false,
          transport: "stdio",
          launchMode: "lazy",
          trust: "untrusted",
          command: "npx",
          args: ["-y", repo],
          source: "local",
        },
      },
      metadata: { url: url.href, owner, repo },
    };
  }
  return null;
}

function resolveGitHubSkillLink(url: URL): {
  skillUrl: string;
  skillJsonUrl: string;
  owner: string;
  repo: string;
  ref: string;
  skillPath: string;
  packagePath: string;
  name: string;
  sourceLabel: string;
} | null {
  const host = url.hostname.toLowerCase();
  if (host === "raw.githubusercontent.com") {
    if (!url.pathname.endsWith("/SKILL.md")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const owner = parts[0]!;
    const repo = parts[1]!;
    const ref = parts[2]!;
    const skillPath = parts.slice(3).join("/");
    const packagePath = skillPath.replace(/\/?SKILL\.md$/i, "").replace(/\/$/, "");
    const name = normalizeExtensionName(parts.at(-2) ?? repo);
    return {
      skillUrl: url.href,
      skillJsonUrl: url.href.replace(/\/SKILL\.md$/i, "/skill.json"),
      owner,
      repo,
      ref,
      skillPath,
      packagePath,
      name,
      sourceLabel: "GitHub skill",
    };
  }
  if (host !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 2) {
    const [owner, repo] = parts;
    if (!owner || !repo) return null;
    const ref = "HEAD";
    const skillPath = "SKILL.md";
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${skillPath}`;
    return {
      skillUrl: raw,
      skillJsonUrl: raw.replace(/\/SKILL\.md$/i, "/skill.json"),
      owner,
      repo,
      ref,
      skillPath,
      packagePath: "",
      name: normalizeExtensionName(repo),
      sourceLabel: "GitHub skill",
    };
  }
  if (parts.length < 5) return null;
  const [owner, repo, mode, ref, ...pathParts] = parts;
  if (!owner || !repo || !mode || !ref || (mode !== "blob" && mode !== "tree")) return null;
  const skillPath = mode === "blob"
    ? pathParts.join("/")
    : [...pathParts, "SKILL.md"].join("/");
  if (!skillPath.endsWith("SKILL.md")) return null;
  const packagePath = skillPath.replace(/\/?SKILL\.md$/i, "").replace(/\/$/, "");
  const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${skillPath}`;
  const name = normalizeExtensionName(skillPath.split("/").at(-2) ?? repo);
  return {
    skillUrl: raw,
    skillJsonUrl: raw.replace(/\/SKILL\.md$/i, "/skill.json"),
    owner,
    repo,
    ref,
    skillPath,
    packagePath,
    name,
    sourceLabel: "GitHub skill",
  };
}

function normalizeExtensionName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, "-")
    .replace(/[^a-z0-9.-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "github-skill";
}

type GitHubTreeResponse = {
  tree?: Array<{
    path?: string;
    type?: string;
    mode?: string;
    size?: number;
  }>;
  truncated?: boolean;
  message?: string;
};

async function downloadGitHubSkillPackage(url: string): Promise<{
  sourceUrl: string;
  skillMd: string;
  skillJson?: Partial<SkillPackageManifest>;
  supportFiles: Array<{ path: string; content: Uint8Array }>;
}> {
  const cached = githubSkillPackageCache.get(url);
  if (cached) return cloneDownloadedPackage(cached);
  const resolved = resolveGitHubSkillLink(new URL(url));
  if (!resolved) {
    throw new Error("GitHub skill install requires a GitHub tree URL or a GitHub/raw SKILL.md URL so the complete skill package directory can be downloaded.");
  }
  try {
    const pkg = await downloadGitHubSkillPackageViaTree(url, resolved);
    githubSkillPackageCache.set(url, cloneDownloadedPackage(pkg));
    return pkg;
  } catch (err) {
    if (!isGitHubRateLimitError(err)) throw err;
    const pkg = await downloadGitHubSkillPackageViaTarball(url, resolved);
    githubSkillPackageCache.set(url, cloneDownloadedPackage(pkg));
    return pkg;
  }
}

async function downloadGitHubSkillPackageViaTree(
  url: string,
  resolved: NonNullable<ReturnType<typeof resolveGitHubSkillLink>>,
): Promise<{
  sourceUrl: string;
  skillMd: string;
  skillJson?: Partial<SkillPackageManifest>;
  supportFiles: Array<{ path: string; content: Uint8Array }>;
}> {
  const treeUrl = `https://api.github.com/repos/${resolved.owner}/${resolved.repo}/git/trees/${encodeURIComponent(resolved.ref)}?recursive=1`;
  const treeResponse = await fetchWithRedirectGuard(treeUrl);
  const tree = await treeResponse.json() as GitHubTreeResponse;
  if (!Array.isArray(tree.tree)) {
    throw new Error(`GitHub tree response did not include file metadata for ${resolved.owner}/${resolved.repo}: ${tree.message ?? "unknown error"}`);
  }
  if (tree.truncated) {
    throw new Error(`GitHub tree for ${resolved.owner}/${resolved.repo} was truncated. Refuse to install a partial skill package.`);
  }
  const packagePrefix = resolved.packagePath ? `${resolved.packagePath}/` : "";
  const files = tree.tree
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .filter((entry) => entry.path === resolved.skillPath || entry.path!.startsWith(packagePrefix))
    .map((entry) => ({
      path: entry.path!,
      relativePath: packagePrefix ? entry.path!.slice(packagePrefix.length) : entry.path!,
      mode: entry.mode,
      size: entry.size,
    }))
    .filter((entry) => isInstallableSkillPackagePath(entry.relativePath))
    .filter((entry) => entry.relativePath && entry.relativePath !== ".");
  if (!files.some((entry) => entry.relativePath === "SKILL.md")) {
    throw new Error(`GitHub skill package is missing SKILL.md at ${resolved.skillPath}.`);
  }
  if (files.some((entry) => entry.mode === "120000")) {
    throw new Error("GitHub skill package contains a symlink. Refuse to install.");
  }
  const totalBytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
  if (totalBytes > 20 * 1024 * 1024) {
    throw new Error(`GitHub skill package exceeds 20MiB (${totalBytes} bytes).`);
  }
  const supportFiles: Array<{ path: string; content: Uint8Array }> = [];
  let skillMd = "";
  let skillJson: Partial<SkillPackageManifest> | undefined;
  for (const file of files) {
    if ((file.size ?? 0) > 1024 * 1024 && file.relativePath !== "SKILL.md") {
      throw new Error(`GitHub skill support file exceeds 1MiB: ${file.relativePath}`);
    }
    const rawUrl = `https://raw.githubusercontent.com/${resolved.owner}/${resolved.repo}/${resolved.ref}/${file.path}`;
    const data = await fetchBytes(rawUrl);
    if (file.relativePath === "SKILL.md") {
      skillMd = new TextDecoder().decode(data);
    } else if (file.relativePath === "skill.json") {
      skillJson = JSON.parse(new TextDecoder().decode(data)) as Partial<SkillPackageManifest>;
    } else {
      supportFiles.push({ path: file.relativePath, content: data });
    }
  }
  return {
    sourceUrl: url,
    skillMd,
    ...(skillJson !== undefined ? { skillJson } : {}),
    supportFiles,
  };
}

async function downloadGitHubSkillPackageViaTarball(
  url: string,
  resolved: NonNullable<ReturnType<typeof resolveGitHubSkillLink>>,
): Promise<{
  sourceUrl: string;
  skillMd: string;
  skillJson?: Partial<SkillPackageManifest>;
  supportFiles: Array<{ path: string; content: Uint8Array }>;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "forgeagent-skill-"));
  try {
    const tarballUrl = `https://codeload.github.com/${resolved.owner}/${resolved.repo}/tar.gz/${resolved.ref}`;
    const archive = await fetchBytes(tarballUrl);
    if (archive.byteLength > 50 * 1024 * 1024) {
      throw new Error(`GitHub skill repository archive exceeds 50MiB (${archive.byteLength} bytes).`);
    }
    const archivePath = join(tempDir, "repo.tar.gz");
    const extractDir = join(tempDir, "extract");
    mkdirSync(extractDir, { recursive: true });
    writeFileSync(archivePath, archive);
    execFileSync("tar", ["-xzf", archivePath, "-C", extractDir], { stdio: "pipe" });
    const top = readdirSync(extractDir).find((entry) => statSync(join(extractDir, entry)).isDirectory());
    if (!top) throw new Error("GitHub archive did not contain a repository directory.");
    const packageDir = resolve(join(extractDir, top, resolved.packagePath));
    if (!existsSync(packageDir)) {
      throw new Error(`GitHub archive is missing skill package directory: ${resolved.packagePath}`);
    }
    return packageFromDirectory(url, packageDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function packageFromDirectory(
  sourceUrl: string,
  packageDir: string,
): {
  sourceUrl: string;
  skillMd: string;
  skillJson?: Partial<SkillPackageManifest>;
  supportFiles: Array<{ path: string; content: Uint8Array }>;
} {
  const files: Array<{ path: string; fullPath: string; size: number }> = [];
  collectPackageFiles(packageDir, packageDir, files);
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new Error("GitHub archive skill package is missing SKILL.md.");
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > 20 * 1024 * 1024) {
    throw new Error(`GitHub skill package exceeds 20MiB (${totalBytes} bytes).`);
  }
  let skillMd = "";
  let skillJson: Partial<SkillPackageManifest> | undefined;
  const supportFiles: Array<{ path: string; content: Uint8Array }> = [];
  for (const file of files) {
    const data = readFileSync(file.fullPath);
    if (file.path === "SKILL.md") {
      skillMd = data.toString("utf-8");
    } else if (file.path === "skill.json") {
      skillJson = JSON.parse(data.toString("utf-8")) as Partial<SkillPackageManifest>;
    } else {
      supportFiles.push({ path: file.path, content: new Uint8Array(data) });
    }
  }
  return {
    sourceUrl,
    skillMd,
    ...(skillJson !== undefined ? { skillJson } : {}),
    supportFiles,
  };
}

function collectPackageFiles(root: string, dir: string, out: Array<{ path: string; fullPath: string; size: number }>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const lst = lstatSync(fullPath);
    const rel = toPortable(relative(root, fullPath));
    if (lst.isSymbolicLink()) throw new Error(`GitHub skill package contains a symlink: ${rel}`);
    if (entry.isDirectory()) {
      collectPackageFiles(root, fullPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isInstallableSkillPackagePath(rel)) continue;
    const stat = statSync(fullPath);
    if (stat.size > 1024 * 1024 && rel !== "SKILL.md") {
      throw new Error(`GitHub skill support file exceeds 1MiB: ${rel}`);
    }
    out.push({ path: rel, fullPath, size: stat.size });
  }
}

function isInstallableSkillPackagePath(rel: string): boolean {
  const normalized = rel.replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return false;
  if (normalized === "SKILL.md" || normalized === "skill.json") return true;
  const first = normalized.split("/")[0];
  return first !== undefined && SKILL_PACKAGE_SUPPORT_DIRS.has(first);
}

function cloneDownloadedPackage(pkg: {
  sourceUrl: string;
  skillMd: string;
  skillJson?: Partial<SkillPackageManifest>;
  supportFiles: Array<{ path: string; content: Uint8Array }>;
}): {
  sourceUrl: string;
  skillMd: string;
  skillJson?: Partial<SkillPackageManifest>;
  supportFiles: Array<{ path: string; content: Uint8Array }>;
} {
  return {
    sourceUrl: pkg.sourceUrl,
    skillMd: pkg.skillMd,
    ...(pkg.skillJson !== undefined ? { skillJson: { ...pkg.skillJson } } : {}),
    supportFiles: pkg.supportFiles.map((file) => ({ path: file.path, content: new Uint8Array(file.content) })),
  };
}

function isGitHubRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /403|rate limit/i.test(message);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetchWithRedirectGuard(url);
  return new Uint8Array(await response.arrayBuffer());
}

function toPortable(filePath: string): string {
  return filePath.split(sep).join("/");
}

async function fetchWithRedirectGuard(url: string, redirects = 0): Promise<Response> {
  if (redirects > 5) throw new Error("Extension download exceeded redirect limit.");
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsafe extension URL protocol: ${parsed.protocol}`);
  }
  if (parsed.hostname === "169.254.169.254") {
    throw new Error("Unsafe extension URL host.");
  }
  const response = await fetch(url, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("Extension download redirect missing location.");
    return await fetchWithRedirectGuard(new URL(location, url).toString(), redirects + 1);
  }
  if (!response.ok) throw new Error(`Extension download failed: ${response.status} ${response.statusText}`);
  return response;
}

export class ExtensionManager {
  #deps: ExtensionManagerDeps;

  constructor(deps: ExtensionManagerDeps) {
    this.#deps = deps;
  }

  getStatus(): ExtensionStatus {
    const skills = this.#deps.listSkills({ includeInactive: true });
    const sources = this.#deps.listSkillSources();
    const servers = this.#deps.listMcpServers();
    const quarantinedSkills = skills.filter((skill) => skill.status === "quarantined").length;
    const invalidSkills = skills.filter((skill) => skill.status === "invalid").length;
    return {
      skills: {
        status: this.#deps.getSkillStatus(),
        sources,
        entries: skills,
      },
      mcp: {
        servers,
        tools: this.#deps.listMcpTools(),
        catalog: this.#deps.listMcpCatalog(),
      },
      counts: {
        installed: skills.length + servers.length,
        enabled: skills.filter((skill) => skill.status === "active").length + servers.filter((server) => server.enabled).length,
        quarantined: quarantinedSkills + servers.filter((server) => server.trust === "quarantined").length,
        invalid: invalidSkills + servers.filter((server) => server.state === "failed").length,
      },
      registry: {
        sources: this.#deps.registryStore?.listSources() ?? [],
        entries: this.#deps.registryStore?.listRegistryEntries() ?? [],
        locks: this.#deps.registryStore?.listLocks() ?? [],
        events: this.#deps.registryStore?.listEvents() ?? [],
        diagnostics: this.#deps.registryStore?.getDiagnostics() ?? [],
      },
    };
  }

  search(options?: ExtensionSearchOptions): ExtensionCandidate[] {
    const query = normalizeSearch(options?.query ?? "");
    const sourceNames = new Map(this.#deps.listSkillSources().map((source) => [source.id, source.name]));
    const skills = this.#deps.listSkills({ includeInactive: true })
      .map((skill) => skillCandidate(skill, sourceNames.get(skill.sourceId) ?? skill.source))
      .filter((candidate) => options?.includeInstalled === true || !candidate.installed || query);

    const servers = this.#deps.listMcpServers();
    const serverCandidates = servers.map(mcpServerCandidate);
    const catalog = this.#deps.listMcpCatalog();
    const catalogCandidates = catalog.map((entry) => mcpCatalogCandidate(entry, servers));
    const skillEntries = this.#deps.listSkills({ includeInactive: true });
    const registryEntries = this.#deps.registryStore?.listRegistryEntries() ?? [];
    const registryCandidates = registryEntries.map((entry) => registryCandidate({
      entry,
      skills: skillEntries,
      servers,
      catalog,
      lock: this.#deps.registryStore?.getLock(entry.id),
    }));
    const builtinBundles = [
      bundleCandidate({ skills: skillEntries, catalog, installedServers: servers }),
      designBundleCandidate({ skills: skillEntries, catalog, installedServers: servers }),
    ].filter((candidate): candidate is ExtensionCandidate => candidate !== null);
    const linkText = options?.link ?? extractFirstHttpUrl(options?.query);
    const linkCandidate = linkText ? candidateFromLink(linkText) : null;
    const npmCandidate = query ? parseNpmMcpQuery(options?.query ?? "") : null;
    const extraCandidates = [
      ...(linkCandidate ? [linkCandidate] : []),
      ...builtinBundles,
      ...(npmCandidate ? [{
        id: `npm:${npmCandidate.name}`,
        kind: "mcp_server" as const,
        name: npmCandidate.name,
        title: npmCandidate.name,
        description: `MCP server candidate from npm package ${npmCandidate.args?.at(-1) ?? npmCandidate.name}.`,
        source: npmCandidate.args?.at(-1) ?? npmCandidate.name,
        sourceLabel: "npm",
        trust: "untrusted" as const,
        installed: false,
        enabled: false,
        status: "available" as const,
        capabilities: ["stdio", "process launch"],
        riskSummary: "Installing an npm MCP server configures npx. It remains disabled until enabled.",
        installInput: { kind: "mcp_server" as const, server: npmCandidate },
      }] : []),
    ];

    const all = [...extraCandidates, ...registryCandidates, ...catalogCandidates, ...serverCandidates, ...skills];
    const filtered = query
      ? all.filter((candidate) => (
        candidate.id.startsWith("link-") ||
        includesNeedle(candidate.name, query) ||
        includesNeedle(candidate.title, query) ||
        includesNeedle(candidate.description, query) ||
        includesNeedle(candidate.source, query) ||
        includesNeedle(candidate.sourceLabel, query) ||
        candidate.capabilities.some((capability) => includesNeedle(capability, query))
      ))
      : all;

    const unique = new Map<string, ExtensionCandidate>();
    for (const candidate of filtered) {
      if (!unique.has(candidate.id)) unique.set(candidate.id, candidate);
    }
    return [...unique.values()].sort((a, b) => {
      const linkPriority = Number(b.id.startsWith("link-")) - Number(a.id.startsWith("link-"));
      if (linkPriority !== 0) return linkPriority;
      if (query) {
        const relevance = scoreCandidate(b, query) - scoreCandidate(a, query);
        if (relevance !== 0) return relevance;
      }
      if (a.installed !== b.installed) return a.installed ? 1 : -1;
      if (a.trust !== b.trust) {
        const rank = (trust: ExtensionTrust) => ["official", "curated", "trusted", "local", "community", "untrusted", "quarantined"].indexOf(trust);
        return rank(a.trust) - rank(b.trust);
      }
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
  }

  async install(input: ExtensionInstallInput): Promise<ExtensionInstallResult> {
    const registryEntry = this.#entryForInstallInput(input);
    if (input.kind === "skill") {
      const result = await this.#deps.installSkill(input);
      const output: ExtensionInstallResult = {
        kind: "skill",
        id: result.skill.packageId,
        name: result.skill.name,
        status: result.skill.status === "active" ? "active" : result.skill.status === "quarantined" ? "quarantined" : result.skill.status === "invalid" ? "invalid" : "installed",
        message: result.skill.status === "active"
          ? skillInstallMessage("Skill installed and", result.skill)
          : `Skill installed but not active: ${result.skill.name} ${result.skill.version}`,
        skill: result.skill,
      };
      if (result.scan) output.scan = result.scan;
      return this.#recordInstall(input, output, registryEntry);
    }

    if (input.kind === "skill_github") {
      const normalizedInput: Extract<ExtensionInstallInput, { kind: "skill_github" }> = {
        ...input,
        ...(registryEntry?.trust === "curated" && input.force !== true ? { force: true } : {}),
      };
      const pkg = await downloadGitHubSkillPackage(normalizedInput.url);
      const externalInput: Extract<ExtensionInstallInput, { kind: "skill_github" }> & {
        skillMd: string;
        sourceUrl: string;
        skillJson?: Partial<SkillPackageManifest>;
        supportFiles?: Array<{ path: string; content: string | Uint8Array }>;
      } = {
        ...normalizedInput,
        sourceUrl: pkg.sourceUrl,
        skillMd: pkg.skillMd,
      };
      if (pkg.skillJson !== undefined) externalInput.skillJson = pkg.skillJson;
      if (pkg.supportFiles.length > 0) externalInput.supportFiles = pkg.supportFiles;
      const result = await this.#deps.installExternalSkill(externalInput);
      const output: ExtensionInstallResult = {
        kind: "skill",
        id: result.skill.packageId,
        name: result.skill.name,
        status: result.skill.status === "active" ? "active" : result.skill.status === "quarantined" ? "quarantined" : result.skill.status === "invalid" ? "invalid" : "installed",
        message: result.skill.status === "active"
          ? skillInstallMessage("Skill installed from GitHub and", result.skill)
          : `Skill installed from GitHub but not active: ${result.skill.name} ${result.skill.version}`,
        skill: result.skill,
      };
      if (result.scan) output.scan = result.scan;
      return this.#recordInstall(input, output, registryEntry);
    }

    if (input.kind === "mcp_catalog") {
      const server = await this.#deps.installMcpCatalogEntry(input.catalogId);
      const catalogEntry = this.#deps.listMcpCatalog().find((entry) => entry.id === input.catalogId);
      const shouldEnable = input.enable === true && catalogEntry?.setupRequired !== true && registryEntry?.setupRequired !== true;
      const enabled = shouldEnable ? await this.#deps.enableMcpServer(server.id) : server;
      const output: ExtensionInstallResult = {
        kind: "mcp_server",
        id: enabled.id,
        name: enabled.name,
        status: enabled.enabled ? "active" : "installed",
        message: (catalogEntry?.setupRequired === true || registryEntry?.setupRequired === true) && input.enable === true
          ? `MCP server installed disabled because setup is required: ${enabled.name}. ${catalogEntry?.postInstall ?? registryEntry?.postInstall ?? "Configure required environment values before enabling."}`
          : enabled.enabled
          ? `MCP server installed and enabled: ${enabled.name}`
          : `MCP server installed disabled for review: ${enabled.name}`,
        mcpServer: enabled,
      };
      return this.#recordInstall(input, output, registryEntry);
    }

    if (input.kind === "bundle") {
      const items: ExtensionInstallResult[] = [];
      for (const item of input.items) {
        const normalized = withBundleEnable(item, input.enable === true);
        items.push(await this.install(normalized));
      }
      const status = items.some((item) => item.status === "invalid")
        ? "invalid"
        : items.some((item) => item.status === "quarantined")
          ? "quarantined"
          : items.every((item) => item.status === "active")
            ? "active"
            : "installed";
      const output: ExtensionInstallResult = {
        kind: "bundle",
        id: `bundle:${normalizeExtensionName(input.name)}`,
        name: input.name,
        status,
        message: `Bundle installed: ${input.name}. Items: ${items.map((item) => `${item.name}=${item.status}`).join(", ")}`,
        items,
      };
      return this.#recordInstall(input, output, registryEntry);
    }

    const server = this.#deps.addMcpServer(input.server);
    const enabled = input.enable === true ? await this.#deps.enableMcpServer(server.id) : server;
    const output: ExtensionInstallResult = {
      kind: "mcp_server",
      id: enabled.id,
      name: enabled.name,
      status: enabled.enabled ? "active" : "installed",
      message: enabled.enabled
        ? `MCP server configured and enabled: ${enabled.name}`
        : `MCP server configured disabled for review: ${enabled.name}`,
      mcpServer: enabled,
    };
    return this.#recordInstall(input, output, registryEntry);
  }

  async enable(
    kind: ExtensionKind,
    idOrName: string,
    version?: string,
    options?: { trustWarnings?: boolean },
  ): Promise<ExtensionInstallResult> {
    if (kind === "skill") {
      const skill = this.#deps.enableSkill(idOrName, version, options);
      const output: ExtensionInstallResult = {
        kind: "skill",
        id: skill.packageId,
        name: skill.name,
        status: "active",
        message: skillReviewState(skill) === "warning"
          ? `Skill trusted and enabled with scanner warnings: ${skill.name} ${skill.version}`
          : `Skill enabled: ${skill.name} ${skill.version}`,
        skill,
      };
      this.#deps.registryStore?.markEnabled({ kind, idOrName, result: output });
      return output;
    }
    if (kind === "bundle") {
      const params = {
        skills: this.#deps.listSkills({ includeInactive: true }),
        catalog: this.#deps.listMcpCatalog(),
        installedServers: this.#deps.listMcpServers(),
      };
      const candidate = [
        bundleCandidate(params),
        designBundleCandidate(params),
        ...this.search({ includeInstalled: true }).filter((item) => item.kind === "bundle"),
      ].find((item) => item && (item.name === idOrName || item.id === idOrName));
      if (!candidate || (candidate.name !== idOrName && candidate.id !== idOrName)) {
        throw new Error(`Bundle not found: ${idOrName}`);
      }
      const output = await this.install(candidate.installInput);
      this.#deps.registryStore?.markEnabled({ kind, idOrName, result: output });
      return output;
    }
    const server = await this.#deps.enableMcpServer(idOrName);
    const output: ExtensionInstallResult = {
      kind: "mcp_server",
      id: server.id,
      name: server.name,
      status: "active",
      message: `MCP server enabled: ${server.name}`,
      mcpServer: server,
    };
    this.#deps.registryStore?.markEnabled({ kind, idOrName, result: output });
    return output;
  }

  listRegistrySources(): ExtensionRegistrySource[] {
    return this.#deps.registryStore?.listSources() ?? [];
  }

  addRegistrySource(input: AddExtensionRegistrySourceInput): ExtensionRegistrySource {
    if (!this.#deps.registryStore) throw new Error("Extension registry store is not configured.");
    return this.#deps.registryStore.addSource(input);
  }

  removeRegistrySource(id: string): boolean {
    if (!this.#deps.registryStore) throw new Error("Extension registry store is not configured.");
    return this.#deps.registryStore.removeSource(id);
  }

  refreshRegistrySource(id: string): Promise<ExtensionRegistrySource> {
    if (!this.#deps.registryStore) throw new Error("Extension registry store is not configured.");
    return this.#deps.registryStore.refreshSource(id);
  }

  getEvents(afterSeq = 0): ExtensionEventRecord[] {
    return this.#deps.registryStore?.listEvents(afterSeq) ?? [];
  }

  #entryForInstallInput(input: ExtensionInstallInput): ExtensionRegistryEntry | undefined {
    const entries = this.#deps.registryStore?.listRegistryEntries() ?? [];
    return entries.find((entry) => installInputsMatch(entry.installInput, input));
  }

  #recordInstall(
    installInput: ExtensionInstallInput,
    result: ExtensionInstallResult,
    entry: ExtensionRegistryEntry | undefined,
  ): ExtensionInstallResult {
    this.#deps.registryStore?.recordInstall({
      installInput,
      result,
      ...(entry !== undefined ? { entry } : {}),
    });
    return result;
  }
}

function scoreCandidate(candidate: ExtensionCandidate, query: string): number {
  let score = 0;
  if (candidate.name.toLowerCase() === query || candidate.title.toLowerCase() === query) score += 200;
  if (candidate.name.toLowerCase().includes(query)) score += 120;
  if (candidate.title.toLowerCase().includes(query)) score += 100;
  if (candidate.source.toLowerCase().includes(query) || candidate.sourceLabel.toLowerCase().includes(query)) score += 60;
  if (candidate.description.toLowerCase().includes(query)) score += 30;
  if (candidate.capabilities.some((capability) => capability.toLowerCase().includes(query))) score += 8;
  return score;
}

function withBundleEnable(item: ExtensionBundleItem, enable: boolean): ExtensionBundleItem {
  if (!enable) return item;
  if (item.kind === "mcp_catalog") return { ...item, enable: item.enable ?? true };
  if (item.kind === "mcp_server") return { ...item, enable: item.enable ?? true };
  return item;
}

function installInputsMatch(a: ExtensionInstallInput, b: ExtensionInstallInput): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "skill" && b.kind === "skill") return a.name === b.name && (a.version ?? "") === (b.version ?? "");
  if (a.kind === "skill_github" && b.kind === "skill_github") {
    return normalizeInstallUrl(a.url) === normalizeInstallUrl(b.url) || (a.name !== undefined && a.name === b.name);
  }
  if (a.kind === "mcp_catalog" && b.kind === "mcp_catalog") return a.catalogId === b.catalogId;
  if (a.kind === "mcp_server" && b.kind === "mcp_server") {
    return a.server.name === b.server.name ||
      (a.server.command === b.server.command && JSON.stringify(a.server.args ?? []) === JSON.stringify(b.server.args ?? []));
  }
  if (a.kind === "bundle" && b.kind === "bundle") return normalizeExtensionName(a.name) === normalizeExtensionName(b.name);
  return false;
}

function normalizeInstallUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/\/$/, "");
  }
}
