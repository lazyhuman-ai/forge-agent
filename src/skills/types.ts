import type { ToolCapability } from "../tools/schemas.js";

export type SkillTrust =
  | "official"
  | "project"
  | "local"
  | "community"
  | "generated"
  | "legacy";

export type SkillSourceKind =
  | "official"
  | "project"
  | "local"
  | "community"
  | "generated"
  | "legacy"
  | "remote";

export type SkillStatus =
  | "active"
  | "disabled"
  | "invalid"
  | "quarantined"
  | "archived";

export type SkillSource = {
  id: string;
  kind: SkillSourceKind;
  name: string;
  enabled: boolean;
  path?: string;
  url?: string;
  publicKey?: string;
  trustUnsigned?: boolean;
  trust?: SkillTrust;
  addedAt: string;
  updatedAt: string;
};

export type SkillPackageManifest = {
  schema?: string;
  name: string;
  version?: string;
  description: string;
  whenToUse?: string;
  tags?: string[];
  capabilities?: ToolCapability[];
  paths?: string[];
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  trust?: SkillTrust;
  source?: SkillSourceKind;
  requires?: {
    os?: string[];
    bin?: string[];
    env?: Record<string, string>;
  };
};

export type SkillManifest = SkillPackageManifest & {
  packageId: string;
  name: string;
  version: string;
  status: SkillStatus;
  trust: SkillTrust;
  source: SkillSourceKind;
  sourceId: string;
  location: string;
  directory: string;
  manifestPath?: string;
  invalidReason?: string;
  scanVerdict?: SkillScanVerdict;
  scanSummary?: SkillScanSummary;
  supportFiles?: string[];
  generatedFrom?: string;
  updatedAt: string;
};

export type SkillActivePointer = {
  name: string;
  packageId: string;
  version: string;
  previousPackageId?: string;
  updatedAt: string;
};

export type SkillStoreState = {
  schema: "forge.skill-store.state.v1";
  sources: SkillSource[];
  active: Record<string, SkillActivePointer>;
  disabled: Record<string, { disabledAt: string; reason?: string }>;
  packageStatus: Record<string, {
    status: SkillStatus;
    reason?: string;
    updatedAt: string;
  }>;
  migrations?: Record<string, boolean>;
};

export type SkillEventAction =
  | "installed"
  | "updated"
  | "enabled"
  | "disabled"
  | "rollback"
  | "quarantined"
  | "rejected"
  | "source_added"
  | "source_removed"
  | "index_rebuilt"
  | "proposal_created"
  | "proposal_rejected"
  | "proposal_applied"
  | "evolution_degraded"
  | "evolution_recovered";

export type SkillEventRecord = {
  type: "skill_event";
  seq: number;
  timestamp: string;
  sessionId: string;
  action: SkillEventAction;
  skillName?: string;
  packageId?: string;
  status?: SkillStatus;
  trust?: SkillTrust;
  source?: SkillSourceKind;
  message: string;
  payload?: Record<string, unknown>;
};

export type SkillScanSeverity = "info" | "warn" | "critical";

export type SkillScanFinding = {
  ruleId: string;
  severity: SkillScanSeverity;
  file: string;
  line: number;
  message: string;
  evidence: string;
};

export type SkillScanVerdict = "safe" | "caution" | "dangerous";
export type SkillReviewState = "safe" | "warning" | "blocked";
export type SkillReviewAction = "none" | "trust_enable" | "fix_required";

export type SkillScanSummary = {
  scannedFiles: number;
  totalBytes: number;
  verdict: SkillScanVerdict;
  reviewState: SkillReviewState;
  reviewAction: SkillReviewAction;
  findings: SkillScanFinding[];
};

export type SkillRegistryIndex = {
  schema: "forge.skill-registry.v1";
  sourceId?: string;
  generatedAt?: string;
  signed?: {
    algorithm: "ed25519";
    publicKey?: string;
    signature: string;
  };
  packages: SkillRegistryPackage[];
};

export type SkillRegistryPackage = {
  name: string;
  version: string;
  description: string;
  trust?: SkillTrust;
  source?: SkillSourceKind;
  whenToUse?: string;
  tags?: string[];
  capabilities?: ToolCapability[];
  paths?: string[];
  files: SkillRegistryFile[];
};

export type SkillRegistryFile = {
  path: string;
  url: string;
  sha256: string;
  sizeBytes?: number;
};

export type SkillProposalStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "quarantined";

export type SkillProposal = {
  schema: "forge.skill-proposal.v1";
  id: string;
  status: SkillProposalStatus;
  action: "create" | "update" | "archive" | "reject";
  skillName: string;
  parentPackageId?: string;
  generatedPackageId?: string;
  title: string;
  rationale: string;
  sourceSessionId?: string;
  sourceSeqs: number[];
  createdAt: string;
  updatedAt: string;
  rejectedReason?: string;
};

export type SkillEvalRun = {
  schema: "forge.skill-eval-run.v1";
  id: string;
  proposalId: string;
  packageId: string;
  status: "passed" | "failed";
  staticScan: SkillScanSummary;
  judgeReason: string;
  createdAt: string;
};

export type SkillStatusSummary = {
  active: number;
  disabled: number;
  invalid: number;
  quarantined: number;
  generated: number;
  total: number;
  sources: number;
  promptBudgetTokens: number;
  promptTruncated: boolean;
  manifestPath: string;
  lastEvent?: SkillEventRecord;
};

export type SkillRenderContext = {
  latestUserText?: string;
  recentPaths?: string[];
  promptBudgetTokens?: number;
};
