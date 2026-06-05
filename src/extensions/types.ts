import type { McpCatalogEntry, McpServerConfig, McpServerStatus, McpToolMetadata } from "../mcp/types.js";
import type { InstallSkillResult } from "../skills/skill-store.js";
import type { SkillManifest, SkillSource, SkillStatusSummary } from "../skills/types.js";

export type ExtensionKind = "skill" | "mcp_server" | "bundle";

export type ExtensionTrust = "official" | "curated" | "trusted" | "community" | "untrusted" | "quarantined" | "local";

export type ExtensionRisk = "safe" | "caution" | "dangerous";
export type ExtensionReviewState = "safe" | "warning" | "blocked" | "setup_required";
export type ExtensionReviewAction = "none" | "trust_enable" | "fix_required" | "setup_required";

export type ExtensionRegistrySourceKind = "builtin" | "file" | "http" | "github";

export type ExtensionRegistrySource = {
  id: string;
  kind: ExtensionRegistrySourceKind;
  name: string;
  enabled: boolean;
  url?: string;
  path?: string;
  trust: ExtensionTrust;
  trustUnsigned?: boolean;
  addedAt: string;
  updatedAt: string;
  lastRefreshAt?: string;
  lastError?: string;
};

export type ExtensionRegistryEntry = {
  id: string;
  kind: ExtensionKind;
  name: string;
  title: string;
  description: string;
  source: string;
  sourceLabel: string;
  trust: ExtensionTrust;
  version?: string;
  capabilities: string[];
  risk: ExtensionRisk;
  riskSummary: string;
  installInput: ExtensionInstallInput;
  provenance: {
    type: "builtin" | "github" | "npm" | "http" | "file";
    url?: string;
    packageName?: string;
    packageVersion?: string;
    repository?: string;
    sha256?: string;
    signature?: string;
  };
  tags?: string[];
  recommended?: boolean;
  setupRequired?: boolean;
  reviewState?: ExtensionReviewState;
  reviewAction?: ExtensionReviewAction;
  postInstall?: string;
  defaultEnabledTools?: string[];
  registrySourceId?: string;
  metadata?: Record<string, unknown>;
};

export type ExtensionLockRecord = {
  id: string;
  kind: ExtensionKind;
  name: string;
  version?: string;
  source: string;
  sourceLabel: string;
  trust: ExtensionTrust;
  risk: ExtensionRisk;
  installedAt: string;
  enabledAt?: string;
  status: ExtensionInstallResult["status"];
  installInput: ExtensionInstallInput;
  resultId: string;
  scanVerdict?: string;
  bundleParent?: string;
  provenance?: ExtensionRegistryEntry["provenance"];
};

export type ExtensionEventRecord = {
  seq: number;
  timestamp: string;
  detail: "installed" | "enabled" | "disabled" | "source_added" | "source_removed" | "source_refreshed" | "failed";
  message: string;
  extensionId?: string;
  kind?: ExtensionKind;
  sourceId?: string;
  payload?: Record<string, unknown>;
};

export type ExtensionCandidate = {
  id: string;
  kind: ExtensionKind;
  name: string;
  title: string;
  description: string;
  source: string;
  sourceLabel: string;
  trust: ExtensionTrust;
  installed: boolean;
  enabled: boolean;
  status: "available" | "installed" | "active" | "disabled" | "quarantined" | "invalid";
  capabilities: string[];
  riskSummary: string;
  installInput: ExtensionInstallInput;
  metadata?: Record<string, unknown>;
  recommended?: boolean;
  setupRequired?: boolean;
  reviewState?: ExtensionReviewState;
  reviewAction?: ExtensionReviewAction;
  postInstall?: string;
  lock?: ExtensionLockRecord;
  registrySourceId?: string;
};

export type ExtensionInstallInput =
  | {
      kind: "skill";
      name: string;
      version?: string;
      sourceId?: string;
      registryUrl?: string;
      trustUnsigned?: boolean;
      force?: boolean;
    }
  | {
      kind: "skill_github";
      url: string;
      name?: string;
      version?: string;
      force?: boolean;
      trustWarnings?: boolean;
    }
  | {
      kind: "mcp_catalog";
      catalogId: string;
      enable?: boolean;
    }
  | {
      kind: "mcp_server";
      server: Omit<McpServerConfig, "id"> & { id?: string };
      enable?: boolean;
    }
  | {
      kind: "bundle";
      name: string;
      items: ExtensionBundleItem[];
      enable?: boolean;
    };

export type ExtensionInstallResult = {
  kind: ExtensionKind;
  id: string;
  name: string;
  status: "installed" | "active" | "quarantined" | "invalid";
  message: string;
  skill?: SkillManifest;
  mcpServer?: McpServerConfig;
  scan?: InstallSkillResult["scan"];
  items?: ExtensionInstallResult[];
};

export type ExtensionBundleItem =
  | Extract<ExtensionInstallInput, { kind: "skill" }>
  | Extract<ExtensionInstallInput, { kind: "skill_github" }>
  | Extract<ExtensionInstallInput, { kind: "mcp_catalog" }>
  | Extract<ExtensionInstallInput, { kind: "mcp_server" }>;

export type ExtensionStatus = {
  skills: {
    status: SkillStatusSummary;
    sources: SkillSource[];
    entries: SkillManifest[];
  };
  mcp: {
    servers: McpServerStatus[];
    tools: McpToolMetadata[];
    catalog: McpCatalogEntry[];
  };
  counts: {
    installed: number;
    enabled: number;
    quarantined: number;
    invalid: number;
  };
  registry: {
    sources: ExtensionRegistrySource[];
    entries: ExtensionRegistryEntry[];
    locks: ExtensionLockRecord[];
    events: ExtensionEventRecord[];
    diagnostics: string[];
  };
};
