export type SessionStatus = "idle" | "running" | "waiting_user" | "sleeping" | "blocked" | "archived";

export type Session = {
  id: string;
  title: string;
  status: SessionStatus;
  muted: boolean;
  dangerouslyAllowAllTools?: boolean;
  projectId?: string;
  workspacePath?: string;
  activeBranchId?: string;
  branches?: Record<string, SessionBranch>;
  createdAt: string;
  updatedAt: string;
  latestSeq?: number;
  latestAgentResultSeq?: number;
  unread?: boolean;
};

export type SessionBranch = {
  id: string;
  parentBranchId?: string;
  forkFromSeq?: number;
  variantOfSeq?: number;
  createdAt: string;
  updatedAt: string;
  title?: string;
};

export type DeviceState = {
  deviceId: string;
  selectedProjectId?: string;
  selectedSessionId?: string;
  selectedBranchBySession?: Record<string, string>;
  sessionReadSeq: Record<string, number>;
  mutedSessionIds: string[];
  notificationSettings: {
    enabled: boolean;
    lastNotifiedSeq: number;
  };
  updatedAt: string;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  status: "active" | "archived" | "missing";
  trustState: "trusted" | "untrusted";
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
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

export type SetupStatus = {
  provider: {
    provider: "deepseek";
    configured: boolean;
    source: "local_config" | "env" | "missing";
    apiKeyMasked: string | null;
    baseUrl: string;
    model: string;
    contextWindowTokens: number;
    updatedAt?: string;
  };
};

export type SessionUsageSummary = {
  sessionId: string;
  records: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  contextWindowTokens?: number;
  contextUsedPercent?: number;
  currentContextSource?: "provider_usage" | "local_estimate";
  cacheHitRateNow?: number;
  cacheHitRateAverage?: number;
  cost?: number;
  currency?: string;
  estimated?: boolean;
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

export type WebridgeHealth = {
  enabled?: boolean;
  state?: "online" | "stale" | "offline" | string;
  message?: string;
  clients?: Array<Record<string, unknown>>;
};

export type SkillStatus = {
  active?: number;
  generated?: number;
  invalid?: number;
  quarantined?: number;
  disabled?: number;
  manifestPath?: string;
};

export type MemoryStatus = {
  state: string;
  queuedExtractions: number;
  pendingProposals: number;
};

export type McpServerStatus = {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "streamable-http" | "sse";
  launchMode: "eager" | "background" | "lazy";
  trust: "trusted" | "untrusted" | "quarantined";
  state: "disabled" | "configured" | "connecting" | "connected" | "degraded" | "needs_auth" | "failed";
  tools: number;
  resources: number;
  resourceTemplates: number;
  prompts: number;
  lastConnectedAt?: string;
  lastError?: string;
  authUrl?: string;
  cacheAgeMs?: number;
  stderrTail?: string;
};

export type McpStatusSummary = {
  state: "idle" | "degraded" | "needs_auth" | "failed" | "connected";
  servers: McpServerStatus[];
  enabled: number;
  connected: number;
  degraded: number;
  needsAuth: number;
  tools: number;
  events: number;
};

export type McpToolMetadata = {
  serverId: string;
  serverName: string;
  originalName: string;
  safeName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
};

export type ExtensionKind = "skill" | "mcp_server" | "bundle";

export type ExtensionCandidate = {
  id: string;
  kind: ExtensionKind;
  name: string;
  title: string;
  description: string;
  source: string;
  sourceLabel: string;
  trust: "official" | "curated" | "trusted" | "community" | "untrusted" | "quarantined" | "local";
  installed: boolean;
  enabled: boolean;
  status: "available" | "installed" | "active" | "disabled" | "quarantined" | "invalid";
  capabilities: string[];
  riskSummary: string;
  installInput: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  recommended?: boolean;
  setupRequired?: boolean;
  reviewState?: "safe" | "warning" | "blocked" | "setup_required";
  reviewAction?: "none" | "trust_enable" | "fix_required" | "setup_required";
  postInstall?: string;
  lock?: Record<string, unknown>;
  registrySourceId?: string;
};

export type ExtensionRegistrySource = {
  id: string;
  kind: "builtin" | "file" | "http" | "github";
  name: string;
  enabled: boolean;
  url?: string;
  path?: string;
  trust: ExtensionCandidate["trust"];
  trustUnsigned?: boolean;
  addedAt: string;
  updatedAt: string;
  lastRefreshAt?: string;
  lastError?: string;
};

export type ExtensionEventRecord = {
  seq: number;
  timestamp: string;
  detail: string;
  message: string;
  extensionId?: string;
  kind?: ExtensionKind;
  sourceId?: string;
  payload?: Record<string, unknown>;
};

export type ExtensionStatus = {
  skills: {
    status: SkillStatus;
    sources: Array<Record<string, unknown>>;
    entries: Array<Record<string, unknown>>;
  };
  mcp: {
    servers: McpServerStatus[];
    tools: McpToolMetadata[];
    catalog: Array<Record<string, unknown>>;
  };
  counts: {
    installed: number;
    enabled: number;
    quarantined: number;
    invalid: number;
  };
  registry: {
    sources: ExtensionRegistrySource[];
    entries: Array<Record<string, unknown>>;
    locks: Array<Record<string, unknown>>;
    events: ExtensionEventRecord[];
    diagnostics: string[];
  };
};

export type ExtensionInstallResult = {
  kind: ExtensionKind;
  id: string;
  name: string;
  status: "installed" | "active" | "quarantined" | "invalid";
  message: string;
};

export type McpElicitationRequest = {
  id: string;
  sessionId: string;
  serverId: string;
  serverName: string;
  message: string;
  requestedSchema?: Record<string, unknown>;
  status: "pending";
  expiresAt: string;
};

export type Diagnostics = {
  app: string;
  version: string;
  setup: SetupStatus;
  provider: null | {
    provider: string;
    model: string;
    contextWindowTokens?: number;
    requiresUsage?: boolean;
  };
  sessions: {
    total: number;
    statuses: Record<string, number>;
  };
  permissions: {
    pending: number;
  };
  mcp: McpStatusSummary;
  webridge: WebridgeHealth;
  memory: MemoryStatus;
  skills: {
    status: SkillStatus;
    evolution: Record<string, unknown>;
  };
};

export type NetworkUrls = {
  localUrl: string;
  lanUrls: string[];
  preferredUrl: string;
};

export type PermissionRequest = {
  id: string;
  sessionId?: string;
  toolUseId?: string;
  toolName: string;
  action: string;
  subject: string;
  message: string;
  reason: string;
  status: "pending";
  expiresAt: string;
};

export type SessionEvent =
  | { type: "user_message"; seq: number; timestamp: string; branchId?: string; text: string; variantOfSeq?: number }
  | { type: "assistant_message"; seq: number; timestamp: string; branchId?: string; text: string }
  | { type: "assistant_delta"; seq: number; timestamp: string; branchId?: string; text: string }
  | { type: "tool_call"; seq: number; timestamp: string; branchId?: string; toolName: string; args: Record<string, unknown>; toolUseId?: string }
  | { type: "tool_result"; seq: number; timestamp: string; sessionId?: string; branchId?: string; toolName: string; result: unknown; isError: boolean; toolUseId?: string }
  | { type: "permission_request"; seq: number; timestamp: string; branchId?: string; permissionRequestId: string; toolName: string; action: string; subject: string; message: string; reason: string; status: "pending"; expiresAt: string }
  | { type: "permission_response"; seq: number; timestamp: string; branchId?: string; permissionRequestId: string; toolName: string; decision: string; status: string; message: string }
  | { type: "runtime_event"; seq: number; timestamp: string; branchId?: string; runtimeKind: string; detail: string; message: string }
  | { type: "branch_event"; seq: number; timestamp: string; branchId?: string; sourceBranchId: string; sourceUserMessageSeq: number; variantOfSeq: number; newBranchId: string; message: string }
  | { type: "artifact_pointer"; seq: number; timestamp: string; branchId?: string; artifactId: string; mimeType: string; sizeBytes: number }
  | { type: "usage_event"; seq: number; timestamp: string; branchId?: string; provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; contextUsedPercent?: number; cacheHitTokens?: number; cacheMissTokens?: number; reasoningTokens?: number; cost?: number; currency?: string; estimated: boolean; message: string }
  | { type: "context_usage_event"; seq: number; timestamp: string; branchId?: string; source: "local_estimate"; inputTokens: number; contextWindowTokens: number; contextUsedPercent: number; estimated: true; message: string }
  | { type: "skill_used"; seq: number; timestamp: string; branchId?: string; skillName: string; filePath: string; message: string }
  | { type: "skill_event"; seq: number; timestamp: string; branchId?: string; action: string; message: string }
  | { type: "mcp_elicitation_request"; seq: number; timestamp: string; branchId?: string; elicitationId: string; serverId: string; serverName: string; message: string; requestedSchema?: Record<string, unknown>; status: "pending"; expiresAt: string }
  | { type: "mcp_elicitation_response"; seq: number; timestamp: string; branchId?: string; elicitationId: string; serverId: string; serverName: string; action: "accept" | "decline" | "cancel" | "timeout"; message: string }
  | { type: "compaction_block"; seq: number; timestamp: string; branchId?: string; coversEvents: [number, number]; summary: string }
  | { type: "trigger_event"; seq: number; timestamp: string; branchId?: string; triggerKind: string; payload: Record<string, unknown> };
