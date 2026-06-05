import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  BUILTIN_EXTENSION_REGISTRY,
  OFFICIAL_EXTENSION_REGISTRY_SCHEMA,
} from "./official-registry.js";
import type {
  ExtensionEventRecord,
  ExtensionInstallInput,
  ExtensionInstallResult,
  ExtensionLockRecord,
  ExtensionRegistryEntry,
  ExtensionRegistrySource,
  ExtensionRegistrySourceKind,
  ExtensionRisk,
  ExtensionTrust,
} from "./types.js";

type SourcesState = {
  version: 1;
  sources: ExtensionRegistrySource[];
  updatedAt: string;
};

type LockState = {
  version: 1;
  records: ExtensionLockRecord[];
  updatedAt: string;
};

type RegistryDocument = {
  schema?: string;
  entries?: ExtensionRegistryEntry[];
};

export type ExtensionRegistryStoreOptions = {
  rootDir: string;
  nextSeq: () => number;
  now: () => string;
};

export type AddExtensionRegistrySourceInput = {
  kind: Exclude<ExtensionRegistrySourceKind, "builtin">;
  name: string;
  url?: string;
  path?: string;
  trust?: ExtensionTrust;
  trustUnsigned?: boolean;
  enabled?: boolean;
};

const DEFAULT_SOURCES: SourcesState = {
  version: 1,
  sources: [],
  updatedAt: new Date(0).toISOString(),
};

const DEFAULT_LOCK: LockState = {
  version: 1,
  records: [],
  updatedAt: new Date(0).toISOString(),
};

export class ExtensionRegistryStore {
  #rootDir: string;
  #nextSeq: () => number;
  #now: () => string;
  #diagnostics: string[] = [];

  constructor(options: ExtensionRegistryStoreOptions) {
    this.#rootDir = options.rootDir;
    this.#nextSeq = options.nextSeq;
    this.#now = options.now;
    mkdirSync(this.#rootDir, { recursive: true });
    mkdirSync(this.cacheDir, { recursive: true });
  }

  get rootDir(): string {
    return this.#rootDir;
  }

  get cacheDir(): string {
    return join(this.#rootDir, "registry-cache");
  }

  get sourcesPath(): string {
    return join(this.#rootDir, "sources.json");
  }

  get lockPath(): string {
    return join(this.#rootDir, "lock.json");
  }

  get eventsPath(): string {
    return join(this.#rootDir, "events.jsonl");
  }

  listSources(): ExtensionRegistrySource[] {
    return [
      {
        id: "forge-builtin",
        kind: "builtin",
        name: "ForgeAgent built-in registry snapshot",
        enabled: true,
        trust: "official",
        addedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      ...this.#readSources().sources.map((source) => ({ ...source })),
    ];
  }

  listRegistryEntries(): ExtensionRegistryEntry[] {
    const diagnostics: string[] = [];
    const entries = BUILTIN_EXTENSION_REGISTRY.map((entry) => cloneRegistryEntry({
      ...entry,
      registrySourceId: entry.registrySourceId ?? "forge-builtin",
    }));
    for (const source of this.#readSources().sources) {
      if (!source.enabled) continue;
      const result = this.#readSourceEntries(source);
      if (result.diagnostic) diagnostics.push(result.diagnostic);
      entries.push(...result.entries.map((entry) => cloneRegistryEntry({
        ...entry,
        registrySourceId: source.id,
        sourceLabel: entry.sourceLabel || source.name,
        trust: entry.trust ?? source.trust,
      })));
    }
    this.#diagnostics = diagnostics;
    const byId = new Map<string, ExtensionRegistryEntry>();
    for (const entry of entries) byId.set(entry.id, entry);
    return [...byId.values()];
  }

  getDiagnostics(): string[] {
    return [...this.#diagnostics];
  }

  listLocks(): ExtensionLockRecord[] {
    return this.#readLock().records.map((record) => cloneLock(record));
  }

  getLock(id: string): ExtensionLockRecord | undefined {
    return this.listLocks().find((record) => record.id === id || record.name === id);
  }

  recordInstall(input: {
    entry?: ExtensionRegistryEntry;
    installInput: ExtensionInstallInput;
    result: ExtensionInstallResult;
    bundleParent?: string;
  }): ExtensionLockRecord {
    const now = this.#now();
    const entry = input.entry;
    const record: ExtensionLockRecord = {
      id: entry?.id ?? `${input.result.kind}:${input.result.id}`,
      kind: input.result.kind,
      name: input.result.name,
      ...(entry?.version !== undefined ? { version: entry.version } : {}),
      source: entry?.source ?? input.result.id,
      sourceLabel: entry?.sourceLabel ?? "Manual install",
      trust: entry?.trust ?? trustFromResult(input.result),
      risk: entry?.risk ?? "caution",
      installedAt: now,
      ...(input.result.status === "active" ? { enabledAt: now } : {}),
      status: input.result.status,
      installInput: input.installInput,
      resultId: input.result.id,
      ...(input.result.scan ? { scanVerdict: input.result.scan.verdict } : {}),
      ...(input.bundleParent !== undefined ? { bundleParent: input.bundleParent } : {}),
      ...(entry?.provenance !== undefined ? { provenance: entry.provenance } : {}),
    };
    const state = this.#readLock();
    state.records = state.records.filter((existing) => existing.id !== record.id && existing.resultId !== record.resultId);
    state.records.push(record);
    state.updatedAt = now;
    this.#writeLock(state);
    this.appendEvent({
      detail: input.result.status === "active" ? "enabled" : "installed",
      extensionId: record.id,
      kind: record.kind,
      message: `${input.result.message}`,
      payload: { resultId: input.result.id, status: input.result.status },
    });
    return cloneLock(record);
  }

  markEnabled(input: { kind: ExtensionLockRecord["kind"]; idOrName: string; result: ExtensionInstallResult }): void {
    const state = this.#readLock();
    const found = state.records.find((record) => (
      record.id === input.idOrName ||
      record.resultId === input.idOrName ||
      record.name === input.idOrName ||
      record.name === input.result.name
    ));
    if (found) {
      found.status = input.result.status;
      found.enabledAt = this.#now();
      state.updatedAt = this.#now();
      this.#writeLock(state);
    }
    this.appendEvent({
      detail: "enabled",
      extensionId: found?.id ?? `${input.kind}:${input.idOrName}`,
      kind: input.kind,
      message: input.result.message,
      payload: { resultId: input.result.id, status: input.result.status },
    });
  }

  addSource(input: AddExtensionRegistrySourceInput): ExtensionRegistrySource {
    if (!input.name.trim()) throw new Error("Extension registry source name is required.");
    if (input.kind === "file" && !input.path) throw new Error("File registry source requires path.");
    if ((input.kind === "http" || input.kind === "github") && !input.url) {
      throw new Error(`${input.kind} registry source requires url.`);
    }
    const source: ExtensionRegistrySource = {
      id: idFromSource(input.name),
      kind: input.kind,
      name: input.name.trim(),
      enabled: input.enabled !== false,
      trust: input.trust ?? (input.trustUnsigned ? "community" : "trusted"),
      addedAt: this.#now(),
      updatedAt: this.#now(),
      ...(input.url ? { url: input.url } : {}),
      ...(input.path ? { path: resolve(input.path) } : {}),
      ...(input.trustUnsigned !== undefined ? { trustUnsigned: input.trustUnsigned } : {}),
    };
    const state = this.#readSources();
    state.sources = state.sources.filter((existing) => existing.id !== source.id);
    state.sources.push(source);
    state.updatedAt = this.#now();
    this.#writeSources(state);
    this.appendEvent({
      detail: "source_added",
      sourceId: source.id,
      message: `Extension registry source added: ${source.name}`,
    });
    return { ...source };
  }

  removeSource(id: string): boolean {
    const state = this.#readSources();
    const source = state.sources.find((candidate) => candidate.id === id);
    const before = state.sources.length;
    state.sources = state.sources.filter((candidate) => candidate.id !== id);
    if (state.sources.length === before) return false;
    state.updatedAt = this.#now();
    this.#writeSources(state);
    rmSync(this.#cachePath(id), { force: true });
    this.appendEvent({
      detail: "source_removed",
      sourceId: id,
      message: `Extension registry source removed: ${source?.name ?? id}`,
    });
    return true;
  }

  async refreshSource(id: string): Promise<ExtensionRegistrySource> {
    const state = this.#readSources();
    const index = state.sources.findIndex((source) => source.id === id);
    if (index < 0) throw new Error(`Extension registry source not found: ${id}`);
    const source = state.sources[index]!;
    try {
      const document = source.kind === "file"
        ? readRegistryDocumentFromFile(source.path ?? "")
        : await readRegistryDocumentFromUrl(source.url ?? "");
      validateRegistryDocument(document, source.name);
      atomicWriteJson(this.#cachePath(source.id), document);
      const next: ExtensionRegistrySource = {
        ...source,
        lastRefreshAt: this.#now(),
        updatedAt: this.#now(),
      };
      delete next.lastError;
      state.sources[index] = next;
      state.updatedAt = this.#now();
      this.#writeSources(state);
      this.appendEvent({
        detail: "source_refreshed",
        sourceId: source.id,
        message: `Extension registry source refreshed: ${source.name}`,
      });
      return { ...next };
    } catch (err) {
      const next: ExtensionRegistrySource = {
        ...source,
        lastError: err instanceof Error ? err.message : String(err),
        updatedAt: this.#now(),
      };
      state.sources[index] = next;
      state.updatedAt = this.#now();
      this.#writeSources(state);
      this.appendEvent({
        detail: "failed",
        sourceId: source.id,
        message: `Extension registry source refresh failed: ${source.name}. ${next.lastError}`,
      });
      return { ...next };
    }
  }

  appendEvent(input: Omit<ExtensionEventRecord, "seq" | "timestamp">): ExtensionEventRecord {
    const event: ExtensionEventRecord = {
      ...input,
      seq: this.#nextSeq(),
      timestamp: this.#now(),
    };
    mkdirSync(dirname(this.eventsPath), { recursive: true });
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`);
    return event;
  }

  listEvents(afterSeq = 0): ExtensionEventRecord[] {
    if (!existsSync(this.eventsPath)) return [];
    return readFileSync(this.eventsPath, "utf-8")
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ExtensionEventRecord)
      .filter((event) => event.seq > afterSeq);
  }

  #readSourceEntries(source: ExtensionRegistrySource): { entries: ExtensionRegistryEntry[]; diagnostic?: string } {
    try {
      const document = source.kind === "file"
        ? readRegistryDocumentFromFile(source.path ?? "")
        : readRegistryDocumentFromFile(this.#cachePath(source.id));
      validateRegistryDocument(document, source.name);
      return { entries: document.entries ?? [] };
    } catch (err) {
      return {
        entries: [],
        diagnostic: `Extension registry source ${source.name} is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  #readSources(): SourcesState {
    const raw = readJson<SourcesState>(this.sourcesPath, DEFAULT_SOURCES);
    return {
      version: 1,
      sources: Array.isArray(raw.sources) ? raw.sources.map(normalizeSource).filter((source): source is ExtensionRegistrySource => !!source) : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : this.#now(),
    };
  }

  #writeSources(state: SourcesState): void {
    atomicWriteJson(this.sourcesPath, state);
  }

  #readLock(): LockState {
    const raw = readJson<LockState>(this.lockPath, DEFAULT_LOCK);
    return {
      version: 1,
      records: Array.isArray(raw.records) ? raw.records.map(normalizeLock).filter((record): record is ExtensionLockRecord => !!record) : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : this.#now(),
    };
  }

  #writeLock(state: LockState): void {
    atomicWriteJson(this.lockPath, state);
  }

  #cachePath(sourceId: string): string {
    return join(this.cacheDir, `${sourceId}.json`);
  }
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

function readRegistryDocumentFromFile(filePath: string): RegistryDocument {
  if (!filePath) throw new Error("missing registry path");
  return JSON.parse(readFileSync(resolve(filePath), "utf-8")) as RegistryDocument;
}

async function readRegistryDocumentFromUrl(url: string): Promise<RegistryDocument> {
  if (!url) throw new Error("missing registry url");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`unsupported registry URL protocol: ${parsed.protocol}`);
  }
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`registry download failed: ${response.status} ${response.statusText}`);
  return await response.json() as RegistryDocument;
}

function validateRegistryDocument(document: RegistryDocument, sourceName: string): void {
  if (document.schema !== undefined && document.schema !== OFFICIAL_EXTENSION_REGISTRY_SCHEMA) {
    throw new Error(`unsupported registry schema for ${sourceName}: ${document.schema}`);
  }
  if (!Array.isArray(document.entries)) {
    throw new Error(`registry ${sourceName} does not contain entries[]`);
  }
  for (const entry of document.entries) validateRegistryEntry(entry, sourceName);
}

function validateRegistryEntry(entry: ExtensionRegistryEntry, sourceName: string): void {
  if (!entry || typeof entry !== "object") throw new Error(`invalid registry entry in ${sourceName}`);
  if (!entry.id || !entry.name || !entry.title || !entry.description) {
    throw new Error(`registry entry in ${sourceName} is missing id/name/title/description`);
  }
  if (!entry.source || entry.source.includes("mock")) {
    throw new Error(`registry entry ${entry.id} has invalid source`);
  }
  if (!entry.installInput || typeof entry.installInput !== "object") {
    throw new Error(`registry entry ${entry.id} is missing installInput`);
  }
  if (entry.kind === "mcp_server" && entry.installInput.kind === "mcp_catalog" && entry.installInput.catalogId.includes("server-fetch")) {
    throw new Error("server-fetch is not present in the built-in MCP package set");
  }
}

function normalizeSource(raw: unknown): ExtensionRegistrySource | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "file" && kind !== "http" && kind !== "github") return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const id = typeof record.id === "string" && record.id.trim() ? idFromSource(record.id) : idFromSource(name);
  if (!name || !id) return null;
  return {
    id,
    kind,
    name,
    enabled: record.enabled !== false,
    trust: normalizeTrust(record.trust),
    addedAt: typeof record.addedAt === "string" ? record.addedAt : new Date(0).toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.trustUnsigned === "boolean" ? { trustUnsigned: record.trustUnsigned } : {}),
    ...(typeof record.lastRefreshAt === "string" ? { lastRefreshAt: record.lastRefreshAt } : {}),
    ...(typeof record.lastError === "string" ? { lastError: record.lastError } : {}),
  };
}

function normalizeLock(raw: unknown): ExtensionLockRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as ExtensionLockRecord;
  if (!record.id || !record.kind || !record.name || !record.installedAt || !record.resultId) return null;
  return cloneLock(record);
}

function normalizeTrust(raw: unknown): ExtensionTrust {
  if (
    raw === "official" ||
    raw === "curated" ||
    raw === "trusted" ||
    raw === "community" ||
    raw === "untrusted" ||
    raw === "quarantined" ||
    raw === "local"
  ) return raw;
  return "community";
}

function idFromSource(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "registry-source";
}

function trustFromResult(result: ExtensionInstallResult): ExtensionTrust {
  if (result.status === "quarantined") return "quarantined";
  if (result.kind === "skill") return "community";
  return "untrusted";
}

function cloneRegistryEntry(entry: ExtensionRegistryEntry): ExtensionRegistryEntry {
  return JSON.parse(JSON.stringify(entry)) as ExtensionRegistryEntry;
}

function cloneLock(record: ExtensionLockRecord): ExtensionLockRecord {
  return JSON.parse(JSON.stringify(record)) as ExtensionLockRecord;
}

export function registryDocument(entries: ExtensionRegistryEntry[]): RegistryDocument {
  return {
    schema: OFFICIAL_EXTENSION_REGISTRY_SCHEMA,
    entries,
  };
}
