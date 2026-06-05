import type { ToolDefinition } from "../tools/schemas.js";

export type McpTransportKind = "stdio" | "streamable-http" | "sse";
export type McpLaunchMode = "eager" | "background" | "lazy";
export type McpTrust = "trusted" | "untrusted" | "quarantined";
export type McpServerState =
  | "disabled"
  | "configured"
  | "connecting"
  | "connected"
  | "degraded"
  | "needs_auth"
  | "failed";

export type McpServerConfig = {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransportKind;
  launchMode: McpLaunchMode;
  trust: McpTrust;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  roots?: string[];
  timeoutMs?: number;
  connectTimeoutMs?: number;
  supportsParallelToolCalls?: boolean;
  allowSampling?: boolean;
  allowElicitation?: boolean;
  source?: "local" | "project" | "imported" | "catalog";
  sourcePath?: string;
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

export type McpResourceMetadata = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

export type McpPromptMetadata = {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

export type McpServerStatus = {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransportKind;
  launchMode: McpLaunchMode;
  trust: McpTrust;
  state: McpServerState;
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

export type McpEvent = {
  seq: number;
  timestamp: string;
  serverId?: string;
  serverName?: string;
  detail: string;
  message: string;
  payload?: Record<string, unknown>;
};

export type McpCatalogEntry = {
  id: string;
  name: string;
  description?: string;
  transport: McpTransportKind;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  sha256?: string;
  trust?: McpTrust;
  sourceUrl?: string;
  packageName?: string;
  packageVersion?: string;
  auth?: {
    type: "none" | "api_key" | "oauth";
    env?: Array<{
      name: string;
      prompt?: string;
      required?: boolean;
      secret?: boolean;
      default?: string;
    }>;
    provider?: string;
    scopes?: string[];
    envVar?: string;
  };
  defaultEnabledTools?: string[];
  postInstall?: string;
  setupRequired?: boolean;
  tags?: string[];
};

export type McpToolProjection = {
  tools: ToolDefinition[];
  metadata: McpToolMetadata[];
};

export type McpElicitationPublicRequest = {
  id: string;
  sessionId: string;
  serverId: string;
  serverName: string;
  message: string;
  requestedSchema?: Record<string, unknown>;
  status: "pending";
  expiresAt: string;
};
