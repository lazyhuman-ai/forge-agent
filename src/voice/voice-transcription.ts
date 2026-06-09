import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type VoiceTranscriptionInput = {
  audioPath: string;
  mimeType: string;
  mode?: "final" | "preview";
};

export type VoiceTranscriptionResult = {
  text: string;
  model: string;
  language: string;
};

export type VoiceTranscriptionCommand = {
  file: string;
  args: string[];
};

export type VoiceTranscriptionOptions = {
  enabled?: boolean;
  model?: string;
  language?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  command?: VoiceTranscriptionCommand;
  transcribe?: (input: VoiceTranscriptionInput) => Promise<VoiceTranscriptionResult>;
};

export type ResolvedVoiceTranscriptionOptions = {
  enabled: boolean;
  model: string;
  language: string;
  timeoutMs: number;
  maxBodyBytes: number;
  command?: VoiceTranscriptionCommand;
  transcribe?: (input: VoiceTranscriptionInput) => Promise<VoiceTranscriptionResult>;
};

const DEFAULT_MODEL = "mlx-community/belle-whisper-large-v3-turbo-zh-fp16";
const DEFAULT_LANGUAGE = "zh";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

const MLX_WHISPER_SCRIPT = `
import json
import sys

audio_path, model, language = sys.argv[1:4]
try:
    import mlx_whisper
except Exception as exc:
    raise SystemExit("mlx-whisper is not installed. Install it locally or configure FORGE_VOICE_TRANSCRIBE_COMMAND. " + str(exc))

kwargs = {"path_or_hf_repo": model}
if language:
    kwargs["language"] = language

result = mlx_whisper.transcribe(audio_path, **kwargs)
if isinstance(result, dict):
    text = result.get("text", "")
else:
    text = str(result)
print(json.dumps({"text": text}, ensure_ascii=False))
`;

export function voiceTranscriptionOptionsFromEnv(): VoiceTranscriptionOptions {
  const options: VoiceTranscriptionOptions = {};
  if (process.env.FORGE_VOICE_INPUT_ENABLED !== undefined) {
    options.enabled = process.env.FORGE_VOICE_INPUT_ENABLED !== "0";
  }
  if (process.env.FORGE_WHISPER_MODEL) options.model = process.env.FORGE_WHISPER_MODEL;
  if (process.env.FORGE_VOICE_LANGUAGE) options.language = process.env.FORGE_VOICE_LANGUAGE;
  if (process.env.FORGE_VOICE_TIMEOUT_MS) {
    options.timeoutMs = Math.max(1, parseInt(process.env.FORGE_VOICE_TIMEOUT_MS, 10));
  }
  if (process.env.FORGE_VOICE_MAX_BODY_BYTES) {
    options.maxBodyBytes = Math.max(1, parseInt(process.env.FORGE_VOICE_MAX_BODY_BYTES, 10));
  }
  if (process.env.FORGE_VOICE_TRANSCRIBE_COMMAND) {
    options.command = {
      file: process.env.FORGE_VOICE_TRANSCRIBE_COMMAND,
      args: parseCommandArgs(process.env.FORGE_VOICE_TRANSCRIBE_ARGS ?? "{audio}"),
    };
  }
  return options;
}

export function resolveVoiceTranscriptionOptions(
  options?: VoiceTranscriptionOptions,
): ResolvedVoiceTranscriptionOptions {
  const model = options?.model ?? defaultVoiceModel();
  const resolved: ResolvedVoiceTranscriptionOptions = {
    enabled: options?.enabled ?? true,
    model,
    language: options?.language ?? DEFAULT_LANGUAGE,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBodyBytes: options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  };
  const defaultCommand = defaultWhisperCliCommand(model);
  if (options?.command) resolved.command = options.command;
  else if (defaultCommand) resolved.command = defaultCommand;
  if (options?.transcribe) resolved.transcribe = options.transcribe;
  return resolved;
}

function defaultVoiceModel(): string {
  const ggmlModel = join(homedir(), "Library", "Application Support", "ForgeAgent", "models", "belle-whisper-large-v3-turbo-zh-ggml-q5_0", "ggml-belle-large-v3-turbo-zh-q5_0.bin");
  if (existsSync(ggmlModel)) return ggmlModel;
  const bundledModel = join(homedir(), "Library", "Application Support", "ForgeAgent", "models", "belle-whisper-large-v3-turbo-zh-fp16");
  return existsSync(bundledModel) ? bundledModel : DEFAULT_MODEL;
}

function defaultWhisperCliCommand(model: string): VoiceTranscriptionCommand | undefined {
  if (extname(model).toLowerCase() !== ".bin") return undefined;
  const whisperCli = firstExistingPath([
    process.env.FORGE_WHISPER_CLI,
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
  ]);
  if (!whisperCli) return undefined;
  return {
    file: whisperCli,
    args: ["-m", "{model}", "-f", "{audio}", "-l", "{language}", "-nt", "-np"],
  };
}

function firstExistingPath(paths: Array<string | undefined>): string | undefined {
  return paths.find((path) => path && existsSync(path));
}

export async function transcribeVoiceAudio(
  input: VoiceTranscriptionInput,
  options: ResolvedVoiceTranscriptionOptions,
): Promise<VoiceTranscriptionResult> {
  if (!options.enabled) throw new Error("Local voice input is disabled.");
  if (options.transcribe) return options.transcribe(input);

  const prepared = await prepareAudio(input.audioPath, input.mimeType, options);
  const outputPath = join(dirname(input.audioPath), `voice-transcript-${randomUUID()}.json`);
  try {
    const command = buildCommand(prepared.audioPath, outputPath, options, input.mode ?? "final");
    const result = await execFileAsync(command.file, command.args, {
      cwd: dirname(prepared.audioPath),
      timeout: options.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    const hasOutputFile = existsSync(outputPath);
    const output = hasOutputFile ? readFileSync(outputPath, "utf-8") : result.stdout || result.stderr;
    if (hasOutputFile) rmSync(outputPath, { force: true });
    const text = extractTranscriptText(output);
    if (!text.trim()) throw new Error("Voice transcription returned no text.");
    return {
      text: text.trim(),
      model: options.model,
      language: options.language,
    };
  } finally {
    if (prepared.cleanupPath) rmSync(prepared.cleanupPath, { force: true });
  }
}

async function prepareAudio(
  audioPath: string,
  mimeType: string,
  options: ResolvedVoiceTranscriptionOptions,
): Promise<{ audioPath: string; cleanupPath?: string }> {
  if (!options.command || commandAcceptsAudioPath(audioPath, mimeType)) {
    return { audioPath };
  }
  const ffmpeg = firstExistingPath([
    process.env.FORGE_FFMPEG,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "ffmpeg",
  ]);
  if (!ffmpeg) return { audioPath };
  const wavPath = join(dirname(audioPath), `voice-${randomUUID()}.wav`);
  await execFileAsync(ffmpeg, [
    "-y",
    "-i", audioPath,
    "-ar", "16000",
    "-ac", "1",
    wavPath,
  ], {
    cwd: dirname(audioPath),
    timeout: Math.min(options.timeoutMs, 60_000),
    maxBuffer: 2 * 1024 * 1024,
  });
  return { audioPath: wavPath, cleanupPath: wavPath };
}

function commandAcceptsAudioPath(audioPath: string, mimeType: string): boolean {
  const ext = extname(audioPath).toLowerCase();
  return ext === ".wav"
    || ext === ".mp3"
    || ext === ".ogg"
    || ext === ".flac"
    || mimeType.includes("wav")
    || mimeType.includes("mpeg")
    || mimeType.includes("mp3")
    || mimeType.includes("ogg")
    || mimeType.includes("flac");
}

function buildCommand(
  audioPath: string,
  outputPath: string,
  options: ResolvedVoiceTranscriptionOptions,
  mode: "final" | "preview",
): VoiceTranscriptionCommand {
  if (options.command) {
    const args = options.command.args.map((arg) => interpolateArg(arg, audioPath, outputPath, options, mode));
    if (!args.some((arg) => arg === audioPath)) args.push(audioPath);
    if (mode === "preview" && isWhisperCliCommand(options.command.file)) {
      args.push(...previewWhisperCliArgs());
    }
    return { file: options.command.file, args };
  }
  return {
    file: process.env.FORGE_VOICE_PYTHON ?? defaultVoicePython(),
    args: ["-c", MLX_WHISPER_SCRIPT, audioPath, options.model, options.language],
  };
}

function defaultVoicePython(): string {
  const dedicatedVenvPython = join(homedir(), "Library", "Application Support", "ForgeAgent", "voice-venv", "bin", "python");
  return existsSync(dedicatedVenvPython) ? dedicatedVenvPython : "python3";
}

function interpolateArg(
  arg: string,
  audioPath: string,
  outputPath: string,
  options: ResolvedVoiceTranscriptionOptions,
  mode: "final" | "preview",
): string {
  return arg
    .replaceAll("{audio}", audioPath)
    .replaceAll("{output}", outputPath)
    .replaceAll("{model}", options.model)
    .replaceAll("{language}", options.language)
    .replaceAll("{mode}", mode);
}

function isWhisperCliCommand(file: string): boolean {
  return basename(file) === "whisper-cli";
}

function previewWhisperCliArgs(): string[] {
  return ["-bs", "1", "-bo", "1", "-nf"];
}

function extractTranscriptText(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "";
  const candidates = [
    trimmed,
    ...trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse(),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const text = transcriptTextFromJson(parsed);
      if (text.trim()) return text;
    } catch {
      // Fall back to plain stdout below.
    }
  }
  return trimmed;
}

function transcriptTextFromJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.transcription === "string") return record.transcription;
  if (Array.isArray(record.segments)) {
    return record.segments
      .map((segment) => {
        if (!segment || typeof segment !== "object") return "";
        const text = (segment as Record<string, unknown>).text;
        return typeof text === "string" ? text : "";
      })
      .join(" ");
  }
  if (record.result) return transcriptTextFromJson(record.result);
  return "";
}

function parseCommandArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("FORGE_VOICE_TRANSCRIBE_ARGS must be a JSON string array.");
    }
    return parsed;
  }
  return splitCommandLine(trimmed);
}

function splitCommandLine(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  for (const char of raw) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (quote) throw new Error("Unclosed quote in FORGE_VOICE_TRANSCRIBE_ARGS.");
  if (current) args.push(current);
  return args;
}

function execFileAsync(
  file: string,
  args: string[],
  options: { cwd?: string; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: options.cwd ?? homedir(),
      encoding: "utf8",
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr ? `${error.message}\n${stderr}` : error.message;
        reject(new Error(detail));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}
