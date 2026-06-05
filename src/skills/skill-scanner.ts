import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import type {
  SkillScanFinding,
  SkillReviewAction,
  SkillReviewState,
  SkillScanSeverity,
  SkillScanSummary,
  SkillScanVerdict,
  SkillTrust,
} from "./types.js";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".sh",
  ".py",
  ".html",
  ".css",
]);

const RESERVED_DIRS = new Set([
  ".git",
  ".github",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".cache",
]);

type ScanRule = {
  ruleId: string;
  severity: SkillScanSeverity;
  message: string;
  pattern: RegExp;
};

const RULES: ScanRule[] = [
  {
    ruleId: "prompt-injection-ignore",
    severity: "critical",
    message: "Attempts to override higher-priority instructions.",
    pattern: /ignore\s+(all|any|previous|above|prior)\s+instructions/i,
  },
  {
    ruleId: "hidden-prompt-leak",
    severity: "critical",
    message: "References hidden/system/developer prompt layers.",
    pattern: /\b(system prompt|developer message|hidden instructions)\b/i,
  },
  {
    ruleId: "approval-bypass",
    severity: "critical",
    message: "Encourages bypassing tool permission or approval.",
    pattern: /\b(run|execute|call|invoke)\b.{0,60}\btool\b.{0,60}\bwithout\b.{0,40}\b(permission|approval)/i,
  },
  {
    ruleId: "pipe-to-shell",
    severity: "critical",
    message: "Contains pipe-to-shell installation pattern.",
    pattern: /\b(curl|wget)\b[^|\n]{0,160}\|\s*(sh|bash|zsh)\b/i,
  },
  {
    ruleId: "secret-exfiltration",
    severity: "critical",
    message: "May exfiltrate environment variables or credentials.",
    pattern: /\b(process\.env|os\.environ|env|printenv)\b.{0,120}\b(fetch|curl|wget|http|https|nc|dig|nslookup)\b/i,
  },
  {
    ruleId: "credential-path",
    severity: "warn",
    message: "Mentions sensitive credential paths. Runtime tools still require permission before reading sensitive files.",
    pattern: /(\$HOME|~)\/\.(ssh|aws|gnupg|kube|docker)|\b\.env\b|\bcredentials\b/i,
  },
  {
    ruleId: "destructive-delete",
    severity: "warn",
    message: "Contains broad destructive delete command.",
    pattern: /\brm\s+-rf\s+(\/|\$HOME|~|\.)/i,
  },
  {
    ruleId: "dynamic-code-exec",
    severity: "warn",
    message: "Contains dynamic code execution.",
    pattern: /\b(eval|new Function|execSync|child_process)\b/i,
  },
  {
    ruleId: "unpinned-install",
    severity: "warn",
    message: "Contains unpinned package install guidance.",
    pattern: /\b(npm|pip|uv|pnpm|yarn)\s+install\b(?![^\n]*(==|@[\d^~]))/i,
  },
];

export type ScanSkillPackageOptions = {
  maxPackageBytes?: number;
  maxFileBytes?: number;
};

export function scanSkillPackage(
  directory: string,
  options?: ScanSkillPackageOptions,
): SkillScanSummary {
  const root = resolve(directory);
  const maxPackageBytes = options?.maxPackageBytes ?? 20 * 1024 * 1024;
  const maxFileBytes = options?.maxFileBytes ?? 1024 * 1024;
  const findings: SkillScanFinding[] = [];
  let totalBytes = 0;
  let scannedFiles = 0;

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (RESERVED_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      const rel = toPortable(relative(root, fullPath));
      const lst = lstatSync(fullPath);
      if (lst.isSymbolicLink()) {
        findings.push({
          ruleId: "symlink",
          severity: "critical",
          file: rel,
          line: 1,
          message: "Skill package contains a symlink or junction.",
          evidence: rel,
        });
        continue;
      }
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const stat = statSync(fullPath);
      totalBytes += stat.size;
      if (stat.size > maxFileBytes) {
        findings.push({
          ruleId: "file-too-large",
          severity: "critical",
          file: rel,
          line: 1,
          message: `Support file exceeds ${maxFileBytes} bytes.`,
          evidence: `${stat.size} bytes`,
        });
      }
      if (totalBytes > maxPackageBytes) {
        findings.push({
          ruleId: "package-too-large",
          severity: "critical",
          file: rel,
          line: 1,
          message: `Skill package exceeds ${maxPackageBytes} bytes.`,
          evidence: `${totalBytes} bytes`,
        });
      }
      if (!isTextPath(fullPath)) continue;
      const content = readFileSync(fullPath, "utf-8");
      scannedFiles++;
      scanText(rel, content, findings);
    }
  };

  try {
    visit(root);
  } catch (err) {
    findings.push({
      ruleId: "scan-error",
      severity: "critical",
      file: ".",
      line: 1,
      message: "Skill scanner failed to read the package.",
      evidence: err instanceof Error ? err.message : String(err),
    });
  }

  const verdict = verdictFromFindings(findings);
  return {
    scannedFiles,
    totalBytes,
    findings,
    verdict,
    reviewState: reviewStateFromVerdict(verdict),
    reviewAction: reviewActionFromVerdict(verdict),
  };
}

export function shouldEnableSkill(params: {
  trust: SkillTrust;
  scan: SkillScanSummary;
  force?: boolean;
}): { allow: boolean; quarantine: boolean; reason: string } {
  const verdict = params.scan.verdict;
  if (verdict === "safe") {
    return { allow: true, quarantine: false, reason: "Static scan passed." };
  }
  if (params.trust === "official" && verdict === "caution") {
    return { allow: true, quarantine: false, reason: "Official skill has caution findings but no critical findings." };
  }
  if (params.trust === "generated") {
    return { allow: false, quarantine: verdict !== "dangerous", reason: "Generated skills must pass with a clean static scan before auto-enable." };
  }
  if (verdict === "caution" && params.force) {
    return { allow: true, quarantine: false, reason: "Warning findings trusted by operator; runtime permissions and sandbox still apply." };
  }
  if (verdict === "caution") {
    return { allow: true, quarantine: false, reason: "Static scan found warnings, but no blocking findings. Runtime permissions and sandbox still apply." };
  }
  return { allow: false, quarantine: false, reason: "Dangerous skill findings cannot be enabled." };
}

export function normalizeSkillPath(input: string): string {
  const normalized = input.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`Unsafe skill path: ${input}`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.startsWith("."))) {
    throw new Error(`Unsafe skill path: ${input}`);
  }
  return parts.join("/");
}

function scanText(file: string, content: string, findings: SkillScanFinding[]): void {
  const lines = content.split(/\r?\n/);
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!rule.pattern.test(line)) continue;
      findings.push({
        ruleId: rule.ruleId,
        severity: rule.severity,
        file,
        line: i + 1,
        message: rule.message,
        evidence: line.trim().slice(0, 240),
      });
    }
  }
}

function verdictFromFindings(findings: SkillScanFinding[]): SkillScanVerdict {
  if (findings.some((f) => f.severity === "critical")) return "dangerous";
  if (findings.some((f) => f.severity === "warn")) return "caution";
  return "safe";
}

function reviewStateFromVerdict(verdict: SkillScanVerdict): SkillReviewState {
  if (verdict === "dangerous") return "blocked";
  if (verdict === "caution") return "warning";
  return "safe";
}

function reviewActionFromVerdict(verdict: SkillScanVerdict): SkillReviewAction {
  if (verdict === "dangerous") return "fix_required";
  if (verdict === "caution") return "trust_enable";
  return "none";
}

function isTextPath(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function toPortable(filePath: string): string {
  return filePath.split(sep).join("/");
}
