import { readdirSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type {
  BranchEvent,
  ContextUsageEvent,
  PermissionRequestEvent,
  PermissionResponseEvent,
  RuntimeEvent,
  McpElicitationRequestEvent,
  McpElicitationResponseEvent,
  Session,
  SessionBranch,
  SessionEvent,
  SystemEvent,
  ToolCall,
  ToolResult,
  UsageEvent,
  UserMessage,
} from "../streams/event-types.js";
import { SessionThreadStore } from "../streams/session-thread-store.js";
import { transition, SessionSupervisor } from "./session-supervisor.js";
import { AgentLoop } from "../agent/agent-loop.js";
import type { TurnResult } from "../agent/agent-loop.js";
import type {
  ModelMessage,
  ModelPricing,
  ModelProvider,
  ModelProviderMetadata,
  ModelResponse,
  ModelUsage,
} from "../agent/model-provider.js";
import type { ToolExecutor } from "../agent/tool-executor.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { ToolRuntime } from "../tools/tool-runtime.js";
import { RuntimeManager } from "./runtime-manager.js";
import type { RuntimeRehydrateReport } from "./runtime-manager.js";
import type { RuntimeStatus } from "../runtimes/runtime-status.js";
import type { BrowserRuntime } from "../runtimes/browser/browser-runtime.js";
import type { BrowserToolRuntime } from "../tools/built-in/browser-shared.js";
import { WebridgeRuntime } from "../runtimes/webridge/webridge-runtime.js";
import { NotificationHub } from "./notification-hub.js";
import type {
  SessionEventCallback,
  SystemEventCallback,
  SessionListCallback,
  Unsubscribe,
} from "./notification-hub.js";
import { SystemStreamStore } from "../streams/system-stream-store.js";
import { Scheduler } from "./scheduler.js";
import type { Trigger } from "./scheduler.js";
import type { SkillCatalog } from "../skills/skill-catalog.js";
import { SkillCatalog as SkillCatalogClass } from "../skills/skill-catalog.js";
import { SkillStore } from "../skills/skill-store.js";
import type { InstallSkillInput } from "../skills/skill-store.js";
import { SkillEvolutionManager } from "../skills/skill-evolution-manager.js";
import type {
  SkillEvolutionManagerStatus,
  SkillMaintenanceReport,
} from "../skills/skill-evolution-manager.js";
import type {
  SkillEventRecord,
  SkillManifest,
  SkillRenderContext,
  SkillSource,
  SkillStatusSummary,
} from "../skills/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import { MemoryManager } from "../memory/memory-manager.js";
import type { MemoryMaintenanceReport, MemoryManagerStatus } from "../memory/memory-manager.js";
import { buildSystemPrompt } from "../agent/system-prompt-builder.js";
import { registerBuiltInTools } from "../tools/built-in/index.js";
import { setMemoryStoreForTools } from "../tools/built-in/memory-shared.js";
import { setSchedulerForTools } from "../tools/built-in/scheduler-shared.js";
import { setArtifactStoreForTools } from "../tools/built-in/artifact-shared.js";
import {
  setBrowserRuntimeForTools,
  setDefaultBrowserRuntimeForTools,
} from "../tools/built-in/browser-shared.js";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import type { ArtifactInfo } from "../artifacts/artifact-store.js";
import { PermissionBroker } from "../permissions/tool-policy.js";
import type {
  PermissionResponseDecision,
  PublicPermissionRequest,
  ToolPolicyRule,
  ToolRequestSource,
} from "../permissions/tool-policy.js";
import { PathSandbox } from "../sandbox/path-sandbox.js";
import { UsageLedger, inferCacheMiss, usageCost } from "../usage/usage-ledger.js";
import type { SessionUsageSummary, UsageRecord } from "../usage/usage-ledger.js";
import { McpRuntimeManager } from "../mcp/runtime-manager.js";
import { ProjectStore } from "../projects/project-store.js";
import type { CreateProjectInput, Project, ProjectTrustState } from "../projects/project-store.js";
import { ExtensionManager } from "../extensions/extension-manager.js";
import { ExtensionRegistryStore, type AddExtensionRegistrySourceInput } from "../extensions/registry-store.js";
import type {
  ExtensionCandidate,
  ExtensionEventRecord,
  ExtensionInstallInput,
  ExtensionInstallResult,
  ExtensionRegistrySource,
  ExtensionStatus,
} from "../extensions/types.js";
import { setExtensionManagerForTools } from "../tools/built-in/extension-shared.js";
import type {
  McpCatalogEntry,
  McpElicitationPublicRequest,
  McpEvent,
  McpServerConfig,
  McpServerStatus,
  McpStatusSummary,
  McpToolMetadata,
} from "../mcp/types.js";
import { createLogger } from "./logger.js";

const logger = createLogger("core-api");
const INTERRUPTED_TOOL_RESULT = "Interrupted by user before tool completed.";
const PROCESS_RESTART_TOOL_RESULT = "Process restarted before this tool completed.";
const MAIN_BRANCH_ID = "main";

let nextSeq = 1;

function makeId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function isAutoTitleCandidate(title: string, firstUserText: string): boolean {
  const trimmed = title.trim();
  const normalized = trimmed.toLowerCase();
  if (["new session", "new conversation", "untitled", "新会话"].includes(normalized)) {
    return true;
  }
  const text = firstUserText.trim();
  if (!text) return false;
  const prefix = text.length > 32 ? `${text.slice(0, 32)}…` : text;
  return trimmed === prefix || trimmed === `${text.slice(0, 32)}...`;
}

function sanitizeGeneratedTitle(text: string): string | null {
  let title = text
    .trim()
    .replace(/^```(?:text)?/i, "")
    .replace(/```$/i, "")
    .trim()
    .replace(/^title\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return null;
  if (title.length > 60) title = `${title.slice(0, 57).trim()}...`;
  return title || null;
}

function estimateTokensFromMessages(messages: ModelMessage[]): number {
  return Math.max(1, Math.ceil(JSON.stringify(messages).length / 4));
}

function totalTokens(usage: ModelUsage): number {
  return usage.total_tokens ?? usage.input_tokens + usage.output_tokens;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return "n/a";
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatCost(value: number | undefined, currency: string | undefined): string {
  if (value === undefined) return "";
  return ` · ${currency ?? ""}${value.toFixed(4)}`;
}

function collectPathValues(value: unknown, out: string[]): void {
  if (out.length >= 80) return;
  if (typeof value === "string") {
    if (
      value.includes("/") &&
      !value.startsWith("http://") &&
      !value.startsWith("https://")
    ) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValues(item, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectPathValues(item, out);
  }
}

export { TurnResult };

export type DispatchTurnResult =
  | "queued"
  | "already_active"
  | "already_queued"
  | "not_runnable"
  | "missing"
  | "started_without_supervisor";

export type AppendUserMessageOptions = {
  dispatch?: boolean;
  source?: ToolRequestSource;
  branchId?: string;
};

export type CreateSessionOptions = {
  projectId?: string;
};

export type ToolPolicyOptions = {
  timeoutMs?: number;
  rules?: ToolPolicyRule[];
  projectRoot?: string;
};

export type StartupRehydrateReport = {
  repairedToolResults: number;
  requeuedSessions: string[];
  startupBlockedSessions: string[];
  dispatchResults: Record<string, DispatchTurnResult>;
  triggerSyncedSessions: string[];
  runtimeAttachmentsRestored: number;
  runtimeAttachmentsFailed: number;
  runtimeBlockedSessions: number;
  runtimeRecoveredSessions: string[];
  mcpServers?: number;
  mcpToolsProjected?: number;
  memoryMaintenance?: MemoryMaintenanceReport;
};

export type RehydrateAfterStartupOptions = {
  dispatchRunning?: boolean;
};

export type HtmlFilePreview = {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
};

export type UploadedSessionFile = {
  name: string;
  path: string;
  sizeBytes: number;
  mimeType: string;
};

export type BranchVariant = {
  branchId: string;
  userMessageSeq: number;
  sourceSeq: number;
  textPreview: string;
  createdAt: string;
};

export type BranchVariantGroup = {
  sourceSeq: number;
  variants: BranchVariant[];
};

export type SessionBranchState = {
  activeBranchId: string;
  branches: SessionBranch[];
  variantGroups: BranchVariantGroup[];
};

export type CreateMessageVariantOptions = {
  sourceSeq: number;
  replacementText: string;
  dispatch?: boolean;
  source?: ToolRequestSource;
};

const HTML_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function sanitizeUploadFileName(name: string): string {
  const fallback = "upload.bin";
  const base = basename(name || fallback)
    .replace(/[^\w .@()+,\-=]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const clean = base || fallback;
  return clean.length > 160 ? clean.slice(-160) : clean;
}

function eventBranchId(event: SessionEvent): string {
  return event.branchId ?? MAIN_BRANCH_ID;
}

function textPreview(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trim()}…`;
}

function branchTitleForVariant(index: number): string {
  return index === 0 ? "Original" : `Edit ${index + 1}`;
}

export class CoreAPI {
  #sessions = new Map<string, Session>();
  #threadStore = new SessionThreadStore();
  #modelProvider?: ModelProvider;
  #toolExecutor?: ToolExecutor;
  #toolRegistry?: ToolRegistry;
  #runtimeManager?: RuntimeManager;
  #scheduler?: Scheduler;
  #supervisor?: SessionSupervisor;
  #skillCatalog?: SkillCatalog;
  #skillStore: SkillStore | undefined;
  #skillEvolutionManager: SkillEvolutionManager | undefined;
  #memoryStore: MemoryStore;
  #memoryManager?: MemoryManager;
  #notificationHub = new NotificationHub();
  #systemStreamStore = new SystemStreamStore();
  #dataDir: string;
  #artifactStore: ArtifactStore;
  #usageLedger: UsageLedger;
  #artifactMaxResultSizeChars: number | undefined;
  #artifactPreviewBytes: number | undefined;
  #artifactPerTurnBudgetChars: number | undefined;
  #maxContextTokens: number | undefined;
  #contextWindowTokens: number | undefined;
  #pricing: ModelPricing | undefined;
  #autoCompactBuffer: number | undefined;
  #compactionKeepRecentTokens: number | undefined;
  #turnControllers = new Map<string, AbortController>();
  #turnStarts = new Map<string, number>();
  #turnEventCursors = new Map<string, number>();
  #turnSources = new Map<string, ToolRequestSource>();
  #permissionBroker?: PermissionBroker;
  #policyProjectRoot: string;
  #projectStore: ProjectStore;
  #webridgeRuntime?: WebridgeRuntime;
  #mcpManager?: McpRuntimeManager;
  #extensionManager?: ExtensionManager;
  #extensionRegistryStore?: ExtensionRegistryStore;

  constructor(toolRegistry?: ToolRegistry, options?: {
    dataDir?: string;
    artifactDir?: string;
    artifactMaxResultSizeChars?: number;
    artifactPreviewBytes?: number;
    artifactPerTurnBudgetChars?: number;
    maxContextTokens?: number;
    contextWindowTokens?: number;
    autoCompactBuffer?: number;
    compactionKeepRecentTokens?: number;
    usageDir?: string;
    pricing?: ModelPricing;
    memoryDir?: string;
    skillDir?: string;
    skillPromptBudgetTokens?: number;
    mcpDir?: string;
    projectDir?: string;
  }) {
    this.#dataDir = options?.dataDir ?? ".forge";
    this.#artifactStore = new ArtifactStore(options?.artifactDir ?? join(this.#dataDir, "artifacts"));
    this.#usageLedger = new UsageLedger(options?.usageDir ?? join(this.#dataDir, "usage"));
    this.#memoryStore = new MemoryStore(options?.memoryDir ?? join(this.#dataDir, "memory"));
    this.#artifactMaxResultSizeChars = options?.artifactMaxResultSizeChars;
    this.#artifactPreviewBytes = options?.artifactPreviewBytes;
    this.#artifactPerTurnBudgetChars = options?.artifactPerTurnBudgetChars;
    this.#maxContextTokens = options?.maxContextTokens;
    this.#contextWindowTokens = options?.contextWindowTokens;
    this.#pricing = options?.pricing;
    this.#autoCompactBuffer = options?.autoCompactBuffer;
    this.#compactionKeepRecentTokens = options?.compactionKeepRecentTokens;
    this.#policyProjectRoot = resolve(process.cwd());
    this.#projectStore = new ProjectStore(options?.projectDir ?? join(this.#dataDir, "projects"));
    setArtifactStoreForTools(this.#artifactStore);
    setMemoryStoreForTools(this.#memoryStore);
    if (toolRegistry) {
      this.#toolRegistry = toolRegistry;
      this.#toolExecutor = new ToolRuntime(toolRegistry);
    }
    if (options?.skillDir || options?.skillPromptBudgetTokens !== undefined) {
      const skillOptions: Parameters<CoreAPI["initSkillEcosystem"]>[0] = {
        autoRun: false,
      };
      if (options.skillDir !== undefined) skillOptions.rootDir = options.skillDir;
      if (options.skillPromptBudgetTokens !== undefined) {
        skillOptions.promptBudgetTokens = options.skillPromptBudgetTokens;
      }
      this.initSkillEcosystem(skillOptions);
    }
    if (options?.mcpDir) {
      this.initMcpEcosystem({ rootDir: options.mcpDir });
    }
  }

  setSkillCatalog(catalog: SkillCatalog): void {
    this.#skillCatalog = catalog;
    this.#skillStore = catalog.store;
  }

  initSkillEcosystem(options?: {
    rootDir?: string;
    promptBudgetTokens?: number;
    autoRun?: boolean;
    proposalThreshold?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterMs?: number;
    replace?: boolean;
  }): SkillStore {
    if (this.#skillStore && !options?.replace) return this.#skillStore;
    const storeOptions: ConstructorParameters<typeof SkillStore>[0] = {
      rootDir: options?.rootDir ?? join(this.#dataDir, "skills"),
      projectRoot: this.#policyProjectRoot,
      nextSeq: () => nextSeq++,
      now: () => now(),
      onEvent: (event) => {
        this.#appendSystemEvent("skill_lifecycle", event.action, event.message);
      },
    };
    if (options?.promptBudgetTokens !== undefined) {
      storeOptions.promptBudgetTokens = options.promptBudgetTokens;
    }
    const store = new SkillStore(storeOptions);
    this.#skillStore = store;
    this.#skillCatalog = SkillCatalogClass.fromStore(store);
    const managerOptions: ConstructorParameters<typeof SkillEvolutionManager>[0] = {
      store,
      modelProvider: () => this.#modelProvider,
      appendRuntimeEvent: (sessionId, detail, message) => {
        this.#appendSkillRuntimeEvent(sessionId, detail, message);
      },
      appendSystemEvent: (detail, message) => {
        this.#appendSystemEvent("skill_lifecycle", detail, message);
      },
    };
    if (options?.autoRun !== undefined) managerOptions.autoRun = options.autoRun;
    if (options?.proposalThreshold !== undefined) managerOptions.proposalThreshold = options.proposalThreshold;
    if (options?.baseDelayMs !== undefined) managerOptions.baseDelayMs = options.baseDelayMs;
    if (options?.maxDelayMs !== undefined) managerOptions.maxDelayMs = options.maxDelayMs;
    if (options?.jitterMs !== undefined) managerOptions.jitterMs = options.jitterMs;
    this.#skillEvolutionManager = new SkillEvolutionManager(managerOptions);
    return store;
  }

  getSkills(filter?: { includeInactive?: boolean; status?: SkillManifest["status"] }): SkillManifest[] {
    return this.#skillStore?.list(filter) ?? [];
  }

  getSkill(name: string): SkillManifest | null {
    return this.#skillStore?.get(name) ?? null;
  }

  async installSkill(input: InstallSkillInput): Promise<Awaited<ReturnType<SkillStore["install"]>>> {
    return await this.initSkillEcosystem().install(input);
  }

  async installExternalSkill(input: Parameters<SkillStore["installExternalPackage"]>[0]): Promise<Awaited<ReturnType<SkillStore["installExternalPackage"]>>> {
    return this.initSkillEcosystem().installExternalPackage(input);
  }

  enableSkill(name: string, version?: string, options?: { trustWarnings?: boolean }): SkillManifest {
    return this.initSkillEcosystem().enable(name, version, options);
  }

  disableSkill(name: string, reason?: string): SkillManifest {
    return this.initSkillEcosystem().disable(name, reason);
  }

  rollbackSkill(name: string): SkillManifest {
    return this.initSkillEcosystem().rollback(name);
  }

  getSkillSources(): SkillSource[] {
    return this.initSkillEcosystem().listSources();
  }

  addSkillSource(input: {
    id?: string;
    name: string;
    url: string;
    publicKey?: string;
    trustUnsigned?: boolean;
  }): SkillSource {
    return this.initSkillEcosystem().addSource(input);
  }

  removeSkillSource(sourceId: string): boolean {
    return this.initSkillEcosystem().removeSource(sourceId);
  }

  getSkillEvents(afterSeq = 0): SkillEventRecord[] {
    return this.initSkillEcosystem().getEvents(afterSeq);
  }

  getSkillStatus(): SkillStatusSummary {
    return this.initSkillEcosystem().getStatus();
  }

  getSkillEvolutionStatus(): SkillEvolutionManagerStatus {
    if (!this.#skillEvolutionManager) {
      return {
        state: "idle",
        queuedExtractions: 0,
        pendingProposals: 0,
      };
    }
    return this.#skillEvolutionManager.getStatus();
  }

  async runSkillMaintenance(options?: {
    force?: boolean;
    consolidate?: boolean;
    signal?: AbortSignal;
  }): Promise<SkillMaintenanceReport> {
    this.initSkillEcosystem({ autoRun: false });
    return await this.#skillEvolutionManager!.runSkillMaintenance(options);
  }

  setMemoryStore(store: MemoryStore): void {
    this.#memoryStore = store;
    setMemoryStoreForTools(store);
    if (this.#memoryManager) {
      this.initMemoryManager({ replace: true });
    }
  }

  initMemoryManager(options?: {
    replace?: boolean;
    autoRun?: boolean;
    proposalThreshold?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterMs?: number;
  }): MemoryManager {
    if (this.#memoryManager && !options?.replace) return this.#memoryManager;
    this.#memoryManager = new MemoryManager({
      store: this.#memoryStore,
      modelProvider: () => this.#modelProvider,
      proposalThreshold: options?.proposalThreshold,
      autoRun: options?.autoRun,
      baseDelayMs: options?.baseDelayMs,
      maxDelayMs: options?.maxDelayMs,
      jitterMs: options?.jitterMs,
      appendRuntimeEvent: (sessionId, detail, message) => {
        this.#appendMemoryRuntimeEvent(sessionId, detail, message);
      },
      appendSystemEvent: (detail, message) => {
        this.#appendSystemEvent("agent_lifecycle", detail, message);
      },
    });
    return this.#memoryManager;
  }

  getMemoryStatus(): MemoryManagerStatus {
    return this.#memoryManager?.getStatus() ?? {
      state: "idle",
      queuedExtractions: 0,
      pendingProposals: this.#memoryStore.listProposals("pending").length,
    };
  }

  async runMemoryMaintenance(options?: { force?: boolean; consolidate?: boolean; signal?: AbortSignal }): Promise<MemoryMaintenanceReport> {
    return await this.initMemoryManager({ autoRun: false }).runMemoryMaintenance(options);
  }

  initMcpEcosystem(options?: {
    rootDir?: string;
    projectRoot?: string;
    baseUrl?: string;
    replace?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
    giveUpAfterMs?: number;
    keepaliveMs?: number;
    failureCooldownMs?: number;
  }): McpRuntimeManager {
    if (this.#mcpManager && !options?.replace) return this.#mcpManager;
    if (!this.#toolRegistry) throw new Error("ToolRegistry not set. Pass one to the constructor first.");
    this.#mcpManager = new McpRuntimeManager({
      rootDir: options?.rootDir ?? join(this.#dataDir, "mcp"),
      projectRoot: options?.projectRoot ?? this.#policyProjectRoot,
      registry: this.#toolRegistry,
      modelProvider: () => this.#modelProvider,
      nextSeq: () => nextSeq++,
      now: () => now(),
      appendSessionEvent: (sid, event) => this.#appendMcpSessionEvent(sid, event),
      appendSystemEvent: (event) => {
        this.#systemStreamStore.append(event);
        this.#notificationHub.emitSystemEvent(event);
      },
      getRoots: (sessionId) => {
        const session = sessionId ? this.#sessions.get(sessionId) : undefined;
        const roots = [session ? this.#sessionProjectRoot(session) : this.#projectStore.getCurrentProject().path];
        if (sessionId) roots.push(join(this.#dataDir, "workspaces", `session_${sessionId}`));
        return roots;
      },
      ...(options?.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options?.baseDelayMs !== undefined ? { baseDelayMs: options.baseDelayMs } : {}),
      ...(options?.maxDelayMs !== undefined ? { maxDelayMs: options.maxDelayMs } : {}),
      ...(options?.giveUpAfterMs !== undefined ? { giveUpAfterMs: options.giveUpAfterMs } : {}),
      ...(options?.keepaliveMs !== undefined ? { keepaliveMs: options.keepaliveMs } : {}),
      ...(options?.failureCooldownMs !== undefined ? { failureCooldownMs: options.failureCooldownMs } : {}),
    });
    return this.#mcpManager;
  }

  async startMcpEcosystem(): Promise<void> {
    await this.initMcpEcosystem().start();
  }

  getMcpStatus(): McpStatusSummary {
    return this.initMcpEcosystem().getStatus();
  }

  getMcpServers(): McpServerStatus[] {
    return this.initMcpEcosystem().listServers();
  }

  getMcpTools(): McpToolMetadata[] {
    return this.initMcpEcosystem().listTools();
  }

  getMcpEvents(afterSeq = 0): McpEvent[] {
    return this.initMcpEcosystem().getEvents(afterSeq);
  }

  getMcpCatalog(): McpCatalogEntry[] {
    return this.initMcpEcosystem().listCatalog();
  }

  addMcpCatalogEntry(entry: McpCatalogEntry): McpCatalogEntry {
    return this.initMcpEcosystem().addCatalogEntry(entry);
  }

  installMcpCatalogEntry(id: string): Promise<McpServerConfig> {
    return this.initMcpEcosystem().installCatalogEntry(id);
  }

  addMcpServer(input: Omit<McpServerConfig, "id"> & { id?: string }): McpServerConfig {
    return this.initMcpEcosystem().addServer(input);
  }

  updateMcpServer(id: string, patch: Partial<McpServerConfig>): Promise<McpServerConfig> {
    return this.initMcpEcosystem().updateServer(id, patch);
  }

  removeMcpServer(id: string): Promise<boolean> {
    return this.initMcpEcosystem().removeServer(id);
  }

  enableMcpServer(id: string): Promise<McpServerConfig> {
    return this.initMcpEcosystem().enableServer(id);
  }

  disableMcpServer(id: string): Promise<McpServerConfig> {
    return this.initMcpEcosystem().disableServer(id);
  }

  retryMcpServer(id: string): Promise<McpServerStatus> {
    return this.initMcpEcosystem().retryServer(id);
  }

  startMcpOAuth(id: string): Promise<{ status: "authorized" | "redirect"; authorizationUrl?: string }> {
    return this.initMcpEcosystem().startOAuth(id);
  }

  finishMcpOAuth(id: string, code: string): Promise<{ status: "authorized" }> {
    return this.initMcpEcosystem().finishOAuth(id, code);
  }

  getMcpElicitationRequests(): McpElicitationPublicRequest[] {
    return this.initMcpEcosystem().listPendingElicitations();
  }

  respondMcpElicitation(
    id: string,
    response: { action: "accept" | "decline" | "cancel"; content?: Record<string, string | number | boolean | string[]> },
  ): McpElicitationPublicRequest {
    return this.initMcpEcosystem().respondElicitation(id, response);
  }

  initExtensionEcosystem(options?: { replace?: boolean }): ExtensionManager {
    if (this.#extensionManager && !options?.replace) return this.#extensionManager;
    if (!this.#extensionRegistryStore || options?.replace) {
      this.#extensionRegistryStore = new ExtensionRegistryStore({
        rootDir: join(this.#dataDir, "extensions"),
        nextSeq: () => nextSeq++,
        now: () => now(),
      });
    }
    const manager = new ExtensionManager({
      listSkills: (filter) => this.getSkills(filter),
      getSkillStatus: () => this.getSkillStatus(),
      listSkillSources: () => this.getSkillSources(),
      installSkill: (input) => this.installSkill(input),
      installExternalSkill: (input) => this.installExternalSkill(input),
      enableSkill: (name, version, options) => this.enableSkill(name, version, options),
      listMcpServers: () => this.getMcpServers(),
      listMcpTools: () => this.getMcpTools(),
      listMcpCatalog: () => this.getMcpCatalog(),
      addMcpCatalogEntry: (entry) => this.addMcpCatalogEntry(entry),
      installMcpCatalogEntry: (id) => this.installMcpCatalogEntry(id),
      addMcpServer: (server) => this.addMcpServer(server),
      enableMcpServer: (id) => this.enableMcpServer(id),
      registryStore: this.#extensionRegistryStore,
    });
    this.#extensionManager = manager;
    setExtensionManagerForTools(manager);
    return manager;
  }

  getExtensions(): ExtensionStatus {
    return this.initExtensionEcosystem().getStatus();
  }

  searchExtensions(options?: { query?: string; link?: string; includeInstalled?: boolean }): ExtensionCandidate[] {
    return this.initExtensionEcosystem().search(options);
  }

  installExtension(input: ExtensionInstallInput): Promise<ExtensionInstallResult> {
    return this.initExtensionEcosystem().install(input);
  }

  enableExtension(
    kind: "skill" | "mcp_server" | "bundle",
    idOrName: string,
    version?: string,
    options?: { trustWarnings?: boolean },
  ): Promise<ExtensionInstallResult> {
    return this.initExtensionEcosystem().enable(kind, idOrName, version, options);
  }

  getExtensionSources(): ExtensionRegistrySource[] {
    return this.initExtensionEcosystem().listRegistrySources();
  }

  addExtensionSource(input: AddExtensionRegistrySourceInput): ExtensionRegistrySource {
    return this.initExtensionEcosystem().addRegistrySource(input);
  }

  removeExtensionSource(id: string): boolean {
    return this.initExtensionEcosystem().removeRegistrySource(id);
  }

  refreshExtensionSource(id: string): Promise<ExtensionRegistrySource> {
    return this.initExtensionEcosystem().refreshRegistrySource(id);
  }

  getExtensionEvents(afterSeq = 0): ExtensionEventRecord[] {
    return this.initExtensionEcosystem().getEvents(afterSeq);
  }

  registerBuiltInTools(): void {
    if (!this.#toolRegistry) throw new Error("ToolRegistry not set. Pass one to the constructor first.");
    this.initExtensionEcosystem();
    registerBuiltInTools(this.#toolRegistry);
  }

  setModelProvider(provider: ModelProvider): void {
    this.#modelProvider = provider;
  }

  getModelProviderMetadata(): ModelProviderMetadata | null {
    return this.#modelProvider?.getMetadata?.() ?? null;
  }

  setToolExecutor(executor: ToolExecutor): void {
    this.#toolExecutor = executor;
  }

  initToolPolicy(options?: ToolPolicyOptions): PermissionBroker {
    this.#policyProjectRoot = resolve(options?.projectRoot ?? process.cwd());
    if (options?.projectRoot) {
      this.#projectStore.create({ path: this.#policyProjectRoot, create: true, trustState: "trusted" }, { markCurrent: true });
    }
    const brokerOptions: ConstructorParameters<typeof PermissionBroker>[0] = {
      nextSeq: () => nextSeq++,
      now: () => now(),
      appendSessionEvent: (sid, event) => this.#appendPermissionEvent(sid, event),
      appendSystemEvent: (detail, message) => this.#appendSystemEvent("agent_lifecycle", detail, message),
    };
    if (options?.timeoutMs !== undefined) brokerOptions.timeoutMs = options.timeoutMs;
    if (options?.rules !== undefined) brokerOptions.rules = options.rules;
    this.#permissionBroker = new PermissionBroker(brokerOptions);
    for (const session of this.#sessions.values()) {
      if (session.dangerouslyAllowAllTools === true) {
        this.#permissionBroker.setDangerouslyAllowAllTools(session.id, true);
      }
    }
    return this.#permissionBroker;
  }

  getPermissionRequests(filter?: { status?: "pending" }): PublicPermissionRequest[] {
    const requests = this.#permissionBroker?.getPendingRequests() ?? [];
    if (filter?.status === "pending") return requests.filter((request) => request.status === "pending");
    return requests;
  }

  respondToPermissionRequest(
    requestId: string,
    response: {
      decision: PermissionResponseDecision;
      message?: string;
      deviceId?: string;
      deviceName?: string;
    },
  ): PublicPermissionRequest {
    if (!this.#permissionBroker) throw new Error("Tool policy is not initialized.");
    return this.#permissionBroker.respondToPermissionRequest(requestId, response);
  }

  initRuntimeManager(): RuntimeManager {
    this.#runtimeManager = new RuntimeManager(
      this.#threadStore,
      this.#sessions,
      this.#notificationHub,
      this.#systemStreamStore,
      () => nextSeq++,
      () => now(),
      {
        onRecovered: (sid) => this.#dispatchOrBlock(sid),
        onBlocked: (sid) => this.#abortScheduledTurn(sid),
      },
    );
    return this.#runtimeManager;
  }

  getRuntimeStatus(name: string): RuntimeStatus | undefined {
    return this.#runtimeManager?.getStatus(name);
  }

  registerBrowserRuntime(name: string, runtime: BrowserRuntime): void {
    if (!this.#runtimeManager) throw new Error("RuntimeManager not initialized. Call initRuntimeManager() first.");
    this.#runtimeManager.registerRuntime(name, runtime);
    setBrowserRuntimeForTools(name, runtime);
  }

  registerBrowserToolRuntime(name: string, runtime: BrowserToolRuntime): void {
    setBrowserRuntimeForTools(name, runtime);
  }

  initWebridgeRuntime(options?: {
    name?: string;
    commandTimeoutMs?: number;
    staleAfterMs?: number;
    offlineAfterMs?: number;
    healthCheckIntervalMs?: number;
  }): WebridgeRuntime {
    if (this.#webridgeRuntime) return this.#webridgeRuntime;
    const name = options?.name ?? "webridge";
    const runtimeOptions: ConstructorParameters<typeof WebridgeRuntime>[0] = {
      now: () => now(),
      onHealthChange: (state, message) => {
        this.#appendSystemEvent("runtime_lifecycle", `webridge_${state}`, message);
      },
    };
    if (options?.commandTimeoutMs !== undefined) {
      runtimeOptions.commandTimeoutMs = options.commandTimeoutMs;
    }
    if (options?.staleAfterMs !== undefined) {
      runtimeOptions.staleAfterMs = options.staleAfterMs;
    }
    if (options?.offlineAfterMs !== undefined) {
      runtimeOptions.offlineAfterMs = options.offlineAfterMs;
    }
    if (options?.healthCheckIntervalMs !== undefined) {
      runtimeOptions.healthCheckIntervalMs = options.healthCheckIntervalMs;
    }
    this.#webridgeRuntime = new WebridgeRuntime(runtimeOptions);
    this.registerBrowserToolRuntime(name, this.#webridgeRuntime);
    setDefaultBrowserRuntimeForTools(name);
    return this.#webridgeRuntime;
  }

  getWebridgeRuntime(): WebridgeRuntime | null {
    return this.#webridgeRuntime ?? null;
  }

  async startRuntimes(): Promise<void> {
    if (!this.#runtimeManager) throw new Error("RuntimeManager not initialized. Call initRuntimeManager() first.");
    await this.#runtimeManager.startAll();
  }

  // ── Supervisor ──

  /**
   * Initialize the session supervisor for concurrent turn execution.
   * Must be called before dispatchTurn() will queue turns.
   * Without this, runTurn() still works in blocking mode.
   */
  initSupervisor(maxConcurrent = 4): SessionSupervisor {
    this.#supervisor = new SessionSupervisor(
      this.#sessions,
      maxConcurrent,
      async (sid) => {
        await this.#runTurnInternal(sid);
      },
    );
    return this.#supervisor;
  }

  /**
   * Dispatch a turn for non-blocking execution through the supervisor queue.
   * Falls back to blocking runTurn() if supervisor is not initialized.
   */
  dispatchTurn(sessionId: string): DispatchTurnResult {
    const session = this.#sessions.get(sessionId);
    if (!session) return "missing";
    if (session.status !== "running") {
      return "not_runnable";
    }
    if (!this.#modelProvider || !this.#toolExecutor) {
      this.#blockNotRunnableSession(sessionId);
      return "not_runnable";
    }
    const activeController = this.#turnControllers.get(sessionId);
    if (activeController && !activeController.signal.aborted) {
      return "already_active";
    }

    if (this.#supervisor) {
      if (this.#supervisor.isActive(sessionId)) return "already_active";
      if (this.#supervisor.isQueued(sessionId)) return "already_queued";
      return this.#supervisor.enqueue(sessionId) ? "queued" : "not_runnable";
    }

    // Backward compat: no supervisor → run synchronously (fire-and-forget)
    this.runTurn(sessionId).catch(() => {
      // Errors are recorded in the thread by #runTurnInternal
    });
    return "started_without_supervisor";
  }

  /**
   * Interrupt a session — bring it back to idle from any state.
   * For running sessions, abort the active turn or remove a queued turn.
   */
  interruptSession(sessionId: string): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "idle" || session.status === "archived") {
      return session; // no-op
    }

    const previousStatus = session.status;
    this.#abortScheduledTurn(sessionId);
    session.status = transition(session.status, { kind: "user_interrupt" });
    session.updatedAt = now();
    this.#saveSessionMeta(session);

    logger.info("Session interrupted", { sessionId, previousStatus });

    this.#notificationHub.emitSessionListChanged();
    return session;
  }

  /**
   * Retry a blocked session — transition back to running and dispatch a turn.
   */
  retryBlockedSession(sessionId: string): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status !== "blocked") {
      throw new Error(`Session is ${session.status}, can only retry blocked sessions`);
    }

    session.status = transition(session.status, { kind: "user_retry" });
    session.updatedAt = now();
    this.#saveSessionMeta(session);

    logger.info("Session retry requested", { sessionId });

    this.#dispatchOrBlock(sessionId);
    this.#notificationHub.emitSessionListChanged();
    return session;
  }

  // ── Scheduler ──

  initScheduler(): Scheduler {
    const persistPath = join(this.#dataDir, "triggers.json");
    const options: ConstructorParameters<typeof Scheduler>[6] = { persistPath };
    options.onWake = (sid) => {
      this.#dispatchOrBlock(sid);
      return Promise.resolve();
    };
    options.onTriggersChanged = (sid) => {
      this.#syncTriggerState(sid);
    };
    this.#scheduler = new Scheduler(
      this.#threadStore,
      this.#sessions,
      this.#notificationHub,
      this.#systemStreamStore,
      () => nextSeq++,
      () => now(),
      options,
    );

    // Load persisted triggers from disk
    const persisted = Scheduler.loadFromFile(persistPath);
    if (persisted.length > 0) {
      this.#scheduler.loadTriggers(persisted);
      for (const trigger of persisted) {
        this.#syncTriggerState(trigger.sessionId);
      }
    }

    // Wire the scheduler for cron tools
    setSchedulerForTools(this.#scheduler);

    return this.#scheduler;
  }

  scheduleTrigger(trigger: Trigger): void {
    if (!this.#scheduler) throw new Error("Scheduler not initialized. Call initScheduler() first.");
    this.#scheduler.schedule(trigger);
  }

  cancelTrigger(triggerId: string): boolean {
    if (!this.#scheduler) throw new Error("Scheduler not initialized. Call initScheduler() first.");
    return this.#scheduler.cancel(triggerId);
  }

  deleteTrigger(triggerId: string): boolean {
    if (!this.#scheduler) throw new Error("Scheduler not initialized. Call initScheduler() first.");
    return this.#scheduler.delete(triggerId);
  }

  async fireTrigger(triggerId: string): Promise<void> {
    if (!this.#scheduler) throw new Error("Scheduler not initialized. Call initScheduler() first.");
    await this.#scheduler.fire(triggerId);
  }

  listTriggers(sessionId: string): Trigger[] {
    if (!this.#scheduler) throw new Error("Scheduler not initialized. Call initScheduler() first.");
    return this.#scheduler.listTriggers(sessionId);
  }

  listAllTriggers(): Trigger[] {
    if (!this.#scheduler) throw new Error("Scheduler not initialized. Call initScheduler() first.");
    return this.#scheduler.listAllTriggers();
  }

  // ── Notification subscriptions ──

  onSessionEvent(cb: SessionEventCallback): Unsubscribe {
    return this.#notificationHub.onSessionEvent(cb);
  }

  onSystemEvent(cb: SystemEventCallback): Unsubscribe {
    return this.#notificationHub.onSystemEvent(cb);
  }

  onSessionListChanged(cb: SessionListCallback): Unsubscribe {
    return this.#notificationHub.onSessionListChanged(cb);
  }

  getSystemEvents(): SystemEvent[] {
    return this.#systemStreamStore.getEvents();
  }

  // ── Project / workspace management ──

  initProjectStore(options?: { rootDir?: string; replace?: boolean }): ProjectStore {
    if (options?.replace || options?.rootDir) {
      this.#projectStore = new ProjectStore(options.rootDir ?? join(this.#dataDir, "projects"));
    }
    return this.#projectStore;
  }

  ensureDefaultProject(): Project {
    return this.#projectStore.ensureDefaultProject();
  }

  getCurrentProject(): Project {
    return this.#projectStore.getCurrentProject();
  }

  ensureProjectForPath(path: string, options?: { name?: string; current?: boolean }): Project {
    return this.#projectStore.ensureProjectForPath(path, options);
  }

  listProjects(): Project[] {
    return this.#projectStore.list();
  }

  getProject(projectId: string): Project | null {
    return this.#projectStore.get(projectId);
  }

  createProject(input: CreateProjectInput): Project {
    const project = this.#projectStore.create(input, { markCurrent: true });
    this.#notificationHub.emitSessionListChanged();
    return project;
  }

  updateProject(
    projectId: string,
    patch: { name?: string; trustState?: ProjectTrustState },
  ): Project {
    const project = this.#projectStore.update(projectId, patch);
    this.#notificationHub.emitSessionListChanged();
    return project;
  }

  selectProject(projectId: string): Project {
    const project = this.#projectStore.select(projectId);
    this.#notificationHub.emitSessionListChanged();
    return project;
  }

  archiveProject(projectId: string): Project {
    const project = this.#projectStore.archive(projectId);
    for (const session of this.#sessions.values()) {
      if (session.projectId !== projectId || session.status === "archived") continue;
      if (session.status === "running") this.#abortScheduledTurn(session.id);
      session.status = "archived";
      session.updatedAt = now();
      this.#saveSessionMeta(session);
    }
    this.#notificationHub.emitSessionListChanged();
    return project;
  }

  getProjectSessions(projectId: string): Session[] {
    return this.listSessions().filter((session) => session.projectId === projectId);
  }

  // ── Session management ──

  createSession(title: string, options?: CreateSessionOptions): Session {
    const project = this.#resolveSessionProject(options?.projectId);
    const id = makeId();
    const timestamp = now();
    const session: Session = {
      id,
      title,
      status: "idle",
      muted: false,
      dangerouslyAllowAllTools: false,
      projectId: project.id,
      workspacePath: project.path,
      activeBranchId: MAIN_BRANCH_ID,
      branches: {
        [MAIN_BRANCH_ID]: {
          id: MAIN_BRANCH_ID,
          createdAt: timestamp,
          updatedAt: timestamp,
          title: "Original",
        },
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#sessions.set(id, session);

    this.#notificationHub.emitSessionListChanged();
    logger.info("Session created", { sessionId: id, title });
    return session;
  }

  appendUserMessage(
    sessionId: string,
    text: string,
    options?: AppendUserMessageOptions,
  ): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    this.#ensureSessionProject(session);
    const branchId = this.#resolveBranchId(session, options?.branchId);

    // Determine the right transition:
    // waiting_user → user_reply → running (continue the same turn)
    // sleeping → user_message → running (wake up early)
    // idle → user_message → running (start a new turn)
    let transitionKind: "user_message" | "user_reply";
    if (session.status === "waiting_user") {
      transitionKind = "user_reply";
    } else {
      transitionKind = "user_message";
    }
    const nextStatus = transition(session.status, { kind: transitionKind });

    const event: UserMessage = {
      type: "user_message",
      seq: nextSeq++,
      timestamp: now(),
      sessionId,
      branchId,
      text,
    };

    this.#ensureSessionPersistence(session);
    this.#threadStore.append(sessionId, event);
    const userMessageCount = this
      .getVisibleThread(sessionId, branchId)
      .filter((item) => item.type === "user_message")
      .length;
    session.activeBranchId = branchId;
    session.branches![branchId]!.updatedAt = now();
    session.status = nextStatus;
    session.updatedAt = now();
    this.#saveSessionMeta(session);
    this.#notificationHub.emitSessionEvent(sessionId, event);
    this.#notificationHub.emitSessionListChanged();
    if (userMessageCount === 1) {
      void this.#maybeAutoTitleSession(sessionId, text);
    }
    if (options?.source) {
      this.#turnSources.set(sessionId, options.source);
    } else {
      this.#turnSources.delete(sessionId);
    }
    if (options?.dispatch !== false) {
      this.#dispatchOrBlock(sessionId);
    }
    return session;
  }

  // ── Turn execution ──

  /**
   * Blocking turn execution. Use dispatchTurn() for non-blocking mode.
   */
  async runTurn(sessionId: string): Promise<Session> {
    return this.#runTurnInternal(sessionId);
  }

  /**
   * Internal turn execution — shared by runTurn() and Supervisor.
   */
  async #runTurnInternal(sessionId: string): Promise<Session> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const projectRoot = this.#sessionProjectRoot(session);
    if (!this.#modelProvider && !this.#toolExecutor) {
      this.#blockNotRunnableSession(sessionId);
      throw new Error("ModelProvider and ToolExecutor are not set");
    }
    if (!this.#modelProvider) {
      this.#blockNotRunnableSession(sessionId);
      throw new Error("ModelProvider not set");
    }
    if (!this.#toolExecutor) {
      this.#blockNotRunnableSession(sessionId);
      throw new Error("ToolExecutor not set");
    }
    if (session.status !== "running") {
      throw new Error(`Session is ${session.status}, cannot run turn`);
    }
    const existingController = this.#turnControllers.get(sessionId);
    if (existingController && !existingController.signal.aborted) {
      throw new Error(`Session turn already active: ${sessionId}`);
    }
    const controller = new AbortController();
    this.#turnControllers.set(sessionId, controller);
    const activeBranchId = this.#resolveBranchId(session);

    logger.info("Turn starting", { sessionId });

    const before = this.#threadStore.getThread(sessionId).length;
    this.#turnStarts.set(sessionId, before);
    this.#turnEventCursors.set(sessionId, before);

    this.#prepareProjectScopedStores(projectRoot);

    const promptOptions: Parameters<typeof buildSystemPrompt>[0] = {
      sessionId,
    };
    if (this.#skillCatalog) promptOptions.skillCatalog = this.#skillCatalog;
    if (this.#skillCatalog) promptOptions.skillContext = this.#buildSkillRenderContext(sessionId, activeBranchId);
    if (this.#memoryStore) promptOptions.memoryStore = this.#memoryStore;
    const systemPrompt = buildSystemPrompt(promptOptions);

    const tools = this.#toolRegistry?.list() ?? [];
    const source = this.#turnSources.get(sessionId);

    const loopOptions: NonNullable<ConstructorParameters<typeof AgentLoop>[5]> = {
      systemPrompt,
      tools,
      toolsProvider: () => this.#toolRegistry?.list() ?? [],
      artifactStore: this.#artifactStore,
      signal: controller.signal,
      branchId: activeBranchId,
      onDelta: (sid, delta) => {
        if (controller.signal.aborted) return;
        this.#notificationHub.emitSessionEvent(sid, delta);
      },
      onToolResult: (event) => {
        if (controller.signal.aborted) return;
        this.#recordSkillUsageFromToolResult(event);
      },
    };
    if (Object.keys(session.branches ?? {}).length > 1 || activeBranchId !== MAIN_BRANCH_ID) {
      loopOptions.readThread = (sid) => this.getVisibleThread(sid, activeBranchId);
    }
    if (this.#permissionBroker) {
      const toolExecutionContext: NonNullable<typeof loopOptions.toolExecutionContext> = {
        permissionBroker: this.#permissionBroker,
        pathSandbox: this.#createPathSandbox(sessionId),
        projectRoot,
        bashSandboxMode: "enforce",
        branchId: activeBranchId,
      };
      if (source) toolExecutionContext.source = source;
      loopOptions.toolExecutionContext = toolExecutionContext;
    }
    if (this.#artifactMaxResultSizeChars !== undefined) {
      loopOptions.artifactMaxResultSizeChars = this.#artifactMaxResultSizeChars;
    }
    if (this.#artifactPreviewBytes !== undefined) {
      loopOptions.artifactPreviewBytes = this.#artifactPreviewBytes;
    }
    if (this.#artifactPerTurnBudgetChars !== undefined) {
      loopOptions.artifactPerTurnBudgetChars = this.#artifactPerTurnBudgetChars;
    }
    if (this.#maxContextTokens !== undefined) {
      loopOptions.maxContextTokens = this.#maxContextTokens;
    }
    if (this.#autoCompactBuffer !== undefined) {
      loopOptions.autoCompactBuffer = this.#autoCompactBuffer;
    }
    if (this.#compactionKeepRecentTokens !== undefined) {
      loopOptions.compactionKeepRecentTokens = this.#compactionKeepRecentTokens;
    }
    const providerMetadata = this.#modelProvider.getMetadata?.();
    const contextWindowTokens = this.#contextWindowTokens ?? providerMetadata?.contextWindowTokens;
    if (contextWindowTokens !== undefined) {
      loopOptions.contextWindowTokens = contextWindowTokens;
    }
    if (providerMetadata?.requiresUsage) {
      loopOptions.requireUsageForCompaction = true;
    }

    const trackedProvider = this.#usageTrackingProvider(sessionId, this.#modelProvider);
    const loop = new AgentLoop(
      trackedProvider,
      this.#toolExecutor,
      this.#threadStore,
      () => nextSeq++,
      () => now(),
      loopOptions,
    );

    let result: TurnResult;
    try {
      result = await loop.runTurn(sessionId);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        return this.#finalizeAbortedTurn(session, before);
      }

      logger.error("Turn failed with error", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (session.status === "running") {
        this.#appendBlockedEvent(
          sessionId,
          "model_provider",
          err instanceof Error ? err.message : String(err),
        );
        session.status = transition(session.status, { kind: "runtime_failure" });
      }
      session.updatedAt = now();
      this.#saveSessionMeta(session);
      this.#notificationHub.emitSessionListChanged();
      throw err;
    } finally {
      if (this.#turnControllers.get(sessionId) === controller) {
      this.#turnControllers.delete(sessionId);
      }
      this.#turnStarts.delete(sessionId);
      this.#turnEventCursors.delete(sessionId);
      this.#turnSources.delete(sessionId);
    }

    if (controller.signal.aborted) {
      return this.#finalizeAbortedTurn(session, before);
    }

    this.#emitNewTurnEvents(sessionId);

    switch (result.outcome) {
      case "turn_finished": {
        if (session.status !== "running") break;
        // Route to sleeping if there are enabled triggers, otherwise idle
        const kind = this.#hasEnabledTriggers(sessionId) ? "agent_schedule_sleep" : "turn_finished";
        session.status = transition(session.status, { kind });
        this.#queueMemoryExtraction(sessionId, before);
        this.#queueSkillEvolution(sessionId, before);
        break;
      }
      case "waiting_user":
        if (session.status === "running") {
          session.status = transition(session.status, { kind: "agent_ask_user" });
        }
        this.#queueMemoryExtraction(sessionId, before);
        this.#queueSkillEvolution(sessionId, before);
        break;
      case "tool_failure":
        if (session.status === "running") {
          this.#appendBlockedEvent(sessionId, result.runtimeKind ?? "agent_loop", result.message);
          session.status = transition(session.status, { kind: "runtime_failure" });
        }
        break;
    }

    session.updatedAt = now();
    this.#saveSessionMeta(session);
    this.#notificationHub.emitSessionListChanged();

    logger.info("Turn finished", {
      sessionId,
      outcome: result.outcome,
      newStatus: session.status,
    });

    return session;
  }

  // ── Session accessors ──

  listSessions(): Session[] {
    return [...this.#sessions.values()].filter(
      (s) => s.status !== "archived",
    );
  }

  getSession(sessionId: string): Session | null {
    return this.#sessions.get(sessionId) ?? null;
  }

  muteSession(sessionId: string, muted: boolean): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.muted = muted;
    session.updatedAt = now();
    this.#saveSessionMeta(session);
    this.#notificationHub.emitSessionListChanged();
    return session;
  }

  setSessionDangerousToolApproval(
    sessionId: string,
    enabled: boolean,
    options?: { deviceId?: string; deviceName?: string },
  ): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "archived") throw new Error("Cannot update an archived session");

    session.dangerouslyAllowAllTools = enabled;
    session.updatedAt = now();
    this.#permissionBroker?.setDangerouslyAllowAllTools(sessionId, enabled);
    this.#ensureSessionPersistence(session);
    this.#saveSessionMeta(session);

    const message = enabled
      ? "Dangerous free mode enabled for this session. Tool approval prompts will be bypassed; sandbox checks and tool/runtime errors still return readable results."
      : "Dangerous free mode disabled for this session. Tool approval prompts are active again.";
    const event: RuntimeEvent = {
      type: "runtime_event",
      seq: nextSeq++,
      timestamp: now(),
      sessionId,
      branchId: this.#resolveBranchId(session),
      runtimeKind: "permission",
      detail: "permission_mode",
      message,
    };
    this.#threadStore.append(sessionId, event);
    this.#notificationHub.emitSessionEvent(sessionId, event);

    if (enabled) {
      this.#permissionBroker?.approvePendingRequestsForSession(sessionId, {
        message: "Permission approved because dangerous free mode was enabled for this session.",
        ...(options?.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
        ...(options?.deviceName !== undefined ? { deviceName: options.deviceName } : {}),
      });
    }

    this.#notificationHub.emitSessionListChanged();
    return session;
  }

  renameSession(sessionId: string, title: string): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const sanitized = sanitizeGeneratedTitle(title);
    if (!sanitized) throw new Error("Session title cannot be empty");
    session.title = sanitized;
    session.updatedAt = now();
    this.#saveSessionMeta(session);
    this.#notificationHub.emitSessionListChanged();
    return session;
  }

  deleteSession(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.status = transition(session.status, { kind: "user_archive" });
    session.updatedAt = now();
    this.#saveSessionMeta(session);
    this.#notificationHub.emitSessionListChanged();
    logger.info("Session archived", { sessionId });
  }

  getThread(sessionId: string): SessionEvent[] {
    return this.#threadStore.getThread(sessionId);
  }

  getVisibleThread(sessionId: string, branchId?: string): SessionEvent[] {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const resolvedBranchId = this.#resolveBranchId(session, branchId);
    return this.#visibleThreadForBranch(session, resolvedBranchId);
  }

  getBranchState(sessionId: string): SessionBranchState {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    this.#ensureBranchState(session);
    const raw = this.#threadStore.getThread(sessionId);
    const groups = new Map<number, BranchVariant[]>();

    for (const event of raw) {
      if (event.type !== "user_message") continue;
      const sourceSeq = event.variantOfSeq ?? event.seq;
      const variants = groups.get(sourceSeq) ?? [];
      variants.push({
        branchId: eventBranchId(event),
        userMessageSeq: event.seq,
        sourceSeq,
        textPreview: textPreview(event.text),
        createdAt: event.timestamp,
      });
      groups.set(sourceSeq, variants);
    }

    const variantGroups = [...groups.entries()]
      .map(([sourceSeq, variants]) => ({
        sourceSeq,
        variants: variants.sort((a, b) => a.userMessageSeq - b.userMessageSeq),
      }))
      .sort((a, b) => a.sourceSeq - b.sourceSeq);

    return {
      activeBranchId: session.activeBranchId ?? MAIN_BRANCH_ID,
      branches: Object.values(session.branches ?? {}),
      variantGroups,
    };
  }

  createMessageVariant(
    sessionId: string,
    options: CreateMessageVariantOptions,
  ): SessionBranchState {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "archived") throw new Error("Cannot branch an archived session");
    if (session.status === "running") throw new Error("Interrupt the running session before editing a previous message.");
    this.#ensureBranchState(session);

    const replacementText = options.replacementText.trim();
    if (!replacementText) throw new Error("Replacement text cannot be empty");

    const raw = this.#threadStore.getThread(sessionId);
    const source = raw.find((event): event is UserMessage => (
      event.seq === options.sourceSeq && event.type === "user_message"
    ));
    if (!source) throw new Error(`Editable user message not found: ${options.sourceSeq}`);

    const sourceBranchId = eventBranchId(source);
    if (!session.branches![sourceBranchId]) {
      session.branches![sourceBranchId] = {
        id: sourceBranchId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        title: branchTitleForVariant(0),
      };
    }
    const variantOfSeq = source.variantOfSeq ?? source.seq;
    const existingVariants = raw.filter((event) => (
      event.type === "user_message" &&
      (event.variantOfSeq ?? event.seq) === variantOfSeq
    ));
    const newBranchId = `branch_${crypto.randomUUID().slice(0, 8)}`;
    const timestamp = now();
    session.branches![newBranchId] = {
      id: newBranchId,
      parentBranchId: sourceBranchId,
      forkFromSeq: source.seq,
      variantOfSeq,
      createdAt: timestamp,
      updatedAt: timestamp,
      title: branchTitleForVariant(existingVariants.length),
    };
    session.activeBranchId = newBranchId;

    this.#ensureSessionPersistence(session);
    const branchEvent: BranchEvent = {
      type: "branch_event",
      seq: nextSeq++,
      timestamp,
      sessionId,
      branchId: newBranchId,
      sourceBranchId,
      sourceUserMessageSeq: source.seq,
      variantOfSeq,
      newBranchId,
      message: `Created message variant ${existingVariants.length + 1}/${existingVariants.length + 1} from user message #${source.seq}. The original path is preserved and this branch continues from the edited message.`,
    };
    const userEvent: UserMessage = {
      type: "user_message",
      seq: nextSeq++,
      timestamp: now(),
      sessionId,
      branchId: newBranchId,
      variantOfSeq,
      text: replacementText,
    };
    this.#threadStore.append(sessionId, branchEvent);
    this.#threadStore.append(sessionId, userEvent);

    if (session.status === "blocked") {
      session.status = transition(session.status, { kind: "user_retry" });
    } else if (session.status === "waiting_user") {
      session.status = transition(session.status, { kind: "user_reply" });
    } else {
      session.status = transition(session.status, { kind: "user_message" });
    }
    session.branches![newBranchId]!.updatedAt = now();
    session.updatedAt = now();
    this.#saveSessionMeta(session);
    this.#notificationHub.emitSessionEvent(sessionId, branchEvent);
    this.#notificationHub.emitSessionEvent(sessionId, userEvent);
    this.#notificationHub.emitSessionListChanged();

    if (options.source) {
      this.#turnSources.set(sessionId, options.source);
    } else {
      this.#turnSources.delete(sessionId);
    }
    if (options.dispatch !== false) {
      this.#dispatchOrBlock(sessionId);
    }
    return this.getBranchState(sessionId);
  }

  getArtifactInfo(artifactId: string): ArtifactInfo | null {
    return this.#artifactStore.getInfo(artifactId);
  }

  retrieveArtifact(artifactId: string): Buffer | null {
    return this.#artifactStore.retrieve(artifactId);
  }

  listArtifacts(sessionId: string): ArtifactInfo[] {
    return this.#artifactStore.listBySession(sessionId);
  }

  previewHtmlFile(filePath: string, options?: { sessionId?: string }): HtmlFilePreview {
    const session = options?.sessionId ? this.#sessions.get(options.sessionId) : undefined;
    if (options?.sessionId && !session) throw new Error(`Session not found: ${options.sessionId}`);
    const projectRoot = session ? this.#sessionProjectRoot(session) : this.#projectStore.getCurrentProject().path;
    const scratchRoot = session ? join(this.#dataDir, "workspaces", `session_${session.id}`) : undefined;
    const resolved = new PathSandbox({
      projectRoot,
      ...(scratchRoot ? { scratchRoot } : {}),
    }).resolvePath(filePath, "read", "html_preview", "fs.read");
    if (!resolved.ok) throw new Error(resolved.message);
    const ext = extname(resolved.path).toLowerCase();
    if (ext !== ".html" && ext !== ".htm") {
      throw new Error("Only .html and .htm files can be previewed in the Web Console.");
    }
    if (!existsSync(resolved.path)) {
      throw new Error(`File not found: ${resolved.path}`);
    }
    const stat = statSync(resolved.path);
    if (!stat.isFile()) {
      throw new Error(`Cannot preview non-file path: ${resolved.path}`);
    }
    const bytes = readFileSync(resolved.path);
    const truncated = bytes.length > HTML_PREVIEW_MAX_BYTES;
    const content = bytes.subarray(0, HTML_PREVIEW_MAX_BYTES).toString("utf-8");
    return {
      path: resolved.path,
      content,
      sizeBytes: bytes.length,
      truncated,
    };
  }

  saveUploadedFile(
    sessionId: string,
    input: { name: string; bytes: Buffer; mimeType?: string },
  ): UploadedSessionFile {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    this.#ensureSessionProject(session);
    if (session.status === "archived") throw new Error("Cannot upload files to an archived session");

    const safeName = sanitizeUploadFileName(input.name);
    const uploadDir = join(this.#dataDir, "workspaces", `session_${sessionId}`, "uploads");
    mkdirSync(uploadDir, { recursive: true });
    const uniqueName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;
    const filePath = join(uploadDir, uniqueName);
    writeFileSync(filePath, input.bytes);
    return {
      name: safeName,
      path: resolve(filePath),
      sizeBytes: input.bytes.length,
      mimeType: input.mimeType || "application/octet-stream",
    };
  }

  getUsageRecords(sessionId: string, afterSeq = 0): UsageRecord[] {
    return this.#usageLedger.list(sessionId, afterSeq);
  }

  getSessionUsage(sessionId: string): SessionUsageSummary {
    const summary = this.#usageLedger.summarize(sessionId);
    this.#applyCurrentContextEstimate(sessionId, summary);
    return summary;
  }

  flush(): void {
    this.#threadStore.flush();
  }

	  async shutdown(options?: { waitMs?: number }): Promise<void> {
	    this.#scheduler?.stop();
	    this.#runtimeManager?.stop();
	    this.#webridgeRuntime?.shutdown();
	    this.#mcpManager?.stop();
	    this.#supervisor?.stop();
    for (const [, controller] of this.#turnControllers) {
      controller.abort();
    }
    this.#permissionBroker?.abortAll();

    const waitMs = options?.waitMs ?? 5_000;
    const deadline = Date.now() + waitMs;
    while (this.#turnControllers.size > 0 && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }

    this.flush();
  }

  loadSessions(): Session[] {
    this.ensureDefaultProject();
    const sessionsDir = join(this.#dataDir, "sessions");
    if (!existsSync(sessionsDir)) return [];

    const loaded: Session[] = [];
    let maxSeq = 0;
    let deletedLegacySessions = 0;
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = join(sessionsDir, entry.name, "thread.jsonl");
      if (!existsSync(filePath)) continue;

      const { meta, events } = SessionThreadStore.loadFromFile(filePath);

      if (meta) {
        if (!meta.projectId || !meta.workspacePath) {
          rmSync(join(sessionsDir, entry.name), { recursive: true, force: true });
          rmSync(join(this.#dataDir, "workspaces", `session_${meta.id}`), { recursive: true, force: true });
          deletedLegacySessions += 1;
          continue;
        }
        meta.dangerouslyAllowAllTools = meta.dangerouslyAllowAllTools === true;
        this.#ensureSessionProject(meta);
        this.#ensureBranchState(meta);
        this.#sessions.set(meta.id, meta);
        this.#permissionBroker?.setDangerouslyAllowAllTools(meta.id, meta.dangerouslyAllowAllTools);
        this.#threadStore.attachFile(meta.id, filePath);
        this.#threadStore.writeSessionMeta(meta.id, meta);
        for (const event of events) {
          this.#threadStore.append(meta.id, event);
          maxSeq = Math.max(maxSeq, event.seq);
        }
        loaded.push(meta);
      }
    }
    if (maxSeq > 0) {
      nextSeq = Math.max(nextSeq, maxSeq + 1);
    }
    if (deletedLegacySessions > 0) {
      logger.info("Deleted legacy sessions without project metadata", { count: deletedLegacySessions });
    }
    return loaded;
  }

  async rehydrateAfterStartup(
    options?: RehydrateAfterStartupOptions,
  ): Promise<StartupRehydrateReport> {
    const startupStatuses = new Map(
      [...this.#sessions.values()].map((session) => [session.id, session.status]),
    );
    const report: StartupRehydrateReport = {
      repairedToolResults: 0,
      requeuedSessions: [],
      startupBlockedSessions: [],
      dispatchResults: {},
      triggerSyncedSessions: [],
      runtimeAttachmentsRestored: 0,
      runtimeAttachmentsFailed: 0,
      runtimeBlockedSessions: 0,
      runtimeRecoveredSessions: [],
    };

    const runtimeReport: RuntimeRehydrateReport | undefined =
      this.#runtimeManager ? await this.#runtimeManager.rehydrateFromThreads() : undefined;
    if (runtimeReport) {
      report.runtimeAttachmentsRestored = runtimeReport.attachmentsRestored;
      report.runtimeAttachmentsFailed = runtimeReport.attachmentsFailed;
      report.runtimeBlockedSessions = runtimeReport.runtimeBlockedSessions;
      report.runtimeRecoveredSessions = runtimeReport.recoveredSessions;
    }

    if (this.#mcpManager) {
      const mcpReport = await this.#mcpManager.rehydrateAfterStartup();
      report.mcpServers = mcpReport.servers;
      report.mcpToolsProjected = mcpReport.toolsProjected;
    }

    if (this.#memoryManager) {
      report.memoryMaintenance = await this.#memoryManager.rehydrateAfterStartup();
    } else {
      this.#memoryStore.rebuildIndex();
    }
    if (this.#skillEvolutionManager) {
      await this.#skillEvolutionManager.rehydrateAfterStartup();
    } else {
      this.#skillStore?.rebuildIndex();
    }

    for (const session of this.#sessions.values()) {
      const before = session.status;
      if (this.#syncTriggerState(session.id) && before !== this.#sessions.get(session.id)?.status) {
        report.triggerSyncedSessions.push(session.id);
      }
    }

    for (const session of this.#sessions.values()) {
      if (startupStatuses.get(session.id) !== "running") continue;
      if (session.status !== "running") continue;

      const repaired = this.#appendProcessRestartToolResults(session.id);
      report.repairedToolResults += repaired;
      this.#appendStartupBlockedEvent(session.id, repaired);
      session.status = transition(session.status, { kind: "runtime_failure" });
      session.updatedAt = now();
      this.#saveSessionMeta(session);
      report.startupBlockedSessions.push(session.id);
    }

    this.#notificationHub.emitSessionListChanged();
    return report;
  }

  #hasEnabledTriggers(sessionId: string): boolean {
    return (this.#scheduler?.listTriggers(sessionId) ?? []).some((t) => t.enabled);
  }

  #syncTriggerState(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;

    if (session.status === "idle" && this.#hasEnabledTriggers(sessionId)) {
      session.status = transition(session.status, { kind: "trigger_scheduled" });
    } else if (session.status === "sleeping" && !this.#hasEnabledTriggers(sessionId)) {
      session.status = transition(session.status, { kind: "triggers_empty" });
    } else {
      return false;
    }
    session.updatedAt = now();
    this.#saveSessionMeta(session);
    this.#notificationHub.emitSessionListChanged();
    logger.info("Session trigger state synchronized", { sessionId, status: session.status });
    return true;
  }

  #dispatchOrBlock(sessionId: string): DispatchTurnResult {
    const result = this.dispatchTurn(sessionId);
    if (result === "not_runnable") {
      this.#blockNotRunnableSession(sessionId);
    }
    return result;
  }

  #createPathSandbox(sessionId: string): PathSandbox {
    const session = this.#sessions.get(sessionId);
    const projectRoot = session ? this.#sessionProjectRoot(session) : this.#projectStore.getCurrentProject().path;
    const readRoots: string[] = [];
    if (this.#skillStore) readRoots.push(this.#skillStore.rootDir);
    return new PathSandbox({
      projectRoot,
      scratchRoot: join(this.#dataDir, "workspaces", `session_${sessionId}`),
      ...(readRoots.length > 0 ? { readRoots } : {}),
    });
  }

  #ensureBranchState(session: Session): void {
    const timestamp = session.createdAt || now();
    session.branches ??= {};
    session.branches[MAIN_BRANCH_ID] ??= {
      id: MAIN_BRANCH_ID,
      createdAt: timestamp,
      updatedAt: session.updatedAt || timestamp,
      title: branchTitleForVariant(0),
    };
    session.activeBranchId ??= MAIN_BRANCH_ID;
    if (!session.branches[session.activeBranchId]) {
      session.activeBranchId = MAIN_BRANCH_ID;
    }
  }

  #resolveBranchId(session: Session, requestedBranchId?: string): string {
    this.#ensureBranchState(session);
    const branchId = requestedBranchId?.trim() || session.activeBranchId || MAIN_BRANCH_ID;
    if (!session.branches![branchId]) {
      throw new Error(`Branch not found: ${branchId}`);
    }
    return branchId;
  }

  #branchLineage(session: Session, branchId: string): SessionBranch[] {
    this.#ensureBranchState(session);
    const branches = session.branches!;
    const lineage: SessionBranch[] = [];
    const seen = new Set<string>();
    let current: SessionBranch | undefined = branches[branchId];

    while (current) {
      if (seen.has(current.id)) throw new Error(`Branch lineage contains a cycle at ${current.id}`);
      seen.add(current.id);
      lineage.unshift(current);
      current = current.parentBranchId ? branches[current.parentBranchId] : undefined;
    }

    if (lineage.length === 0 || lineage[0]!.id !== MAIN_BRANCH_ID) {
      lineage.unshift(branches[MAIN_BRANCH_ID]!);
    }
    return lineage;
  }

  #visibleThreadForBranch(session: Session, branchId: string): SessionEvent[] {
    const lineage = this.#branchLineage(session, branchId);
    const indexByBranch = new Map(lineage.map((branch, index) => [branch.id, index]));
    const raw = this.#threadStore.getThread(session.id);

    return raw.filter((event) => {
      const eventBranch = eventBranchId(event);
      const lineageIndex = indexByBranch.get(eventBranch);
      if (lineageIndex === undefined) return false;
      const nextBranch = lineage[lineageIndex + 1];
      if (nextBranch?.forkFromSeq !== undefined && event.seq >= nextBranch.forkFromSeq) {
        return false;
      }
      return true;
    });
  }

  #queueMemoryExtraction(sessionId: string, turnStart: number): void {
    if (!this.#memoryManager) return;
    const events = this.#threadStore.getThread(sessionId).slice(turnStart);
    this.#memoryManager.queueTurnExtraction(sessionId, events);
  }

  #queueSkillEvolution(sessionId: string, turnStart: number): void {
    if (!this.#skillEvolutionManager) return;
    const events = this.#threadStore.getThread(sessionId).slice(turnStart);
    this.#skillEvolutionManager.queueTurnExtraction(sessionId, events);
  }

  #buildSkillRenderContext(sessionId: string, branchId?: string): SkillRenderContext {
    const events = this.getVisibleThread(sessionId, branchId);
    let latestUserText = "";
    const recentPaths: string[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (!latestUserText && event.type === "user_message") {
        latestUserText = event.text;
      }
      if (event.type === "tool_call") {
        collectPathValues(event.args, recentPaths);
      }
      if (recentPaths.length >= 40 && latestUserText) break;
    }
    return {
      latestUserText,
      recentPaths: [...new Set(recentPaths)].slice(0, 40),
    };
  }

  #recordSkillUsageFromToolResult(event: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
    isError: boolean;
    toolUseId: string;
  }): void {
    if (!this.#skillStore || event.toolName !== "read_file" || event.isError) return;
    const filePath = typeof event.args.file_path === "string" ? event.args.file_path : "";
    if (!filePath) return;
    const skill = this.#skillStore.matchPath(filePath);
    if (!skill) return;
    const skillEvent: SessionEvent = {
      type: "skill_used",
      seq: nextSeq++,
      timestamp: now(),
      sessionId: event.sessionId,
      skillName: skill.name,
      packageId: skill.packageId,
      version: skill.version,
      trust: skill.trust,
      source: skill.source,
      filePath,
      message: `Read skill resource ${filePath} from ${skill.name} ${skill.version}.`,
    };
    this.#threadStore.append(event.sessionId, skillEvent);
  }

  #blockNotRunnableSession(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session || session.status !== "running") return;

    this.#appendBlockedEvent(sessionId, "core", this.#notRunnableMessage(session));
    session.status = transition(session.status, { kind: "runtime_failure" });
    session.updatedAt = now();
    this.#saveSessionMeta(session);
    this.#notificationHub.emitSessionListChanged();
  }

  #notRunnableMessage(session: Session): string {
    if (!this.#modelProvider && !this.#toolExecutor) {
      return "Cannot dispatch turn: ModelProvider and ToolExecutor are not set.";
    }
    if (!this.#modelProvider) {
      return "Cannot dispatch turn: ModelProvider is not set.";
    }
    if (!this.#toolExecutor) {
      return "Cannot dispatch turn: ToolExecutor is not set.";
    }
    return `Cannot dispatch turn: session is ${session.status}.`;
  }

  #abortScheduledTurn(sessionId: string): void {
    this.#supervisor?.dequeue(sessionId);
    this.#turnControllers.get(sessionId)?.abort();
    const turnStart = this.#turnStarts.get(sessionId);
    if (turnStart !== undefined) {
      this.#appendInterruptedToolResults(sessionId, turnStart);
      this.#emitNewTurnEvents(sessionId, { skipRuntimeEvents: true });
    }
  }

  #finalizeAbortedTurn(session: Session, turnStart: number): Session {
    this.#appendInterruptedToolResults(session.id, turnStart);
    this.#emitNewTurnEvents(session.id, { skipRuntimeEvents: true });
    if (session.status === "running") {
      session.status = transition(session.status, { kind: "user_interrupt" });
    }
    session.updatedAt = now();
    this.#saveSessionMeta(session);
    this.#notificationHub.emitSessionListChanged();
    logger.info("Turn aborted", { sessionId: session.id, newStatus: session.status });
    return session;
  }

  #appendInterruptedToolResults(sessionId: string, turnStart: number): void {
    this.#appendMissingToolResults(sessionId, turnStart, INTERRUPTED_TOOL_RESULT);
  }

  #appendProcessRestartToolResults(sessionId: string): number {
    return this.#appendMissingToolResults(sessionId, 0, PROCESS_RESTART_TOOL_RESULT);
  }

  #appendMissingToolResults(
    sessionId: string,
    startIndex: number,
    message: string,
  ): number {
    const events = this.#threadStore.getThread(sessionId).slice(startIndex);
    const completed = new Set<string>();
    const calls: ToolCall[] = [];

    for (const event of events) {
      if (event.type === "tool_call") {
        calls.push(event);
      } else if (event.type === "tool_result" && event.toolUseId) {
        completed.add(event.toolUseId);
      }
    }

    let appended = 0;
    for (const call of calls) {
      const key = call.toolUseId ?? `call_${call.seq}`;
      if (completed.has(key)) continue;
      const result: ToolResult = {
        type: "tool_result",
        seq: nextSeq++,
        timestamp: now(),
        sessionId,
        toolName: call.toolName,
        result: message,
        isError: true,
        toolUseId: key,
      };
      this.#threadStore.append(sessionId, result);
      completed.add(key);
      appended++;
    }
    return appended;
  }

  #usageTrackingProvider(sessionId: string, provider: ModelProvider): ModelProvider {
    const metadata = provider.getMetadata?.();
    return {
      getMetadata: () => metadata ?? provider.getMetadata?.() ?? {
        provider: "unknown",
        model: "unknown",
      },
      generate: async (
        messages: ModelMessage[],
        tools,
        callbacks,
      ): Promise<ModelResponse> => {
        const response = await provider.generate(messages, tools, callbacks);
        this.#recordUsage(sessionId, response, messages, metadata ?? provider.getMetadata?.());
        return response;
      },
    };
  }

  #recordUsage(
    sessionId: string,
    response: ModelResponse,
    messages: ModelMessage[],
    metadata: ModelProviderMetadata | undefined,
  ): void {
    const requiresUsage = metadata?.requiresUsage === true;
    let usage = response.rawUsage;
    if (!usage) {
      if (requiresUsage) return;
      if (!metadata && this.#contextWindowTokens === undefined) return;
      const input = estimateTokensFromMessages(messages);
      const output = Math.max(0, Math.ceil((response.text ?? "").length / 4));
      usage = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
        estimated: true,
      };
    }

    const providerName = metadata?.provider ?? "unknown";
    const model = metadata?.model ?? "unknown";
    const contextWindowTokens = this.#contextWindowTokens ?? metadata?.contextWindowTokens;
    const contextUsedPercent = contextWindowTokens
      ? (usage.input_tokens / contextWindowTokens) * 100
      : undefined;
    const pricing = this.#pricing ?? metadata?.pricing;
    const cost = usageCost(usage, pricing);
    const id = crypto.randomUUID();
    const seq = nextSeq++;
    const timestamp = now();
    const record: UsageRecord = {
      id,
      seq,
      timestamp,
      sessionId,
      provider: providerName,
      model,
      requestKind: "model_call",
      usage,
    };
    if (contextWindowTokens !== undefined) record.contextWindowTokens = contextWindowTokens;
    if (contextUsedPercent !== undefined) record.contextUsedPercent = contextUsedPercent;
    if (pricing !== undefined) record.pricing = pricing;
    if (cost !== undefined) record.cost = cost;
    this.#usageLedger.append(record);

    const cacheMiss = inferCacheMiss(usage);
    const total = totalTokens(usage);
    const message = [
      usage.estimated ? "Estimated token usage" : "Token usage",
      `ctx ${formatPercent(contextUsedPercent)}`,
      `in ${usage.input_tokens}`,
      usage.cache_hit_tokens !== undefined || cacheMiss > 0
        ? `cache ${usage.cache_hit_tokens ?? 0} cached / ${cacheMiss} new`
        : "",
      `out ${usage.output_tokens}`,
      usage.reasoning_tokens ? `reasoning ${usage.reasoning_tokens}` : "",
      `total ${total}`,
    ].filter(Boolean).join(" · ") + formatCost(cost, pricing?.currency);

    const event: UsageEvent = {
      type: "usage_event",
      seq,
      timestamp,
      sessionId,
      usageRecordId: id,
      provider: providerName,
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: total,
      estimated: usage.estimated === true,
      message,
    };
    if (usage.cache_hit_tokens !== undefined) event.cacheHitTokens = usage.cache_hit_tokens;
    if (cacheMiss > 0) event.cacheMissTokens = cacheMiss;
    if (usage.reasoning_tokens !== undefined) event.reasoningTokens = usage.reasoning_tokens;
    if (contextWindowTokens !== undefined) event.contextWindowTokens = contextWindowTokens;
    if (contextUsedPercent !== undefined) event.contextUsedPercent = contextUsedPercent;
    if (cost !== undefined) event.cost = cost;
    if (pricing?.currency !== undefined) event.currency = pricing.currency;
    this.#threadStore.append(sessionId, event);
  }

  #applyCurrentContextEstimate(sessionId: string, summary: SessionUsageSummary): void {
    const latestUsageSeq = summary.latest?.seq ?? 0;
    const estimate = this.#latestContextUsageEstimate(sessionId);
    if (!estimate || estimate.seq <= latestUsageSeq) return;

    summary.currentContextTokens = estimate.inputTokens;
    summary.currentContextWindowTokens = estimate.contextWindowTokens;
    summary.currentContextUsedPercent = estimate.contextUsedPercent;
    summary.currentContextEstimated = true;
    summary.currentContextSource = estimate.source;
    summary.currentContextReason = estimate.reason;
    summary.currentContextMessage = estimate.message;
  }

  #latestContextUsageEstimate(sessionId: string): ContextUsageEvent | null {
    const events = this.#threadStore.getThread(sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.type === "context_usage_event") return event;
    }
    return null;
  }

  #resolveSessionProject(projectId?: string): Project {
    if (projectId) {
      const project = this.#projectStore.get(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.status === "archived") throw new Error(`Project is archived: ${projectId}`);
      return this.#projectStore.select(project.id);
    }
    return this.#projectStore.getCurrentProject();
  }

  #ensureSessionProject(session: Session): Project {
    if (session.projectId) {
      const project = this.#projectStore.get(session.projectId);
      if (project && project.status !== "archived") {
        session.workspacePath = project.path;
        return project;
      }
    }
    const project = this.#projectStore.getCurrentProject();
    session.projectId = project.id;
    session.workspacePath = project.path;
    this.#saveSessionMeta(session);
    return project;
  }

  #sessionProjectRoot(session: Session): string {
    return this.#ensureSessionProject(session).path;
  }

  #prepareProjectScopedStores(projectRoot: string): void {
    const resolved = resolve(projectRoot);
    if (this.#policyProjectRoot === resolved) return;
    this.#policyProjectRoot = resolved;
    this.#skillStore?.setProjectRoot(resolved);
    this.#skillCatalog?.refresh();
    this.#mcpManager?.setProjectRoot(resolved);
  }

  #emitNewTurnEvents(
    sessionId: string,
    options?: { skipRuntimeEvents?: boolean },
  ): void {
    const cursor = this.#turnEventCursors.get(sessionId);
    if (cursor === undefined) return;
    const events = this.#threadStore.getThread(sessionId);
    for (let i = cursor; i < events.length; i++) {
      const event = events[i]!;
      if (options?.skipRuntimeEvents && event.type === "runtime_event") {
        continue;
      }
      this.#notificationHub.emitSessionEvent(sessionId, event);
    }
    this.#turnEventCursors.set(sessionId, events.length);
  }

  async #maybeAutoTitleSession(sessionId: string, firstUserText: string): Promise<void> {
    const provider = this.#modelProvider;
    if (!provider) return;
    const session = this.#sessions.get(sessionId);
    if (!session || !isAutoTitleCandidate(session.title, firstUserText)) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await provider.generate(
        [
          {
            role: "system",
            content: [
              "You name agent conversations.",
              "Output only one short human-readable title.",
              "Use the user's language.",
              "No quotes, markdown, emoji, punctuation-only titles, or explanation.",
              "Keep it under 8 words.",
            ].join("\n"),
          },
          {
            role: "user",
            content: `First user message:\n${firstUserText}`,
          },
        ],
        undefined,
        { signal: controller.signal },
      );
      if (response.finishReason !== "stop") return;
      const title = sanitizeGeneratedTitle(response.text);
      if (!title) return;
      const latest = this.#sessions.get(sessionId);
      if (!latest || latest.status === "archived") return;
      if (!isAutoTitleCandidate(latest.title, firstUserText)) return;
      latest.title = title;
      latest.updatedAt = now();
      this.#saveSessionMeta(latest);
      this.#notificationHub.emitSessionListChanged();
      logger.info("Session auto-titled", { sessionId, title });
    } catch (err) {
      logger.warn("Session auto-title failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  #saveSessionMeta(session: Session): void {
    this.#threadStore.writeSessionMeta(session.id, session);
  }

  #ensureSessionPersistence(session: Session): void {
    if (this.#threadStore.hasFile(session.id)) return;
    const sessionDir = join(this.#dataDir, "sessions", session.id);
    mkdirSync(sessionDir, { recursive: true });
    const filePath = join(sessionDir, "thread.jsonl");
    this.#threadStore.attachFile(session.id, filePath);
    this.#threadStore.writeSessionMeta(session.id, session);
  }

  #appendBlockedEvent(sessionId: string, runtimeKind: string, message: string): void {
    const readable = `Session blocked: ${message}`;
    const session = this.#sessions.get(sessionId);
    const branchId = session ? this.#resolveBranchId(session) : MAIN_BRANCH_ID;
    const runtimeEvent: RuntimeEvent = {
      type: "runtime_event",
      seq: nextSeq++,
      timestamp: now(),
      sessionId,
      branchId,
      runtimeKind,
      detail: "failed",
      message: readable,
    };
    this.#threadStore.append(sessionId, runtimeEvent);
    this.#notificationHub.emitSessionEvent(sessionId, runtimeEvent);

    const systemEvent: SystemEvent = {
      seq: nextSeq++,
      timestamp: now(),
      category: "agent_lifecycle",
      detail: "blocked",
      message: `${sessionId}: ${readable}`,
    };
    this.#systemStreamStore.append(systemEvent);
    this.#notificationHub.emitSystemEvent(systemEvent);
  }

	  #appendPermissionEvent(
	    sessionId: string,
	    event: PermissionRequestEvent | PermissionResponseEvent,
	  ): void {
    if (this.#turnEventCursors.has(sessionId)) {
      this.#emitNewTurnEvents(sessionId);
    }
    this.#threadStore.append(sessionId, event);
    this.#notificationHub.emitSessionEvent(sessionId, event);
    if (this.#turnEventCursors.has(sessionId)) {
      this.#turnEventCursors.set(sessionId, this.#threadStore.getThread(sessionId).length);
	    }
	  }

  #appendMcpSessionEvent(
    sessionId: string,
    event: RuntimeEvent | McpElicitationRequestEvent | McpElicitationResponseEvent,
  ): void {
    if (!this.#sessions.has(sessionId)) return;
    if (this.#turnEventCursors.has(sessionId)) {
      this.#emitNewTurnEvents(sessionId);
    }
    this.#threadStore.append(sessionId, event);
    this.#notificationHub.emitSessionEvent(sessionId, event);
    if (this.#turnEventCursors.has(sessionId)) {
      this.#turnEventCursors.set(sessionId, this.#threadStore.getThread(sessionId).length);
    }
  }

	  #appendMemoryRuntimeEvent(
    sessionId: string,
    detail: RuntimeEvent["detail"],
    message: string,
  ): void {
    const runtimeEvent: RuntimeEvent = {
      type: "runtime_event",
      seq: nextSeq++,
      timestamp: now(),
      sessionId,
      runtimeKind: "memory",
      detail,
      message,
    };
    this.#threadStore.append(sessionId, runtimeEvent);
    this.#notificationHub.emitSessionEvent(sessionId, runtimeEvent);
  }

  #appendSkillRuntimeEvent(
    sessionId: string,
    detail: RuntimeEvent["detail"],
    message: string,
  ): void {
    const runtimeEvent: RuntimeEvent = {
      type: "runtime_event",
      seq: nextSeq++,
      timestamp: now(),
      sessionId,
      runtimeKind: "skill",
      detail,
      message,
    };
    if (sessionId !== "system" && this.#sessions.has(sessionId)) {
      this.#threadStore.append(sessionId, runtimeEvent);
      this.#notificationHub.emitSessionEvent(sessionId, runtimeEvent);
    }
  }

  #appendSystemEvent(
    category: SystemEvent["category"],
    detail: string,
    message: string,
  ): void {
    const systemEvent: SystemEvent = {
      seq: nextSeq++,
      timestamp: now(),
      category,
      detail,
      message,
    };
    this.#systemStreamStore.append(systemEvent);
    this.#notificationHub.emitSystemEvent(systemEvent);
  }

  #appendStartupBlockedEvent(sessionId: string, repairedToolResults: number): void {
    const repairText = repairedToolResults > 0
      ? ` Repaired ${repairedToolResults} incomplete tool call(s) before blocking.`
      : "";
    const message = `Core restarted while this session was running; moved the interrupted turn to blocked instead of automatically resuming. Retry the session to continue from the repaired thread.${repairText}`;
    const runtimeEvent: RuntimeEvent = {
      type: "runtime_event",
      seq: nextSeq++,
      timestamp: now(),
      sessionId,
      runtimeKind: "core",
      detail: "failed",
      message,
    };
    this.#threadStore.append(sessionId, runtimeEvent);
    this.#notificationHub.emitSessionEvent(sessionId, runtimeEvent);

    const systemEvent: SystemEvent = {
      seq: nextSeq++,
      timestamp: now(),
      category: "core_lifecycle",
      detail: "process_rehydrate_blocked",
      message: `${sessionId}: ${message}`,
    };
    this.#systemStreamStore.append(systemEvent);
    this.#notificationHub.emitSystemEvent(systemEvent);
  }
}
