import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { homedir, platform } from "node:os";
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  normalizeSkillPath,
  scanSkillPackage,
  shouldEnableSkill,
} from "./skill-scanner.js";
import type {
  SkillActivePointer,
  SkillEventAction,
  SkillEventRecord,
  SkillManifest,
  SkillPackageManifest,
  SkillRegistryFile,
  SkillRegistryIndex,
  SkillRegistryPackage,
  SkillRenderContext,
  SkillReviewState,
  SkillScanSummary,
  SkillSource,
  SkillSourceKind,
  SkillStatus,
  SkillStatusSummary,
  SkillStoreState,
  SkillTrust,
} from "./types.js";

const STATE_FILE = "state.json";
const INDEX_FILE = "index.json";
const MANIFEST_FILE = "MANIFEST.md";
const EVENTS_FILE = "events.jsonl";
const AUDIT_FILE = "audit.jsonl";
const SKILL_MD_MAX_BYTES = 256 * 1024;
const DEFAULT_PROMPT_BUDGET_TOKENS = 4_000;
const RESERVED_ROOTS = new Set([
  "installed",
  "generated",
  "proposals",
  "eval-runs",
  "registry-cache",
  "archive",
  "quarantine",
  STATE_FILE,
  INDEX_FILE,
  MANIFEST_FILE,
  EVENTS_FILE,
  AUDIT_FILE,
]);

type LoadedSkill = {
  manifest: SkillManifest;
  body: string;
};

type EnableSkillOptions = {
  trustWarnings?: boolean;
};

type SkillEventInput = Omit<SkillEventRecord, "type" | "seq" | "timestamp" | "sessionId" | "action"> & {
  sessionId?: string;
};

export type SkillStoreOptions = {
  rootDir?: string;
  projectRoot?: string;
  promptBudgetTokens?: number;
  now?: () => string;
  nextSeq?: () => number;
  onEvent?: (event: SkillEventRecord) => void;
  sources?: SkillSource[];
};

export type InstallSkillInput = {
  name: string;
  version?: string;
  sourceId?: string;
  registryUrl?: string;
  trustUnsigned?: boolean;
  force?: boolean;
};

export type InstallSkillResult = {
  skill: SkillManifest;
  scan: SkillScanSummary;
  event: SkillEventRecord;
};

export type InstallExternalSkillInput = {
  name?: string;
  version?: string;
  skillMd: string;
  skillJson?: Partial<SkillPackageManifest>;
  supportFiles?: Array<{ path: string; content: string | Uint8Array }>;
  sourceUrl: string;
  trust?: SkillTrust;
  force?: boolean;
};

export class SkillStore {
  readonly rootDir: string;
  readonly manifestPath: string;
  #projectRoot: string;
  #promptBudgetTokens: number;
  #now: () => string;
  #nextSeq: () => number;
  #onEvent: ((event: SkillEventRecord) => void) | undefined;
  #state: SkillStoreState;
  #entries: SkillManifest[] = [];
  #events: SkillEventRecord[] = [];
  #promptTruncated = false;

  constructor(options?: SkillStoreOptions) {
    this.rootDir = resolve(options?.rootDir ?? ".forge/skills");
    this.manifestPath = join(this.rootDir, MANIFEST_FILE);
    this.#projectRoot = resolve(options?.projectRoot ?? process.cwd());
    this.#promptBudgetTokens = options?.promptBudgetTokens ?? DEFAULT_PROMPT_BUDGET_TOKENS;
    this.#now = options?.now ?? (() => new Date().toISOString());
    this.#nextSeq = options?.nextSeq ?? (() => this.#events.length + 1);
    this.#onEvent = options?.onEvent;
    this.#ensureLayout();
    this.#state = this.#loadState(options?.sources);
    this.#events = this.#loadEvents();
    this.rebuildIndex();
  }

  list(filter?: { includeInactive?: boolean; status?: SkillStatus }): SkillManifest[] {
    const includeInactive = filter?.includeInactive === true;
    return this.#entries.filter((entry) => {
      if (filter?.status && entry.status !== filter.status) return false;
      return includeInactive || entry.status === "active";
    });
  }

  get(name: string): SkillManifest | null {
    return this.#entries.find((entry) => entry.name === name && entry.status === "active")
      ?? this.#entries.find((entry) => entry.name === name)
      ?? null;
  }

  getByPackageId(packageId: string): SkillManifest | null {
    return this.#entries.find((entry) => entry.packageId === packageId) ?? null;
  }

  getStatus(): SkillStatusSummary {
    const summary: SkillStatusSummary = {
      active: this.#entries.filter((entry) => entry.status === "active").length,
      disabled: this.#entries.filter((entry) => entry.status === "disabled").length,
      invalid: this.#entries.filter((entry) => entry.status === "invalid").length,
      quarantined: this.#entries.filter((entry) => entry.status === "quarantined").length,
      generated: this.#entries.filter((entry) => entry.trust === "generated").length,
      total: this.#entries.length,
      sources: this.#state.sources.filter((source) => source.enabled).length,
      promptBudgetTokens: this.#promptBudgetTokens,
      promptTruncated: this.#promptTruncated,
      manifestPath: this.manifestPath,
    };
    const last = this.#events.at(-1);
    if (last) summary.lastEvent = last;
    return summary;
  }

  listSources(): SkillSource[] {
    return [...this.#state.sources];
  }

  addSource(input: {
    id?: string;
    name: string;
    url: string;
    publicKey?: string;
    trustUnsigned?: boolean;
    trust?: SkillTrust;
  }): SkillSource {
    const now = this.#now();
    const id = input.id ?? normalizeName(input.name || input.url);
    const existing = this.#state.sources.find((source) => source.id === id);
    const source: SkillSource = {
      id,
      kind: "remote",
      name: input.name,
      enabled: true,
      url: input.url,
      trustUnsigned: input.trustUnsigned === true,
      trust: input.trust ?? "community",
      addedAt: existing?.addedAt ?? now,
      updatedAt: now,
    };
    if (input.publicKey) source.publicKey = input.publicKey;
    this.#state.sources = [
      ...this.#state.sources.filter((s) => s.id !== id),
      source,
    ];
    this.#saveState();
    const event = this.#appendEvent("source_added", {
      message: `Skill source added: ${source.name} (${source.url})`,
      source: "remote",
      payload: { sourceId: source.id, url: source.url },
    });
    this.#appendAudit(event);
    return source;
  }

  removeSource(sourceId: string): boolean {
    const existing = this.#state.sources.find((source) => source.id === sourceId);
    if (!existing) return false;
    this.#state.sources = this.#state.sources.filter((source) => source.id !== sourceId);
    this.#saveState();
    const event = this.#appendEvent("source_removed", {
      message: `Skill source removed: ${existing.name}`,
      source: existing.kind,
      payload: { sourceId },
    });
    this.#appendAudit(event);
    return true;
  }

  async install(input: InstallSkillInput): Promise<InstallSkillResult> {
    const source = await this.#resolveRemoteSource(input);
    const registry = await this.#fetchRegistry(source, input.registryUrl);
    const pkg = this.#selectRegistryPackage(registry, input.name, input.version);
    const tempDir = join(this.rootDir, "quarantine", `${pkg.name}-${pkg.version}-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      for (const file of pkg.files) {
        await this.#downloadRegistryFile(file, tempDir);
      }

      const skillJsonPath = join(tempDir, "skill.json");
      if (!existsSync(skillJsonPath)) {
        const generated: SkillPackageManifest = {
          schema: "forge.skill.v1",
          name: pkg.name,
          version: pkg.version,
          description: pkg.description,
          trust: pkg.trust ?? source.trust ?? "community",
          source: source.kind === "remote" ? "community" : source.kind,
        };
        if (pkg.whenToUse !== undefined) generated.whenToUse = pkg.whenToUse;
        if (pkg.tags !== undefined) generated.tags = pkg.tags;
        if (pkg.capabilities !== undefined) generated.capabilities = pkg.capabilities;
        if (pkg.paths !== undefined) generated.paths = pkg.paths;
        atomicWriteJson(skillJsonPath, generated);
      }

      const loaded = this.#loadPackage(tempDir, {
        sourceId: source.id,
        source: source.kind === "remote" ? "community" : source.kind,
        trust: pkg.trust ?? source.trust ?? "community",
        packageId: packageId(pkg.name, pkg.version, "installed"),
      });
      const scan = scanSkillPackage(tempDir);
      const decisionInput: Parameters<typeof shouldEnableSkill>[0] = {
        trust: loaded.manifest.trust,
        scan,
      };
      if (input.force !== undefined) decisionInput.force = input.force;
      const decision = shouldEnableSkill(decisionInput);
      loaded.manifest.scanVerdict = scan.verdict;
      loaded.manifest.scanSummary = scan;
      const unsignedInstallRequiresQuarantine = source.trustUnsigned === true && registry.signed?.signature === undefined;

      if (!decision.allow) {
        loaded.manifest.status = decision.quarantine ? "quarantined" : "invalid";
        loaded.manifest.invalidReason = decision.reason;
        if (decision.quarantine) {
          const installDir = join(this.rootDir, "installed", loaded.manifest.name, loaded.manifest.version);
          rmSync(installDir, { recursive: true, force: true });
          mkdirSync(dirname(installDir), { recursive: true });
          renameSync(tempDir, installDir);
          loaded.manifest.location = join(installDir, "SKILL.md");
          loaded.manifest.directory = installDir;
        }
        this.#state.packageStatus[loaded.manifest.packageId] = {
          status: loaded.manifest.status,
          reason: decision.reason,
          updatedAt: this.#now(),
        };
        this.#saveState();
        const event = this.#appendEvent(decision.quarantine ? "quarantined" : "rejected", {
          skillName: loaded.manifest.name,
          packageId: loaded.manifest.packageId,
          status: loaded.manifest.status,
          trust: loaded.manifest.trust,
          source: loaded.manifest.source,
          message: `Skill ${loaded.manifest.name} ${loaded.manifest.version} was not enabled: ${decision.reason}`,
          payload: { scan },
        });
        this.#appendAudit(event);
        this.rebuildIndex();
        return { skill: loaded.manifest, scan, event };
      }

      const installDir = join(this.rootDir, "installed", loaded.manifest.name, loaded.manifest.version);
      rmSync(installDir, { recursive: true, force: true });
      mkdirSync(dirname(installDir), { recursive: true });
      renameSync(tempDir, installDir);
      const installed = this.#loadPackage(installDir, {
        sourceId: source.id,
        source: loaded.manifest.source,
        trust: loaded.manifest.trust,
        packageId: loaded.manifest.packageId,
      }).manifest;
      installed.scanVerdict = scan.verdict;
      installed.scanSummary = scan;
      if (unsignedInstallRequiresQuarantine) {
        installed.status = "quarantined";
        installed.invalidReason = "Unsigned remote skill source was installed into quarantine.";
        this.#state.packageStatus[installed.packageId] = {
          status: "quarantined",
          reason: installed.invalidReason,
          updatedAt: this.#now(),
        };
        this.#saveState();
        this.rebuildIndex();
        const event = this.#appendEvent("quarantined", {
          skillName: installed.name,
          packageId: installed.packageId,
          status: "quarantined",
          trust: installed.trust,
          source: installed.source,
          message: `Skill installed into quarantine because the source is unsigned: ${installed.name} ${installed.version}`,
          payload: { sourceId: source.id, scan },
        });
        this.#appendAudit(event);
        return { skill: installed, scan, event };
      }
      this.#activate(installed, "installed");
      this.rebuildIndex();
      const event = this.#appendEvent("installed", {
        skillName: installed.name,
        packageId: installed.packageId,
        status: "active",
        trust: installed.trust,
        source: installed.source,
        message: `Skill installed and enabled: ${installed.name} ${installed.version}`,
        payload: { sourceId: source.id, scan },
      });
      this.#appendAudit(event);
      return { skill: installed, scan, event };
    } finally {
      if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    }
  }

  installExternalPackage(input: InstallExternalSkillInput): InstallSkillResult {
    const tempDir = join(this.rootDir, "quarantine", `external-skill-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      atomicWrite(join(tempDir, "SKILL.md"), input.skillMd);
      const manifestPatch: Partial<SkillPackageManifest> = {
        ...(input.skillJson ?? {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.version ? { version: input.version } : {}),
        trust: input.trust ?? input.skillJson?.trust ?? "community",
        source: "community",
      };
      if (Object.keys(manifestPatch).length > 0) {
        atomicWriteJson(join(tempDir, "skill.json"), manifestPatch);
      }
      for (const file of input.supportFiles ?? []) {
        const rel = normalizeSkillPath(file.path);
        if (rel === "SKILL.md" || rel === "skill.json") continue;
        const target = join(tempDir, rel);
        mkdirSync(dirname(target), { recursive: true });
        atomicWriteBytes(target, file.content);
      }

      const sourceId = `external-${createHash("sha256").update(input.sourceUrl).digest("hex").slice(0, 12)}`;
      const loaded = this.#loadPackage(tempDir, {
        sourceId,
        source: "community",
        trust: input.trust ?? input.skillJson?.trust ?? "community",
        packageId: packageId(input.name ?? "external-skill", input.version ?? "0.0.0", "installed"),
      });
      const scan = scanSkillPackage(tempDir);
      const decisionInput: Parameters<typeof shouldEnableSkill>[0] = {
        trust: loaded.manifest.trust,
        scan,
      };
      if (input.force !== undefined) decisionInput.force = input.force;
      const decision = shouldEnableSkill(decisionInput);
      loaded.manifest.scanVerdict = scan.verdict;
      loaded.manifest.scanSummary = scan;

      if (!decision.allow) {
        loaded.manifest.status = decision.quarantine ? "quarantined" : "invalid";
        loaded.manifest.invalidReason = decision.reason;
        if (decision.quarantine) {
          const installDir = join(this.rootDir, "installed", loaded.manifest.name, loaded.manifest.version);
          rmSync(installDir, { recursive: true, force: true });
          mkdirSync(dirname(installDir), { recursive: true });
          renameSync(tempDir, installDir);
          loaded.manifest.location = join(installDir, "SKILL.md");
          loaded.manifest.directory = installDir;
        }
        this.#state.packageStatus[loaded.manifest.packageId] = {
          status: loaded.manifest.status,
          reason: decision.reason,
          updatedAt: this.#now(),
        };
        this.#saveState();
        const event = this.#appendEvent(decision.quarantine ? "quarantined" : "rejected", {
          skillName: loaded.manifest.name,
          packageId: loaded.manifest.packageId,
          status: loaded.manifest.status,
          trust: loaded.manifest.trust,
          source: loaded.manifest.source,
          message: `External skill ${loaded.manifest.name} ${loaded.manifest.version} was not enabled: ${decision.reason}`,
          payload: { sourceUrl: input.sourceUrl, scan },
        });
        this.#appendAudit(event);
        this.rebuildIndex();
        return { skill: loaded.manifest, scan, event };
      }

      const installDir = join(this.rootDir, "installed", loaded.manifest.name, loaded.manifest.version);
      rmSync(installDir, { recursive: true, force: true });
      mkdirSync(dirname(installDir), { recursive: true });
      renameSync(tempDir, installDir);
      const installed = this.#loadPackage(installDir, {
        sourceId,
        source: "community",
        trust: loaded.manifest.trust,
        packageId: loaded.manifest.packageId,
      }).manifest;
      installed.scanVerdict = scan.verdict;
      installed.scanSummary = scan;
      this.#activate(installed, "installed");
      this.rebuildIndex();
      const event = this.#appendEvent("installed", {
        skillName: installed.name,
        packageId: installed.packageId,
        status: "active",
        trust: installed.trust,
        source: installed.source,
        message: `External skill installed and enabled: ${installed.name} ${installed.version}`,
        payload: { sourceUrl: input.sourceUrl, scan },
      });
      this.#appendAudit(event);
      return { skill: installed, scan, event };
    } finally {
      if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    }
  }

  enable(name: string, version?: string, options?: EnableSkillOptions): SkillManifest {
    const candidates = this.#entries
      .filter((entry) => entry.name === name && (!version || entry.version === version))
      .sort((a, b) => b.version.localeCompare(a.version));
    const selected = candidates[0];
    if (!selected) throw new Error(`Skill not found: ${name}${version ? ` ${version}` : ""}`);
    if (selected.status === "invalid" || selected.status === "quarantined") {
      const reviewState = selected.scanSummary?.reviewState
        ?? reviewStateFromLegacyVerdict(selected.scanVerdict);
      const canTrust = selected.status === "quarantined"
        ? reviewState !== "blocked"
        : reviewState === "warning";
      if (!canTrust || options?.trustWarnings !== true) {
        throw new Error(`Cannot enable ${name}: ${selected.invalidReason ?? selected.status}`);
      }
    }
    this.#activate(selected, "enabled");
    delete this.#state.disabled[name];
    this.#saveState();
    this.rebuildIndex();
    const eventInput: SkillEventInput = {
      skillName: selected.name,
      packageId: selected.packageId,
      status: "active",
      trust: selected.trust,
      source: selected.source,
      message: selected.scanSummary?.reviewState === "warning"
        ? `Skill enabled with scanner warnings trusted: ${selected.name} ${selected.version}`
        : `Skill enabled: ${selected.name} ${selected.version}`,
    };
    if (selected.scanSummary?.reviewState === "warning") eventInput.payload = { scan: selected.scanSummary };
    const event = this.#appendEvent("enabled", eventInput);
    this.#appendAudit(event);
    return this.get(name) ?? selected;
  }

  disable(name: string, reason?: string): SkillManifest {
    const entry = this.get(name);
    if (!entry) throw new Error(`Skill not found: ${name}`);
    this.#state.disabled[name] = {
      disabledAt: this.#now(),
      ...(reason ? { reason } : {}),
    };
    this.#state.packageStatus[entry.packageId] = {
      status: "disabled",
      ...(reason ? { reason } : {}),
      updatedAt: this.#now(),
    };
    this.#saveState();
    this.rebuildIndex();
    const event = this.#appendEvent("disabled", {
      skillName: entry.name,
      packageId: entry.packageId,
      status: "disabled",
      trust: entry.trust,
      source: entry.source,
      message: `Skill disabled: ${entry.name}${reason ? ` (${reason})` : ""}`,
    });
    this.#appendAudit(event);
    return this.#entries.find((candidate) => candidate.packageId === entry.packageId) ?? entry;
  }

  rollback(name: string): SkillManifest {
    const current = this.#state.active[name];
    if (!current?.previousPackageId) throw new Error(`No rollback target for skill: ${name}`);
    const previous = this.getByPackageId(current.previousPackageId);
    if (!previous) throw new Error(`Rollback target is missing for skill: ${name}`);
    this.#activate(previous, "rollback");
    this.rebuildIndex();
    const event = this.#appendEvent("rollback", {
      skillName: previous.name,
      packageId: previous.packageId,
      status: "active",
      trust: previous.trust,
      source: previous.source,
      message: `Skill rolled back: ${previous.name} ${previous.version}`,
    });
    this.#appendAudit(event);
    return this.get(name) ?? previous;
  }

  installGeneratedPackage(input: {
    name: string;
    version?: string;
    skillMd: string;
    manifest?: Partial<SkillPackageManifest>;
    supportFiles?: Array<{ path: string; content: string }>;
    parentPackageId?: string;
    proposalId?: string;
  }): { skill: SkillManifest; scan: SkillScanSummary; event: SkillEventRecord } {
    const version = input.version ?? generatedVersion();
    const skillName = normalizeName(input.name);
    const packageDir = join(this.rootDir, "generated", skillName, version);
    rmSync(packageDir, { recursive: true, force: true });
    mkdirSync(packageDir, { recursive: true });
    const manifest: SkillPackageManifest = {
      schema: "forge.skill.v1",
      name: skillName,
      version,
      description: input.manifest?.description ?? `Generated skill: ${skillName}`,
      trust: "generated",
      source: "generated",
    };
    if (input.manifest?.whenToUse !== undefined) manifest.whenToUse = input.manifest.whenToUse;
    if (input.manifest?.tags !== undefined) manifest.tags = input.manifest.tags;
    if (input.manifest?.capabilities !== undefined) manifest.capabilities = input.manifest.capabilities;
    if (input.manifest?.paths !== undefined) manifest.paths = input.manifest.paths;
    atomicWriteJson(join(packageDir, "skill.json"), manifest);
    atomicWrite(join(packageDir, "SKILL.md"), input.skillMd);
    for (const file of input.supportFiles ?? []) {
      const rel = normalizeSkillPath(file.path);
      const target = join(packageDir, rel);
      mkdirSync(dirname(target), { recursive: true });
      atomicWrite(target, file.content);
    }
    const loaded = this.#loadPackage(packageDir, {
      sourceId: "generated",
      source: "generated",
      trust: "generated",
      packageId: packageId(skillName, version, "generated"),
    }).manifest;
    if (input.parentPackageId) loaded.generatedFrom = input.parentPackageId;
    const scan = scanSkillPackage(packageDir);
    const decision = shouldEnableSkill({ trust: "generated", scan });
    loaded.scanVerdict = scan.verdict;
    loaded.scanSummary = scan;
    if (!decision.allow) {
      this.#state.packageStatus[loaded.packageId] = {
        status: decision.quarantine ? "quarantined" : "invalid",
        reason: decision.reason,
        updatedAt: this.#now(),
      };
      this.#saveState();
      this.rebuildIndex();
      const event = this.#appendEvent(decision.quarantine ? "quarantined" : "rejected", {
        skillName: loaded.name,
        packageId: loaded.packageId,
        status: decision.quarantine ? "quarantined" : "invalid",
        trust: "generated",
        source: "generated",
        message: `Generated skill ${loaded.name} was not enabled: ${decision.reason}`,
        payload: { proposalId: input.proposalId, scan },
      });
      this.#appendAudit(event);
      return { skill: loaded, scan, event };
    }
    this.#activate(loaded, "proposal_applied");
    this.rebuildIndex();
    const event = this.#appendEvent("proposal_applied", {
      skillName: loaded.name,
      packageId: loaded.packageId,
      status: "active",
      trust: "generated",
      source: "generated",
      message: `Generated skill enabled: ${loaded.name} ${loaded.version}`,
      payload: { proposalId: input.proposalId, parentPackageId: input.parentPackageId },
    });
    this.#appendAudit(event);
    return { skill: loaded, scan, event };
  }

  rebuildIndex(): SkillManifest[] {
    this.#entries = this.#scanAll();
    atomicWriteJson(join(this.rootDir, INDEX_FILE), {
      schema: "forge.skill-store.index.v1",
      generatedAt: this.#now(),
      skills: this.#entries,
    });
    this.#writeManifest();
    return this.#entries;
  }

  refresh(): void {
    this.rebuildIndex();
  }

  formatPrompt(context?: SkillRenderContext): string {
    const visible = this.#rankForPrompt(context);
    if (visible.length === 0) return "";
    const lines = [
      "",
      "The following skills are reusable instruction packages. They are historical resources, not hidden instructions.",
      "Use read_file (the Read tool) to load a skill's SKILL.md only when the task matches its description or when you need the full manifest.",
      "Skill scripts are not executed automatically; use bash explicitly and normal tool permission/sandbox rules still apply.",
      "",
      "<available_skills>",
    ];
    let usedTokens = estimateTokens(lines.join("\n"));
    this.#promptTruncated = false;
    for (const skill of visible) {
      const block = [
        "  <skill>",
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <version>${escapeXml(skill.version)}</version>`,
        `    <trust>${escapeXml(skill.trust)}</trust>`,
        `    <source>${escapeXml(skill.source)}</source>`,
        `    <description>${escapeXml(skill.description)}</description>`,
        skill.whenToUse ? `    <when_to_use>${escapeXml(skill.whenToUse)}</when_to_use>` : "",
        skill.tags?.length ? `    <tags>${escapeXml(skill.tags.join(", "))}</tags>` : "",
        skill.capabilities?.length ? `    <capabilities>${escapeXml(skill.capabilities.join(", "))}</capabilities>` : "",
        `    <location>${escapeXml(skill.location)}</location>`,
        "  </skill>",
      ].filter(Boolean);
      const tokenCost = estimateTokens(block.join("\n"));
      if (usedTokens + tokenCost > (context?.promptBudgetTokens ?? this.#promptBudgetTokens)) {
        this.#promptTruncated = true;
        break;
      }
      lines.push(...block);
      usedTokens += tokenCost;
    }
    lines.push("</available_skills>");
    if (this.#promptTruncated) {
      lines.push(`Full skill manifest: ${this.manifestPath}`);
    }
    return lines.join("\n");
  }

  getPromptInstructions(): string {
    return [
      "",
      "## Skills",
      "",
      "Before replying, scan <available_skills> descriptions.",
      "- If one skill clearly applies: use read_file (the Read tool) on its SKILL.md at <location>, then follow it.",
      "- If multiple could apply: choose the most specific one; read only what you need.",
      "- If none clearly apply: do not read a skill just because it exists.",
      "- Resolve relative references against the skill directory.",
      "- Read references/templates only when a step requires them.",
      "- Scripts in skills are normal files; run them only through explicit tools and normal permission/sandbox checks.",
    ].join("\n");
  }

  matchPath(filePath: string): SkillManifest | null {
    const absolute = resolve(filePath);
    const active = this.list();
    let best: SkillManifest | null = null;
    for (const skill of active) {
      const dir = resolve(skill.directory);
      if (absolute === resolve(skill.location) || isInside(absolute, dir)) {
        if (!best || dir.length > best.directory.length) best = skill;
      }
    }
    return best;
  }

  getEvents(afterSeq = 0): SkillEventRecord[] {
    return this.#events.filter((event) => event.seq > afterSeq);
  }

  appendLifecycleEvent(
    action: SkillEventAction,
    params: Omit<Partial<SkillEventRecord>, "type" | "seq" | "timestamp" | "action" | "message"> & {
      message: string;
    },
  ): SkillEventRecord {
    const event = this.#appendEvent(action, params);
    this.#appendAudit(event);
    return event;
  }

  get entries(): SkillManifest[] {
    return this.list({ includeInactive: true });
  }

  setProjectRoot(projectRoot: string): void {
    const resolved = resolve(projectRoot);
    if (resolved === this.#projectRoot) return;
    this.#projectRoot = resolved;
    const timestamp = this.#now();
    const projectSources = defaultSources(this.rootDir, this.#projectRoot, timestamp)
      .filter((source) => source.id === "project-skills" || source.id === "project-agents-skills");
    const byId = new Map(this.#state.sources.map((source) => [source.id, source]));
    for (const source of projectSources) byId.set(source.id, source);
    this.#state.sources = [...byId.values()];
    this.#saveState();
    this.rebuildIndex();
  }

  #ensureLayout(): void {
    for (const dir of [
      this.rootDir,
      join(this.rootDir, "installed"),
      join(this.rootDir, "generated"),
      join(this.rootDir, "proposals"),
      join(this.rootDir, "eval-runs"),
      join(this.rootDir, "registry-cache"),
      join(this.rootDir, "archive"),
      join(this.rootDir, "quarantine"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  #loadState(extraSources: SkillSource[] | undefined): SkillStoreState {
    const statePath = join(this.rootDir, STATE_FILE);
    let state: SkillStoreState | null = null;
    if (existsSync(statePath)) {
      try {
        state = JSON.parse(readFileSync(statePath, "utf-8")) as SkillStoreState;
      } catch {
        state = null;
      }
    }
    const now = this.#now();
    if (!state || state.schema !== "forge.skill-store.state.v1") {
      state = {
        schema: "forge.skill-store.state.v1",
        sources: defaultSources(this.rootDir, this.#projectRoot, now),
        active: {},
        disabled: {},
        packageStatus: {},
        migrations: {},
      };
    }
    const sourceMap = new Map(state.sources.map((source) => [source.id, source]));
    for (const source of [...defaultSources(this.rootDir, this.#projectRoot, now), ...(extraSources ?? [])]) {
      if (!sourceMap.has(source.id)) sourceMap.set(source.id, source);
    }
    state.sources = [...sourceMap.values()];
    atomicWriteJson(statePath, state);
    return state;
  }

  #saveState(): void {
    atomicWriteJson(join(this.rootDir, STATE_FILE), this.#state);
  }

  #loadEvents(): SkillEventRecord[] {
    const path = join(this.rootDir, EVENTS_FILE);
    if (!existsSync(path)) return [];
    const events: SkillEventRecord[] = [];
    for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as SkillEventRecord);
      } catch {
        // Ignore malformed event lines.
      }
    }
    return events;
  }

  #scanAll(): SkillManifest[] {
    const scanned: SkillManifest[] = [];
    for (const source of this.#state.sources) {
      if (!source.enabled) continue;
      if (!source.path) continue;
      if (!existsSync(source.path)) continue;
      scanned.push(...this.#scanLegacySource(source));
    }
    scanned.push(...this.#scanPackageTree("installed", "community"));
    scanned.push(...this.#scanPackageTree("generated", "generated"));
    const dedup = new Map<string, SkillManifest>();
    for (const skill of scanned) {
      const key = `${skill.name}:${skill.packageId}`;
      dedup.set(key, skill);
    }
    return [...dedup.values()].sort((a, b) => {
      const rank = statusRank(a.status) - statusRank(b.status);
      if (rank !== 0) return rank;
      return a.name.localeCompare(b.name) || b.version.localeCompare(a.version);
    });
  }

  #scanLegacySource(source: SkillSource): SkillManifest[] {
    const result: SkillManifest[] = [];
    for (const entry of readdirSync(source.path!, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (RESERVED_ROOTS.has(entry.name)) continue;
      const skillDir = join(source.path!, entry.name);
      const skillMd = join(skillDir, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const loaded = this.#safeLoadPackage(skillDir, {
        sourceId: source.id,
        source: source.kind === "remote" ? "community" : source.kind,
        trust: source.trust ?? trustForSource(source.kind),
        packageId: packageId(entry.name, "0.0.0", source.kind),
      });
      if (loaded) result.push(loaded.manifest);
    }
    return result;
  }

  #scanPackageTree(kind: "installed" | "generated", defaultTrust: SkillTrust): SkillManifest[] {
    const root = join(this.rootDir, kind);
    if (!existsSync(root)) return [];
    const result: SkillManifest[] = [];
    for (const nameEntry of readdirSync(root, { withFileTypes: true })) {
      if (!nameEntry.isDirectory()) continue;
      const nameDir = join(root, nameEntry.name);
      for (const versionEntry of readdirSync(nameDir, { withFileTypes: true })) {
        if (!versionEntry.isDirectory()) continue;
        const versionDir = join(nameDir, versionEntry.name);
        const loaded = this.#safeLoadPackage(versionDir, {
          sourceId: kind,
          source: kind === "generated" ? "generated" : "community",
          trust: defaultTrust,
          packageId: packageId(nameEntry.name, versionEntry.name, kind),
        });
        if (loaded) result.push(loaded.manifest);
      }
    }
    return result;
  }

  #safeLoadPackage(
    directory: string,
    defaults: {
      sourceId: string;
      source: SkillSourceKind;
      trust: SkillTrust;
      packageId: string;
    },
  ): LoadedSkill | null {
    try {
      const loaded = this.#loadPackage(directory, defaults);
      const scan = scanSkillPackage(directory);
      loaded.manifest.scanVerdict = scan.verdict;
      loaded.manifest.scanSummary = scan;
      if (loaded.manifest.status === "active") {
        const decision = shouldEnableSkill({
          trust: loaded.manifest.trust,
          scan,
        });
        if (!decision.allow) {
          loaded.manifest.status = decision.quarantine ? "quarantined" : "invalid";
          loaded.manifest.invalidReason = decision.reason;
        }
      } else if (
        (loaded.manifest.status === "invalid" || loaded.manifest.status === "quarantined") &&
        scan.reviewState === "warning"
      ) {
        loaded.manifest.status = "disabled";
        loaded.manifest.invalidReason = "Static scan found warnings. You can trust and enable this skill; runtime permissions and sandbox still apply.";
      }
      return loaded;
    } catch (err) {
      const name = normalizeName(directory.split(sep).at(-1) ?? "invalid-skill");
      return {
        body: "",
        manifest: {
          name,
          packageId: defaults.packageId,
          version: "0.0.0",
          description: `Invalid skill: ${err instanceof Error ? err.message : String(err)}`,
          status: "invalid",
          trust: defaults.trust,
          source: defaults.source,
          sourceId: defaults.sourceId,
          location: join(directory, "SKILL.md"),
          directory,
          invalidReason: err instanceof Error ? err.message : String(err),
          updatedAt: this.#now(),
        },
      };
    }
  }

  #loadPackage(
    directory: string,
    defaults: {
      sourceId: string;
      source: SkillSourceKind;
      trust: SkillTrust;
      packageId: string;
    },
  ): LoadedSkill {
    const skillMd = join(directory, "SKILL.md");
    if (!existsSync(skillMd)) throw new Error("Missing SKILL.md");
    const stat = statSync(skillMd);
    if (stat.size > SKILL_MD_MAX_BYTES) {
      throw new Error(`SKILL.md exceeds ${SKILL_MD_MAX_BYTES} bytes`);
    }
    const raw = readFileSync(skillMd, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const jsonManifest = readJsonIfExists(join(directory, "skill.json")) as Partial<SkillPackageManifest> | null;
    const merged = {
      ...frontmatter,
      ...(jsonManifest ?? {}),
    } as Partial<SkillPackageManifest>;
    const name = normalizeName(String(merged.name ?? directory.split(sep).at(-1) ?? ""));
    if (!name) throw new Error("Skill name is required.");
    const description = String(merged.description ?? "").trim();
    if (!description) throw new Error("Skill description is required.");
    const version = String(merged.version ?? "0.0.0");
    const packageIdValue = defaults.packageId.includes(name)
      ? defaults.packageId
      : packageId(name, version, defaults.source);
    let status = this.#state.packageStatus[packageIdValue]?.status ?? "active";
    const pointer = this.#state.active[name];
    if (pointer && pointer.packageId !== packageIdValue && defaults.source !== "legacy" && defaults.source !== "project" && defaults.source !== "local") {
      status = "archived";
    }
    if (this.#state.disabled[name]) status = "disabled";
    const storedStatus = this.#state.packageStatus[packageIdValue];
    const supportFiles = listSupportFiles(directory);
    const manifest: SkillManifest = {
      packageId: packageIdValue,
      name,
      version,
      description,
      status,
      trust: merged.trust ?? defaults.trust,
      source: merged.source ?? defaults.source,
      sourceId: defaults.sourceId,
      location: skillMd,
      directory,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      supportFiles,
    };
    if (merged.whenToUse !== undefined) manifest.whenToUse = String(merged.whenToUse);
    if (Array.isArray(merged.tags)) manifest.tags = merged.tags.map(String);
    if (Array.isArray(merged.capabilities)) manifest.capabilities = merged.capabilities;
    if (Array.isArray(merged.paths)) manifest.paths = merged.paths.map(String);
    if (Array.isArray(merged.allowedTools)) manifest.allowedTools = merged.allowedTools.map(String);
    if (merged.disableModelInvocation !== undefined) manifest.disableModelInvocation = Boolean(merged.disableModelInvocation);
    if (merged.userInvocable !== undefined) manifest.userInvocable = Boolean(merged.userInvocable);
    if (merged.requires) manifest.requires = merged.requires;
    if (jsonManifest) manifest.manifestPath = join(directory, "skill.json");
    if (storedStatus?.reason) manifest.invalidReason = storedStatus.reason;
    return { manifest, body };
  }

  #activate(skill: SkillManifest, _action: SkillEventAction): void {
    const previous = this.#state.active[skill.name];
    const pointer: SkillActivePointer = {
      name: skill.name,
      packageId: skill.packageId,
      version: skill.version,
      updatedAt: this.#now(),
    };
    if (previous && previous.packageId !== skill.packageId) {
      pointer.previousPackageId = previous.packageId;
    } else if (previous?.previousPackageId) {
      pointer.previousPackageId = previous.previousPackageId;
    }
    this.#state.active[skill.name] = pointer;
    this.#state.packageStatus[skill.packageId] = {
      status: "active",
      updatedAt: this.#now(),
    };
    delete this.#state.disabled[skill.name];
    this.#saveState();
  }

  #rankForPrompt(context: SkillRenderContext | undefined): SkillManifest[] {
    const latestUserText = (context?.latestUserText ?? "").toLowerCase();
    const recentPaths = context?.recentPaths ?? [];
    return this.list()
      .filter((skill) => !skill.disableModelInvocation)
      .filter((skill) => !skill.paths?.length || matchesAnyPath(skill.paths, recentPaths) || mentionsAnyPathToken(skill.paths, latestUserText))
      .sort((a, b) => scoreSkill(b, latestUserText, recentPaths) - scoreSkill(a, latestUserText, recentPaths));
  }

  #writeManifest(): void {
    const lines = [
      "# ForgeAgent Skill Manifest",
      "",
      `Generated: ${this.#now()}`,
      "",
      "This manifest is a discovery index. Read a skill's SKILL.md for the actual instructions.",
      "",
    ];
    for (const skill of this.#entries) {
      lines.push(`## ${skill.name} ${skill.version}`);
      lines.push(`- Status: ${skill.status}`);
      lines.push(`- Trust: ${skill.trust}`);
      lines.push(`- Source: ${skill.source}`);
      lines.push(`- Location: ${skill.location}`);
      lines.push(`- Description: ${skill.description}`);
      if (skill.whenToUse) lines.push(`- When to use: ${skill.whenToUse}`);
      if (skill.paths?.length) lines.push(`- Paths: ${skill.paths.join(", ")}`);
      if (skill.tags?.length) lines.push(`- Tags: ${skill.tags.join(", ")}`);
      if (skill.invalidReason) lines.push(`- Reason: ${skill.invalidReason}`);
      lines.push("");
    }
    atomicWrite(this.manifestPath, lines.join("\n"));
  }

  async #resolveRemoteSource(input: InstallSkillInput): Promise<SkillSource> {
    if (input.registryUrl) {
      const now = this.#now();
      return {
        id: `adhoc-${createHash("sha256").update(input.registryUrl).digest("hex").slice(0, 12)}`,
        kind: "remote",
        name: input.registryUrl,
        enabled: true,
        url: input.registryUrl,
        trustUnsigned: input.trustUnsigned === true,
        trust: "community",
        addedAt: now,
        updatedAt: now,
      };
    }
    const sourceId = input.sourceId ?? this.#state.sources.find((source) => source.url)?.id;
    const source = this.#state.sources.find((candidate) => candidate.id === sourceId);
    if (!source?.url) throw new Error("No remote skill source configured.");
    return source;
  }

  async #fetchRegistry(source: SkillSource, overrideUrl?: string): Promise<SkillRegistryIndex> {
    const url = overrideUrl ?? source.url;
    if (!url) throw new Error("Skill source has no URL.");
    const response = await fetchWithRedirectGuard(url);
    const text = await response.text();
    const registry = JSON.parse(text) as SkillRegistryIndex;
    if (registry.schema !== "forge.skill-registry.v1" || !Array.isArray(registry.packages)) {
      throw new Error("Invalid skill registry index.");
    }
    const cachePath = join(this.rootDir, "registry-cache", `${source.id}.json`);
    atomicWrite(cachePath, text);
    this.#verifyRegistry(registry, source);
    return registry;
  }

  #verifyRegistry(registry: SkillRegistryIndex, source: SkillSource): void {
    const publicKey = source.publicKey ?? registry.signed?.publicKey;
    const signature = registry.signed?.signature;
    if (!publicKey || !signature) {
      if (source.trustUnsigned) return;
      throw new Error("Remote skill registry is unsigned. Add the source with trustUnsigned only if you accept that risk.");
    }
    const { signed: _signed, ...unsigned } = registry;
    const payload = Buffer.from(canonicalJson(unsigned));
    const sig = Buffer.from(signature, "base64");
    const key = createPublicKey(publicKey);
    if (!verify(null, payload, key, sig)) {
      throw new Error("Remote skill registry signature verification failed.");
    }
  }

  #selectRegistryPackage(
    registry: SkillRegistryIndex,
    name: string,
    version: string | undefined,
  ): SkillRegistryPackage {
    const normalized = normalizeName(name);
    const matches = registry.packages
      .filter((pkg) => normalizeName(pkg.name) === normalized && (!version || pkg.version === version))
      .sort((a, b) => b.version.localeCompare(a.version));
    const selected = matches[0];
    if (!selected) throw new Error(`Skill not found in registry: ${name}${version ? ` ${version}` : ""}`);
    return selected;
  }

  async #downloadRegistryFile(file: SkillRegistryFile, targetDir: string): Promise<void> {
    const rel = normalizeSkillPath(file.path);
    const response = await fetchWithRedirectGuard(file.url);
    const data = Buffer.from(await response.arrayBuffer());
    if (file.sizeBytes !== undefined && data.length > file.sizeBytes) {
      throw new Error(`Registry file exceeded declared size: ${rel}`);
    }
    const sha = createHash("sha256").update(data).digest("hex");
    if (sha !== file.sha256) {
      throw new Error(`SHA256 mismatch for registry file: ${rel}`);
    }
    const target = join(targetDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }

  #appendEvent(
    action: SkillEventAction,
    params: Omit<Partial<SkillEventRecord>, "type" | "seq" | "timestamp" | "action" | "message"> & {
      message: string;
    },
  ): SkillEventRecord {
    const event: SkillEventRecord = {
      type: "skill_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId: params.sessionId ?? "system",
      action,
      message: params.message,
    };
    if (params.skillName !== undefined) event.skillName = params.skillName;
    if (params.packageId !== undefined) event.packageId = params.packageId;
    if (params.status !== undefined) event.status = params.status;
    if (params.trust !== undefined) event.trust = params.trust;
    if (params.source !== undefined) event.source = params.source;
    if (params.payload !== undefined) event.payload = params.payload;
    this.#events.push(event);
    appendJsonl(join(this.rootDir, EVENTS_FILE), event);
    this.#onEvent?.(event);
    return event;
  }

  #appendAudit(event: SkillEventRecord): void {
    appendJsonl(join(this.rootDir, AUDIT_FILE), event);
  }
}

function defaultSources(rootDir: string, projectRoot: string, timestamp: string): SkillSource[] {
  const candidates: SkillSource[] = [
    {
      id: "local",
      kind: "local",
      name: "Local Forge skills",
      enabled: true,
      path: rootDir,
      trust: "local",
      addedAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "project-skills",
      kind: "project",
      name: "Project skills",
      enabled: true,
      path: join(projectRoot, "skills"),
      trust: "project",
      addedAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "project-agents-skills",
      kind: "project",
      name: "Project .agents skills",
      enabled: true,
      path: join(projectRoot, ".agents", "skills"),
      trust: "project",
      addedAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "user-agents-skills",
      kind: "local",
      name: "User .agents skills",
      enabled: true,
      path: join(homedir(), ".agents", "skills"),
      trust: "local",
      addedAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  return candidates;
}

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return { frontmatter: {}, body: raw };
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: raw };
  const block = trimmed.slice(3, end);
  const body = trimmed.slice(end + 4).replace(/^\s*\n/, "");
  const out: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!match) {
      i++;
      continue;
    }
    const key = normalizeFrontmatterKey(match[1]!);
    const value = match[2]!.trim();
    if (!value) {
      const arr: string[] = [];
      i++;
      while (i < lines.length && /^\s*-\s+/.test(lines[i]!)) {
        arr.push(lines[i]!.replace(/^\s*-\s+/, "").trim());
        i++;
      }
      out[key] = arr;
      continue;
    }
    out[key] = parseScalar(value);
    i++;
  }
  return { frontmatter: out, body };
}

function normalizeFrontmatterKey(key: string): string {
  switch (key) {
    case "when_to_use":
    case "when-to-use":
      return "whenToUse";
    case "allowed-tools":
      return "allowedTools";
    case "disable-model-invocation":
      return "disableModelInvocation";
    case "user-invocable":
      return "userInvocable";
    default:
      return key;
  }
}

function parseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\[.*\]$/.test(value)) {
    return value.slice(1, -1).split(",").map((part) => part.trim()).filter(Boolean);
  }
  return value;
}

function listSupportFiles(directory: string): string[] {
  const roots = ["references", "scripts", "templates", "assets", "tests", "examples"];
  const files: string[] = [];
  for (const root of roots) {
    const dir = join(directory, root);
    if (!existsSync(dir)) continue;
    collectFiles(directory, dir, files);
  }
  return files.sort();
}

function collectFiles(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, full, out);
    } else if (entry.isFile()) {
      out.push(toPortable(relative(root, full)));
    }
  }
}

function statusRank(status: SkillStatus): number {
  switch (status) {
    case "active": return 0;
    case "disabled": return 1;
    case "quarantined": return 2;
    case "invalid": return 3;
    case "archived": return 4;
  }
}

function reviewStateFromLegacyVerdict(verdict: SkillManifest["scanVerdict"]): SkillReviewState | undefined {
  if (verdict === "safe") return "safe";
  if (verdict === "caution") return "warning";
  if (verdict === "dangerous") return "blocked";
  return undefined;
}

function trustForSource(source: SkillSourceKind): SkillTrust {
  switch (source) {
    case "official": return "official";
    case "project": return "project";
    case "generated": return "generated";
    case "community":
    case "remote": return "community";
    case "legacy": return "legacy";
    case "local": return "local";
  }
}

function packageId(name: string, version: string, source: string): string {
  return `${source}:${normalizeName(name)}@${version}`;
}

function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, "-")
    .replace(/[^a-z0-9.-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generatedVersion(): string {
  return `0.0.${Date.now()}`;
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

function atomicWriteBytes(filePath: string, content: string | Uint8Array): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, { flag: "a" });
}

function readJsonIfExists(filePath: string): unknown | null {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function matchesAnyPath(patterns: string[], paths: string[]): boolean {
  return paths.some((filePath) => {
    const portable = toPortable(filePath);
    return patterns.some((pattern) => pathPatternMatches(pattern, portable));
  });
}

function mentionsAnyPathToken(patterns: string[], text: string): boolean {
  return patterns.some((pattern) => {
    const token = pattern.replaceAll("*", "").replaceAll("/", " ").trim().toLowerCase();
    return token.length > 1 && text.includes(token);
  });
}

function pathPatternMatches(pattern: string, filePath: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/\/\*\*$/, "");
  if (normalized === "**" || normalized === "*") return true;
  if (normalized.includes("*")) {
    const regex = new RegExp(`^${normalized.split("*").map(escapeRegex).join(".*")}`);
    return regex.test(filePath);
  }
  return filePath === normalized || filePath.startsWith(`${normalized}/`) || filePath.includes(`/${normalized}/`);
}

function scoreSkill(skill: SkillManifest, latestUserText: string, recentPaths: string[]): number {
  let score = 0;
  const trustRank: Record<SkillTrust, number> = {
    project: 70,
    generated: 65,
    local: 60,
    official: 55,
    community: 40,
    legacy: 35,
  };
  score += trustRank[skill.trust] ?? 0;
  const searchable = [
    skill.name,
    skill.description,
    skill.whenToUse ?? "",
    ...(skill.tags ?? []),
  ].join(" ").toLowerCase();
  for (const word of latestUserText.split(/[^a-z0-9\u4e00-\u9fa5]+/i).filter((w) => w.length > 1)) {
    if (searchable.includes(word)) score += 4;
  }
  if (skill.paths?.length && matchesAnyPath(skill.paths, recentPaths)) score += 30;
  return score;
}

function toPortable(filePath: string): string {
  return filePath.split(sep).join("/");
}

function isInside(filePath: string, root: string): boolean {
  const rel = relative(root, filePath);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortJson(item);
    }
    return out;
  }
  return value;
}

async function fetchWithRedirectGuard(url: string, redirects = 0): Promise<Response> {
  if (redirects > 5) throw new Error("Skill registry fetch exceeded redirect limit.");
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsafe skill URL protocol: ${parsed.protocol}`);
  }
  if (parsed.hostname === "169.254.169.254") {
    throw new Error("Unsafe skill URL host.");
  }
  const response = await fetch(url, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("Skill registry redirect missing location.");
    return await fetchWithRedirectGuard(new URL(location, url).toString(), redirects + 1);
  }
  if (!response.ok) throw new Error(`Skill registry fetch failed: ${response.status} ${response.statusText}`);
  return response;
}

export function currentPlatformMatches(osList: string[] | undefined): boolean {
  if (!osList || osList.length === 0) return true;
  const current = platform();
  return osList.some((item) => {
    const normalized = item.toLowerCase();
    if (normalized === "macos") return current === "darwin";
    if (normalized === "windows") return current === "win32";
    return current === normalized;
  });
}
