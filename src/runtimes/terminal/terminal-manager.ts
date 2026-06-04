import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TerminalStatus = "running" | "exited";
export type TerminalStream = "stdout" | "stderr" | "system";

export type TerminalOutputEvent = {
  seq: number;
  timestamp: string;
  stream: TerminalStream;
  data: string;
};

export type TerminalSessionSnapshot = {
  id: string;
  pid?: number;
  shell: string;
  cwd: string;
  status: TerminalStatus;
  createdAt: string;
  updatedAt: string;
  cols: number;
  rows: number;
  exitCode: number | null;
  signal: string | null;
  events: TerminalOutputEvent[];
  nextSeq: number;
};

export type CreateTerminalSessionInput = {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
};

type TerminalSessionRecord = Omit<TerminalSessionSnapshot, "events" | "nextSeq"> & {
  child: ChildProcessWithoutNullStreams;
  events: TerminalOutputEvent[];
  subscribers: Set<(event: TerminalOutputEvent) => void>;
  nextSeq: number;
};

const MAX_EVENTS = 1_000;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 28;

function now(): string {
  return new Date().toISOString();
}

function shellForPlatform(): string {
  if (platform() === "win32") {
    return process.env.ComSpec || "powershell.exe";
  }
  return process.env.SHELL || (platform() === "darwin" ? "/bin/zsh" : "/bin/bash");
}

function shellArgs(shell: string): string[] {
  if (platform() === "win32") return [];
  const base = shell.split(/[\\/]/).pop() ?? "";
  if (base === "zsh") return ["-l", "-i"];
  if (base === "bash") return ["-l", "-i"];
  if (base === "fish") return ["-i"];
  return ["-i"];
}

function commandForShell(shell: string): { command: string; args: string[] } {
  const bridge = ptyBridgeCommand(shell);
  if (bridge) return bridge;
  return { command: shell, args: shellArgs(shell) };
}

function ptyBridgeCommand(shell: string): { command: string; args: string[] } | null {
  if (platform() === "win32") return null;
  const python = pythonCommand();
  if (!python) return null;
  const bridge = resolve(dirname(fileURLToPath(import.meta.url)), "pty-bridge.py");
  if (!existsSync(bridge)) return null;
  return {
    command: python,
    args: ["-u", bridge, "__FORGE_TERMINAL_CWD__", shell, ...shellArgs(shell)],
  };
}

function pythonCommand(): string | null {
  for (const candidate of [process.env.PYTHON, "/usr/bin/python3", "python3"]) {
    if (!candidate) continue;
    const result = spawnSync(candidate, ["-c", "import pty"], { stdio: "ignore" });
    if (result.status === 0) return candidate;
  }
  return null;
}

function safeSize(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

function normalizeCwd(cwd: string | undefined): string {
  const candidate = resolve(cwd && cwd.trim() ? cwd : process.cwd());
  if (!existsSync(candidate)) return process.cwd();
  const stat = statSync(candidate);
  return stat.isDirectory() ? candidate : process.cwd();
}

function initialPrompt(cwd: string, shell: string): string {
  return [
    `ForgeAgent Terminal`,
    `user: ${userInfo().username}`,
    `cwd: ${cwd}`,
    `shell: ${shell}`,
    "",
  ].join("\n");
}

export class TerminalManager {
  #sessions = new Map<string, TerminalSessionRecord>();

  create(input: CreateTerminalSessionInput = {}): TerminalSessionSnapshot {
    const id = crypto.randomUUID();
    const shell = input.shell && input.shell.trim() ? input.shell.trim() : shellForPlatform();
    const cwd = normalizeCwd(input.cwd);
    const cols = safeSize(input.cols, DEFAULT_COLS, 20, 300);
    const rows = safeSize(input.rows, DEFAULT_ROWS, 8, 120);
    const createdAt = now();
    const env = {
      ...process.env,
      COLUMNS: String(cols),
      LINES: String(rows),
      TERM: process.env.TERM || "xterm-256color",
      HOME: process.env.HOME || homedir(),
      FORCE_COLOR: process.env.FORCE_COLOR || "1",
    };
    const command = commandForShell(shell);
    const commandArgs = command.args.map((arg) => arg === "__FORGE_TERMINAL_CWD__" ? cwd : arg);
    const child = spawn(command.command, commandArgs, {
      cwd,
      env,
      stdio: "pipe",
    });
    child.stdin.setDefaultEncoding("utf-8");

    const record: TerminalSessionRecord = {
      id,
      shell,
      cwd,
      status: "running",
      createdAt,
      updatedAt: createdAt,
      cols,
      rows,
      exitCode: null,
      signal: null,
      child,
      events: [],
      subscribers: new Set(),
      nextSeq: 1,
    };
    if (child.pid !== undefined) record.pid = child.pid;
    this.#sessions.set(id, record);
    this.#append(record, "system", initialPrompt(cwd, shell));

    child.stdout.on("data", (chunk: Buffer) => this.#append(record, "stdout", chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => this.#append(record, "stderr", chunk.toString("utf-8")));
    child.on("error", (err) => {
      this.#append(record, "system", `terminal error: ${err.message}\n`);
    });
    child.on("exit", (code, signal) => {
      record.status = "exited";
      record.exitCode = code;
      record.signal = signal;
      record.updatedAt = now();
      this.#append(record, "system", `\nprocess exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}\n`);
    });

    return this.snapshot(id)!;
  }

  list(): TerminalSessionSnapshot[] {
    return Array.from(this.#sessions.keys())
      .map((id) => this.snapshot(id))
      .filter((item): item is TerminalSessionSnapshot => item !== null);
  }

  snapshot(id: string, afterSeq = 0): TerminalSessionSnapshot | null {
    const record = this.#sessions.get(id);
    if (!record) return null;
    return {
      id: record.id,
      ...(record.pid !== undefined ? { pid: record.pid } : {}),
      shell: record.shell,
      cwd: record.cwd,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      cols: record.cols,
      rows: record.rows,
      exitCode: record.exitCode,
      signal: record.signal,
      events: record.events.filter((event) => event.seq > afterSeq),
      nextSeq: record.nextSeq,
    };
  }

  write(id: string, data: string): TerminalSessionSnapshot | null {
    const record = this.#sessions.get(id);
    if (!record) return null;
    if (record.status !== "running" || record.child.stdin.destroyed) {
      this.#append(record, "system", "terminal is not running\n");
      return this.snapshot(id);
    }
    record.child.stdin.write(data);
    record.updatedAt = now();
    return this.snapshot(id);
  }

  resize(id: string, cols: number | undefined, rows: number | undefined): TerminalSessionSnapshot | null {
    const record = this.#sessions.get(id);
    if (!record) return null;
    record.cols = safeSize(cols, record.cols, 20, 300);
    record.rows = safeSize(rows, record.rows, 8, 120);
    record.updatedAt = now();
    record.child.kill("SIGWINCH");
    return this.snapshot(id);
  }

  stop(id: string): boolean {
    const record = this.#sessions.get(id);
    if (!record) return false;
    if (record.status === "running") {
      record.child.kill("SIGTERM");
      setTimeout(() => {
        if (record.status === "running") record.child.kill("SIGKILL");
      }, 2_000).unref();
    }
    return true;
  }

  remove(id: string): boolean {
    const record = this.#sessions.get(id);
    if (!record) return false;
    this.stop(id);
    record.subscribers.clear();
    this.#sessions.delete(id);
    return true;
  }

  subscribe(id: string, afterSeq: number, callback: (event: TerminalOutputEvent) => void): (() => void) | null {
    const record = this.#sessions.get(id);
    if (!record) return null;
    for (const event of record.events) {
      if (event.seq > afterSeq) callback(event);
    }
    record.subscribers.add(callback);
    return () => {
      record.subscribers.delete(callback);
    };
  }

  shutdown(): void {
    for (const id of Array.from(this.#sessions.keys())) {
      this.remove(id);
    }
  }

  #append(record: TerminalSessionRecord, stream: TerminalStream, data: string): void {
    if (!data) return;
    const event: TerminalOutputEvent = {
      seq: record.nextSeq++,
      timestamp: now(),
      stream,
      data,
    };
    record.updatedAt = event.timestamp;
    record.events.push(event);
    if (record.events.length > MAX_EVENTS) {
      record.events.splice(0, record.events.length - MAX_EVENTS);
    }
    for (const subscriber of record.subscribers) {
      subscriber(event);
    }
  }
}
