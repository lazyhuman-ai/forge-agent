import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  McpCatalogEntry,
  McpEvent,
  McpLaunchMode,
  McpServerConfig,
  McpTransportKind,
  McpTrust,
  McpToolMetadata,
} from "./types.js";

type StoreState = {
  version: 1;
  servers: McpServerConfig[];
  catalog: McpCatalogEntry[];
  updatedAt: string;
};

export type McpConfigStoreOptions = {
  rootDir: string;
  projectRoot?: string;
  nextSeq: () => number;
  now: () => string;
};

const DEFAULT_STATE: StoreState = {
  version: 1,
  servers: [],
  catalog: [],
  updatedAt: new Date(0).toISOString(),
};

const BUILTIN_CATALOG: McpCatalogEntry[] = [
  {
    id: "modelcontextprotocol-filesystem",
    name: "Filesystem",
    description: "Official MCP filesystem server for reading and editing files inside configured roots.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "{{projectRoot}}"],
    trust: "trusted",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    packageName: "@modelcontextprotocol/server-filesystem",
    packageVersion: "2026.1.14",
    auth: { type: "none" },
    defaultEnabledTools: ["read_file", "read_text_file", "list_directory", "directory_tree", "search_files"],
    tags: ["official", "filesystem", "project"],
  },
  {
    id: "modelcontextprotocol-everything",
    name: "Everything",
    description: "Official MCP reference server for validating tools, resources, prompts, sampling, and elicitation support.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything@2026.1.26"],
    trust: "trusted",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/everything",
    packageName: "@modelcontextprotocol/server-everything",
    packageVersion: "2026.1.26",
    auth: { type: "none" },
    tags: ["official", "reference", "testing"],
  },
  {
    id: "modelcontextprotocol-memory",
    name: "Memory",
    description: "Official MCP memory server for local knowledge graph style notes and relations.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory@2026.1.26"],
    trust: "trusted",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    packageName: "@modelcontextprotocol/server-memory",
    packageVersion: "2026.1.26",
    auth: { type: "none" },
    tags: ["official", "memory", "knowledge"],
  },
  {
    id: "modelcontextprotocol-sequential-thinking",
    name: "Sequential Thinking",
    description: "Official MCP sequential-thinking server for explicit multi-step reasoning traces.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2025.12.18"],
    trust: "trusted",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    packageName: "@modelcontextprotocol/server-sequential-thinking",
    packageVersion: "2025.12.18",
    auth: { type: "none" },
    tags: ["official", "reasoning"],
  },
  {
    id: "modelcontextprotocol-github",
    name: "GitHub",
    description: "Official MCP GitHub server for repositories, issues, pull requests, and code search.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{GITHUB_PERSONAL_ACCESS_TOKEN}}" },
    trust: "trusted",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    packageName: "@modelcontextprotocol/server-github",
    packageVersion: "2025.4.8",
    auth: {
      type: "api_key",
      env: [
        {
          name: "GITHUB_PERSONAL_ACCESS_TOKEN",
          prompt: "GitHub personal access token with the repository scopes you want ForgeAgent to use.",
          required: true,
          secret: true,
        },
      ],
    },
    setupRequired: true,
    postInstall: "Set GITHUB_PERSONAL_ACCESS_TOKEN in the MCP server config before enabling.",
    tags: ["official", "github", "code"],
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Community MCP server for Brave Search web results.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search@0.6.2"],
    env: { BRAVE_API_KEY: "{{BRAVE_API_KEY}}" },
    trust: "trusted",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    packageName: "@modelcontextprotocol/server-brave-search",
    packageVersion: "0.6.2",
    auth: {
      type: "api_key",
      env: [
        {
          name: "BRAVE_API_KEY",
          prompt: "Brave Search API key.",
          required: true,
          secret: true,
        },
      ],
    },
    setupRequired: true,
    postInstall: "Set BRAVE_API_KEY before enabling Brave Search MCP.",
    tags: ["search", "web"],
  },
  {
    id: "modelcontextprotocol-puppeteer",
    name: "Puppeteer",
    description: "MCP server for browser automation through Puppeteer.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer@2025.5.12"],
    trust: "trusted",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
    packageName: "@modelcontextprotocol/server-puppeteer",
    packageVersion: "2025.5.12",
    auth: { type: "none" },
    tags: ["browser", "automation"],
  },
  {
    id: "modelcontextprotocol-postgres",
    name: "Postgres",
    description: "MCP server for querying a Postgres database.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres@0.6.2", "{{POSTGRES_CONNECTION_STRING}}"],
    trust: "trusted",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    packageName: "@modelcontextprotocol/server-postgres",
    packageVersion: "0.6.2",
    auth: {
      type: "api_key",
      env: [
        {
          name: "POSTGRES_CONNECTION_STRING",
          prompt: "Postgres connection string for the database ForgeAgent may inspect.",
          required: true,
          secret: true,
        },
      ],
    },
    setupRequired: true,
    postInstall: "Replace {{POSTGRES_CONNECTION_STRING}} with a database URL before enabling.",
    tags: ["database", "postgres"],
  },
  {
    id: "mcp-server-pdf",
    name: "PDF",
    description: "MCP server for inspecting PDF content.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-pdf@1.7.3"],
    trust: "trusted",
    sourceUrl: "https://www.npmjs.com/package/@modelcontextprotocol/server-pdf",
    packageName: "@modelcontextprotocol/server-pdf",
    packageVersion: "1.7.3",
    auth: { type: "none" },
    tags: ["pdf", "documents"],
  },
  {
    id: "mcp-server-map",
    name: "Map",
    description: "MCP server for map/geospatial workflows.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-map@1.7.3"],
    trust: "trusted",
    sourceUrl: "https://www.npmjs.com/package/@modelcontextprotocol/server-map",
    packageName: "@modelcontextprotocol/server-map",
    packageVersion: "1.7.3",
    auth: { type: "none" },
    tags: ["map", "geo"],
  },
  {
    id: "mcp-server-threejs",
    name: "Three.js",
    description: "MCP server for Three.js scene and asset workflows.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-threejs@1.7.3"],
    trust: "trusted",
    sourceUrl: "https://www.npmjs.com/package/@modelcontextprotocol/server-threejs",
    packageName: "@modelcontextprotocol/server-threejs",
    packageVersion: "1.7.3",
    auth: { type: "none" },
    tags: ["threejs", "3d"],
  },
];

function cloneCatalogEntry(entry: McpCatalogEntry): McpCatalogEntry {
  const cloned: McpCatalogEntry = {
    id: entry.id,
    name: entry.name,
    transport: entry.transport,
  };
  if (entry.description !== undefined) cloned.description = entry.description;
  if (entry.url !== undefined) cloned.url = entry.url;
  if (entry.command !== undefined) cloned.command = entry.command;
  if (entry.args !== undefined) cloned.args = [...entry.args];
  if (entry.env !== undefined) cloned.env = { ...entry.env };
  if (entry.headers !== undefined) cloned.headers = { ...entry.headers };
  if (entry.sha256 !== undefined) cloned.sha256 = entry.sha256;
  if (entry.trust !== undefined) cloned.trust = entry.trust;
  if (entry.sourceUrl !== undefined) cloned.sourceUrl = entry.sourceUrl;
  if (entry.packageName !== undefined) cloned.packageName = entry.packageName;
  if (entry.packageVersion !== undefined) cloned.packageVersion = entry.packageVersion;
  if (entry.auth !== undefined) cloned.auth = {
    ...entry.auth,
    ...(entry.auth.env !== undefined ? { env: entry.auth.env.map((env) => ({ ...env })) } : {}),
    ...(entry.auth.scopes !== undefined ? { scopes: [...entry.auth.scopes] } : {}),
  };
  if (entry.defaultEnabledTools !== undefined) cloned.defaultEnabledTools = [...entry.defaultEnabledTools];
  if (entry.postInstall !== undefined) cloned.postInstall = entry.postInstall;
  if (entry.setupRequired !== undefined) cloned.setupRequired = entry.setupRequired;
  if (entry.tags !== undefined) cloned.tags = [...entry.tags];
  return cloned;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

function idFromName(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return base || `mcp-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeTransport(raw: unknown): McpTransportKind {
  if (raw === "sse") return "sse";
  if (raw === "http" || raw === "streamable-http") return "streamable-http";
  return "stdio";
}

function normalizeLaunchMode(raw: unknown): McpLaunchMode {
  if (raw === "eager" || raw === "background" || raw === "lazy") return raw;
  return "lazy";
}

function normalizeTrust(raw: unknown): McpTrust {
  if (raw === "trusted" || raw === "untrusted" || raw === "quarantined") return raw;
  return "untrusted";
}

function normalizeSource(raw: unknown): NonNullable<McpServerConfig["source"]> {
  if (raw === "local" || raw === "project" || raw === "imported" || raw === "catalog") return raw;
  return "local";
}

function normalizeServer(raw: unknown, sourcePath?: string): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.trim()
    ? record.name.trim()
    : typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : "";
  if (!name) return null;
  const transport = normalizeTransport(record.transport ?? (typeof record.url === "string" ? "streamable-http" : "stdio"));
  const id = typeof record.id === "string" && record.id.trim() ? idFromName(record.id) : idFromName(name);
  const server: McpServerConfig = {
    id,
    name,
    enabled: record.enabled === true,
    transport,
    launchMode: normalizeLaunchMode(record.launchMode),
    trust: normalizeTrust(record.trust),
    source: normalizeSource(record.source),
  };
  if (typeof record.command === "string") server.command = record.command;
  if (Array.isArray(record.args)) server.args = record.args.map(String);
  if (record.env && typeof record.env === "object" && !Array.isArray(record.env)) {
    server.env = Object.fromEntries(Object.entries(record.env).map(([k, v]) => [k, String(v)]));
  }
  if (typeof record.cwd === "string") server.cwd = record.cwd;
  if (typeof record.url === "string") server.url = record.url;
  if (record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)) {
    server.headers = Object.fromEntries(Object.entries(record.headers).map(([k, v]) => [k, String(v)]));
  }
  if (Array.isArray(record.roots)) server.roots = record.roots.map(String);
  if (typeof record.timeoutMs === "number") server.timeoutMs = record.timeoutMs;
  if (typeof record.connectTimeoutMs === "number") server.connectTimeoutMs = record.connectTimeoutMs;
  if (typeof record.supportsParallelToolCalls === "boolean") server.supportsParallelToolCalls = record.supportsParallelToolCalls;
  if (typeof record.allowSampling === "boolean") server.allowSampling = record.allowSampling;
  if (typeof record.allowElicitation === "boolean") server.allowElicitation = record.allowElicitation;
  if (sourcePath) {
    server.source = "project";
    server.sourcePath = sourcePath;
    server.enabled = false;
    server.trust = "untrusted";
  } else if (typeof record.sourcePath === "string") {
    server.sourcePath = record.sourcePath;
  }
  return server;
}

function projectServers(projectRoot: string): McpServerConfig[] {
  const path = join(projectRoot, ".mcp.json");
  if (!existsSync(path)) return [];
  const raw = readJson<Record<string, unknown>>(path, {});
  const mcpServers = raw.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) return [];
  const result: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(mcpServers)) {
    if (!value || typeof value !== "object") continue;
    const merged = { ...(value as Record<string, unknown>), name };
    const server = normalizeServer(merged, path);
    if (server) result.push(server);
  }
  return result;
}

export class McpConfigStore {
  #rootDir: string;
  #projectRoot: string;
  #nextSeq: () => number;
  #now: () => string;

  constructor(options: McpConfigStoreOptions) {
    this.#rootDir = options.rootDir;
    this.#projectRoot = resolve(options.projectRoot ?? process.cwd());
    this.#nextSeq = options.nextSeq;
    this.#now = options.now;
    mkdirSync(this.#rootDir, { recursive: true });
    mkdirSync(this.cacheDir, { recursive: true });
    mkdirSync(this.oauthDir, { recursive: true });
    mkdirSync(this.catalogCacheDir, { recursive: true });
  }

  get rootDir(): string {
    return this.#rootDir;
  }

  get cacheDir(): string {
    return join(this.#rootDir, "cache");
  }

  get oauthDir(): string {
    return join(this.#rootDir, "oauth");
  }

  get catalogCacheDir(): string {
    return join(this.#rootDir, "catalog-cache");
  }

  get statePath(): string {
    return join(this.#rootDir, "servers.json");
  }

  get projectRoot(): string {
    return this.#projectRoot;
  }

  get eventsPath(): string {
    return join(this.#rootDir, "events.jsonl");
  }

  setProjectRoot(projectRoot: string): void {
    this.#projectRoot = resolve(projectRoot);
  }

  listServers(): McpServerConfig[] {
    const local = this.#readState().servers.map((server) => ({ ...server }));
    const byId = new Map(local.map((server) => [server.id, server]));
    for (const server of projectServers(this.#projectRoot)) {
      if (!byId.has(server.id)) byId.set(server.id, server);
    }
    return [...byId.values()];
  }

  getServer(id: string): McpServerConfig | null {
    return this.listServers().find((server) => server.id === id || server.name === id) ?? null;
  }

  addServer(input: Omit<McpServerConfig, "id"> & { id?: string }): McpServerConfig {
    const server: McpServerConfig = {
      ...input,
      id: idFromName(input.id ?? input.name),
      source: input.source ?? "local",
    };
    const state = this.#readState();
    state.servers = state.servers.filter((existing) => existing.id !== server.id);
    state.servers.push(server);
    state.updatedAt = this.#now();
    this.#writeState(state);
    return server;
  }

  updateServer(id: string, patch: Partial<McpServerConfig>): McpServerConfig {
    const state = this.#readState();
    const index = state.servers.findIndex((server) => server.id === id || server.name === id);
    if (index < 0) throw new Error(`MCP server not found: ${id}`);
    const current = state.servers[index]!;
    const next: McpServerConfig = { ...current, ...patch, id: current.id };
    state.servers[index] = next;
    state.updatedAt = this.#now();
    this.#writeState(state);
    return next;
  }

  removeServer(id: string): boolean {
    const state = this.#readState();
    const before = state.servers.length;
    state.servers = state.servers.filter((server) => server.id !== id && server.name !== id);
    if (state.servers.length === before) return false;
    state.updatedAt = this.#now();
    this.#writeState(state);
    return true;
  }

  enableServer(id: string): McpServerConfig {
    const discovered = this.getServer(id);
    if (!discovered) throw new Error(`MCP server not found: ${id}`);
    if (discovered.source === "project") {
      const input: Omit<McpServerConfig, "id"> & { id?: string } = {
        ...discovered,
        enabled: true,
        trust: "trusted",
        source: "imported",
      };
      if (discovered.sourcePath !== undefined) input.sourcePath = discovered.sourcePath;
      return this.addServer(input);
    }
    return this.updateServer(discovered.id, { enabled: true, trust: "trusted" });
  }

  disableServer(id: string): McpServerConfig {
    const server = this.getServer(id);
    if (!server) throw new Error(`MCP server not found: ${id}`);
    return this.updateServer(server.id, { enabled: false });
  }

  listCatalog(): McpCatalogEntry[] {
    return this.#mergedCatalog(this.#readState().catalog);
  }

  addCatalogEntry(entry: McpCatalogEntry): McpCatalogEntry {
    const state = this.#readState();
    state.catalog = state.catalog.filter((item) => item.id !== entry.id);
    state.catalog.push(entry);
    state.updatedAt = this.#now();
    this.#writeState(state);
    return entry;
  }

  appendEvent(input: Omit<McpEvent, "seq" | "timestamp">): McpEvent {
    const event: McpEvent = {
      ...input,
      seq: this.#nextSeq(),
      timestamp: this.#now(),
    };
    mkdirSync(dirname(this.eventsPath), { recursive: true });
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`);
    return event;
  }

  listEvents(afterSeq = 0): McpEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    return readFileSync(this.eventsPath, "utf-8")
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as McpEvent)
      .filter((event) => event.seq > afterSeq);
  }

  writeToolCache(serverId: string, tools: McpToolMetadata[]): void {
    atomicWriteJson(join(this.cacheDir, `${serverId}.tools.json`), {
      updatedAt: this.#now(),
      tools,
    });
  }

  readToolCache(serverId: string): { updatedAt: string; tools: McpToolMetadata[] } | null {
    const path = join(this.cacheDir, `${serverId}.tools.json`);
    if (!existsSync(path)) return null;
    return readJson(path, null);
  }

  cacheAgeMs(serverId: string): number | undefined {
    const path = join(this.cacheDir, `${serverId}.tools.json`);
    if (!existsSync(path)) return undefined;
    return Date.now() - statSync(path).mtimeMs;
  }

  listCacheFiles(): string[] {
    if (!existsSync(this.cacheDir)) return [];
    return readdirSync(this.cacheDir).filter((name) => name.endsWith(".tools.json"));
  }

  #readState(): StoreState {
    const raw = readJson<StoreState>(this.statePath, DEFAULT_STATE);
    return {
      version: 1,
      servers: Array.isArray(raw.servers) ? raw.servers.map((server) => normalizeServer(server)).filter((server): server is McpServerConfig => !!server) : [],
      catalog: Array.isArray(raw.catalog) ? raw.catalog : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : this.#now(),
    };
  }

  #mergedCatalog(catalog: McpCatalogEntry[]): McpCatalogEntry[] {
    const byId = new Map<string, McpCatalogEntry>();
    for (const entry of BUILTIN_CATALOG) byId.set(entry.id, cloneCatalogEntry(entry));
    for (const entry of catalog) byId.set(entry.id, cloneCatalogEntry(entry));
    return [...byId.values()];
  }

  #writeState(state: StoreState): void {
    atomicWriteJson(this.statePath, state);
  }
}
