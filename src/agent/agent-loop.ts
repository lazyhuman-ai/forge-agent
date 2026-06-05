import type {
  AssistantMessage,
  AssistantDelta,
  ArtifactPointer,
  ContextUsageEvent,
  ToolCall,
  ToolResult,
  SessionEvent,
} from "../streams/event-types.js";
import { SessionThreadStore } from "../streams/session-thread-store.js";
import { buildContext } from "./context-window-builder.js";
import type { ModelMessage, ModelProvider, ModelUsage } from "./model-provider.js";
import type { ToolExecutor, ToolExecutionContext } from "./tool-executor.js";
import type { ToolDefinition } from "../tools/schemas.js";
import { compact } from "./compactor.js";
import type { ArtifactInfo, ArtifactStore } from "../artifacts/artifact-store.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("agent-loop");

const MAX_ITERATIONS = 50;
const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;
const DEFAULT_AUTOCOMPACT_BUFFER = 10_000;
const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;
const DEFAULT_ARTIFACT_PREVIEW_BYTES = 2_000;
const DEFAULT_ARTIFACT_PER_TURN_BUDGET_CHARS = 200_000;

type SerializedToolOutput = {
  data: Buffer | string;
  text: string;
  mimeType: string;
  sizeChars: number;
};

type PreparedToolResult = {
  output: unknown;
  isError: boolean;
  artifactInfo?: ArtifactInfo;
  artifactFailure?: string;
};

function makeAbortError(): Error {
  const err = new Error("Turn aborted");
  err.name = "AbortError";
  return err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw makeAbortError();
}

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeAbortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(makeAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function estimateTokensFromEvent(event: SessionEvent): number {
  return Math.max(1, Math.ceil(JSON.stringify(event).length / 4));
}

function estimateTokensFromMessages(messages: ModelMessage[]): number {
  return Math.max(1, Math.ceil(JSON.stringify(messages).length / 4));
}

function estimatedUsageFromMessages(messages: ModelMessage[]): ModelUsage {
  return {
    input_tokens: estimateTokensFromMessages(messages),
    output_tokens: 0,
    estimated: true,
  };
}

function usageForCompaction(
  response: { rawUsage?: ModelUsage },
  messages: ModelMessage[],
  requireUsage: boolean,
): { usage: ModelUsage } | { failure: string } {
  const providerTokens = response.rawUsage?.input_tokens;
  if (providerTokens !== undefined && providerTokens > 0) {
    return { usage: response.rawUsage! };
  }
  if (requireUsage) {
    return {
      failure: "Provider did not return token usage. DeepSeek compaction requires real prompt token telemetry and will not fall back to estimated tokens.",
    };
  }
  return { usage: estimatedUsageFromMessages(messages) };
}

function formatPercent(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function serializeToolOutput(output: unknown): SerializedToolOutput {
  if (Buffer.isBuffer(output)) {
    return {
      data: output,
      text: `[Binary output: ${output.length} bytes]`,
      mimeType: "application/octet-stream",
      sizeChars: output.length,
    };
  }

  if (output instanceof Uint8Array) {
    const buf = Buffer.from(output);
    return {
      data: buf,
      text: `[Binary output: ${buf.length} bytes]`,
      mimeType: "application/octet-stream",
      sizeChars: buf.length,
    };
  }

  if (typeof output === "string") {
    return {
      data: output,
      text: output,
      mimeType: "text/plain",
      sizeChars: output.length,
    };
  }

  const text = safeJsonStringify(output);
  return {
    data: text,
    text,
    mimeType: "application/json",
    sizeChars: text.length,
  };
}

function generatePreview(content: string, maxBytes: number): { preview: string; hasMore: boolean } {
  const buf = Buffer.from(content, "utf-8");
  if (buf.length <= maxBytes) return { preview: content, hasMore: false };

  let preview = buf.subarray(0, maxBytes).toString("utf-8");
  if (preview.endsWith("\uFFFD")) preview = preview.slice(0, -1);
  const lastNewline = preview.lastIndexOf("\n");
  if (lastNewline > maxBytes * 0.5) {
    preview = preview.slice(0, lastNewline);
  }
  return { preview, hasMore: true };
}

function buildPersistedOutputMessage(
  info: ArtifactInfo,
  preview: { preview: string; hasMore: boolean },
  previewBytes: number,
): string {
  return [
    "<persisted-output>",
    `Output too large (${info.sizeBytes} bytes). Full output saved as artifact: ${info.artifactId}`,
    `MIME type: ${info.mimeType}`,
    "Use read_artifact with this artifact_id if you need more of the full output.",
    "",
    `Preview (first ${previewBytes} bytes):`,
    preview.preview + (preview.hasMore ? "\n..." : ""),
    "</persisted-output>",
  ].join("\n");
}

export type TurnResult =
  | { outcome: "turn_finished"; message: AssistantMessage }
  | { outcome: "waiting_user"; message: AssistantMessage; question: string }
  | { outcome: "tool_failure"; message: string; runtimeKind?: string };

export class AgentLoop {
  #modelProvider: ModelProvider;
  #toolExecutor: ToolExecutor;
  #threadStore: SessionThreadStore;
  #nextSeq: () => number;
  #now: () => string;
  #systemPrompt: string;
  #tools: ToolDefinition[];
  #toolDefs: Map<string, ToolDefinition>;
  #toolsProvider: (() => ToolDefinition[]) | undefined;
  #maxContextTokens: number;
  #autoCompactBuffer: number;
  #compactionKeepRecentTokens: number;
  #requireUsageForCompaction: boolean;
  #artifactStore: ArtifactStore | undefined;
  #artifactMaxResultSizeChars: number;
  #artifactPreviewBytes: number;
  #artifactPerTurnBudgetChars: number;
  #onDelta: ((sessionId: string, delta: AssistantDelta) => void) | undefined;
  #onToolResult: ((event: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
    isError: boolean;
    toolUseId: string;
  }) => void) | undefined;
  #signal: AbortSignal | undefined;
  #toolExecutionContext: Omit<ToolExecutionContext, "signal" | "toolUseId"> | undefined;
  #branchId: string | undefined;
  #readThread: ((sessionId: string) => SessionEvent[]) | undefined;

  constructor(
    modelProvider: ModelProvider,
    toolExecutor: ToolExecutor,
    threadStore: SessionThreadStore,
    nextSeq: () => number,
    now: () => string,
    options?: {
      systemPrompt?: string;
      tools?: ToolDefinition[];
      toolsProvider?: () => ToolDefinition[];
      maxContextTokens?: number;
      contextWindowTokens?: number;
      autoCompactBuffer?: number;
      compactionKeepRecentTokens?: number;
      compactionKeepRatio?: number;
      requireUsageForCompaction?: boolean;
      artifactStore?: ArtifactStore;
      artifactMaxResultSizeChars?: number;
      artifactPreviewBytes?: number;
      artifactPerTurnBudgetChars?: number;
      onDelta?: (sessionId: string, delta: AssistantDelta) => void;
      onToolResult?: (event: {
        sessionId: string;
        toolName: string;
        args: Record<string, unknown>;
        result: unknown;
        isError: boolean;
        toolUseId: string;
      }) => void;
      signal?: AbortSignal;
      toolExecutionContext?: Omit<ToolExecutionContext, "signal" | "toolUseId">;
      branchId?: string;
      readThread?: (sessionId: string) => SessionEvent[];
    },
  ) {
    this.#modelProvider = modelProvider;
    this.#toolExecutor = toolExecutor;
    this.#threadStore = threadStore;
    this.#nextSeq = nextSeq;
    this.#now = now;
    this.#systemPrompt = options?.systemPrompt ?? "";
    this.#tools = options?.tools ?? [];
    this.#toolsProvider = options?.toolsProvider;
    this.#toolDefs = new Map();
    this.#refreshTools();
    this.#maxContextTokens = options?.contextWindowTokens
      ?? options?.maxContextTokens
      ?? DEFAULT_MAX_CONTEXT_TOKENS;
    this.#autoCompactBuffer = options?.autoCompactBuffer ?? DEFAULT_AUTOCOMPACT_BUFFER;
    this.#compactionKeepRecentTokens = options?.compactionKeepRecentTokens
      ?? DEFAULT_COMPACTION_KEEP_RECENT_TOKENS;
    this.#requireUsageForCompaction = options?.requireUsageForCompaction ?? false;
    this.#artifactStore = options?.artifactStore;
    this.#artifactMaxResultSizeChars = options?.artifactMaxResultSizeChars
      ?? DEFAULT_MAX_RESULT_SIZE_CHARS;
    this.#artifactPreviewBytes = options?.artifactPreviewBytes
      ?? DEFAULT_ARTIFACT_PREVIEW_BYTES;
    this.#artifactPerTurnBudgetChars = options?.artifactPerTurnBudgetChars
      ?? DEFAULT_ARTIFACT_PER_TURN_BUDGET_CHARS;
    this.#onDelta = options?.onDelta;
    this.#onToolResult = options?.onToolResult;
    this.#signal = options?.signal;
    this.#toolExecutionContext = options?.toolExecutionContext;
    this.#branchId = options?.branchId;
    this.#readThread = options?.readThread;
  }

  async runTurn(sessionId: string): Promise<TurnResult> {
    logger.debug("Turn iteration starting", { sessionId });

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      throwIfAborted(this.#signal);
      this.#refreshTools();
      const events = this.#readThread?.(sessionId) ?? this.#threadStore.getThread(sessionId);
      const messages = buildContext(events);

      // Prepend system prompt if provided
      if (this.#systemPrompt) {
        messages.unshift({ role: "system", content: this.#systemPrompt });
      }

      const callbacks:
        | { onToken?: (token: string) => void; signal?: AbortSignal }
        | undefined = this.#onDelta || this.#signal
          ? {}
          : undefined;
      if (callbacks && this.#signal) callbacks.signal = this.#signal;
      if (callbacks && this.#onDelta) {
        callbacks.onToken = (token) => {
          if (this.#signal?.aborted) return;
          this.#onDelta!(sessionId, {
            type: "assistant_delta",
            seq: this.#nextSeq(),
            timestamp: this.#now(),
            sessionId,
            ...(this.#branchId ? { branchId: this.#branchId } : {}),
            text: token,
          });
        };
      }

      const response = await raceAbort(
        this.#modelProvider.generate(
          messages,
          this.#tools.length > 0 ? this.#tools : undefined,
          callbacks,
        ),
        this.#signal,
      );
      throwIfAborted(this.#signal);

      if (response.finishReason === "stop") {
        logger.debug("Turn finished by model", { sessionId, iteration: i + 1 });
        const msg: AssistantMessage = {
          type: "assistant_message",
          seq: this.#nextSeq(),
          timestamp: this.#now(),
          sessionId,
          ...(this.#branchId ? { branchId: this.#branchId } : {}),
          text: response.text,
        };
        if (response.rawContent) msg.anthropicContent = response.rawContent;
        throwIfAborted(this.#signal);
        this.#threadStore.append(sessionId, msg);
        const compactionUsage = usageForCompaction(response, messages, this.#requireUsageForCompaction);
        if ("failure" in compactionUsage) {
          return { outcome: "tool_failure", runtimeKind: "usage_telemetry", message: compactionUsage.failure };
        }
        if (compactionUsage.usage.input_tokens > this.#maxContextTokens - this.#autoCompactBuffer) {
          throwIfAborted(this.#signal);
          const failure = await this.#compactContext(sessionId);
          if (failure !== null) {
            return { outcome: "tool_failure", runtimeKind: "compaction", message: failure };
          }
        }
        return { outcome: "turn_finished", message: msg };
      }

      if (response.finishReason === "tool_calls") {
        logger.debug("Turn produced tool calls", {
          sessionId,
          iteration: i + 1,
          toolCount: response.toolCalls?.length ?? 0,
        });
        if (!response.toolCalls || response.toolCalls.length === 0) {
          return {
            outcome: "tool_failure",
            message: "Model requested tool calls but did not provide any tool call payloads",
          };
        }

        // Phase 1: append all ToolCall events to thread store
        const toolCalls = response.toolCalls;
        for (let i = 0; i < toolCalls.length; i++) {
          throwIfAborted(this.#signal);
          const tc = toolCalls[i]!;
          const callEvent: ToolCall = {
            type: "tool_call",
            seq: this.#nextSeq(),
            timestamp: this.#now(),
            sessionId,
            ...(this.#branchId ? { branchId: this.#branchId } : {}),
            toolName: tc.name,
            args: tc.args,
            toolUseId: tc.id,
          };
          if (response.reasoningContent) callEvent.reasoningContent = response.reasoningContent;
          if (i === 0 && response.rawContent) callEvent.anthropicContent = response.rawContent;
          this.#threadStore.append(sessionId, callEvent);
        }

        // Phase 2: execute — safe tools concurrently, exclusive tools sequentially
        const results = new Array<{
          tc: typeof toolCalls[number];
          output: unknown;
          isError: boolean;
        } | null>(toolCalls.length).fill(null);

        // Execute parallel-safe tools concurrently
        const safeIndices: number[] = [];
        const exclusiveIndices: number[] = [];
        for (let i = 0; i < toolCalls.length; i++) {
          const def = this.#toolDefs.get(toolCalls[i]!.name);
          if (def?.isConcurrencySafe) {
            safeIndices.push(i);
          } else {
            exclusiveIndices.push(i);
          }
        }

        if (safeIndices.length > 0) {
          const safeResults = await Promise.all(
            safeIndices.map(async (i) => {
              const result = await this.#executeTool(toolCalls[i]!, sessionId);
              return { index: i, result };
            }),
          );
          for (const { index, result } of safeResults) {
            results[index] = {
              tc: toolCalls[index]!,
              output: result.output,
              isError: result.isError,
            };
          }
        }

        // Execute exclusive tools sequentially
        for (const i of exclusiveIndices) {
          throwIfAborted(this.#signal);
          const result = await this.#executeTool(toolCalls[i]!, sessionId);
          results[i] = {
            tc: toolCalls[i]!,
            output: result.output,
            isError: result.isError,
          };
        }

        // Phase 3: prepare and append all ToolResult events in original order
        const preparedResults = this.#prepareToolResults(sessionId, results);
        let askUserQuestion: string | null = null;
        let artifactFailure: string | null = null;
        for (let i = 0; i < toolCalls.length; i++) {
          throwIfAborted(this.#signal);
          const r = results[i]!;
          const prepared = preparedResults[i]!;
          const resultEvent: ToolResult = {
            type: "tool_result",
            seq: this.#nextSeq(),
            timestamp: this.#now(),
            sessionId,
            ...(this.#branchId ? { branchId: this.#branchId } : {}),
            toolName: r.tc.name,
            result: prepared.output,
            isError: prepared.isError,
            toolUseId: r.tc.id,
          };
          this.#threadStore.append(sessionId, resultEvent);
          this.#onToolResult?.({
            sessionId,
            toolName: r.tc.name,
            args: r.tc.args,
            result: prepared.output,
            isError: prepared.isError,
            toolUseId: r.tc.id,
          });

          if (prepared.artifactInfo) {
            const pointerEvent: ArtifactPointer = {
              type: "artifact_pointer",
              seq: this.#nextSeq(),
              timestamp: this.#now(),
              sessionId,
              ...(this.#branchId ? { branchId: this.#branchId } : {}),
              artifactId: prepared.artifactInfo.artifactId,
              mimeType: prepared.artifactInfo.mimeType,
              sizeBytes: prepared.artifactInfo.sizeBytes,
            };
            this.#threadStore.append(sessionId, pointerEvent);
          }

          if (prepared.artifactFailure && artifactFailure === null) {
            artifactFailure = prepared.artifactFailure;
          }

          if (r.tc.name === "ask_user" && !prepared.isError && askUserQuestion === null) {
            askUserQuestion = typeof prepared.output === "string"
              ? prepared.output
              : String(prepared.output);
          }
        }

        if (artifactFailure !== null) {
          return { outcome: "tool_failure", runtimeKind: "artifact", message: artifactFailure };
        }

        if (askUserQuestion !== null) {
          throwIfAborted(this.#signal);
          const msg: AssistantMessage = {
            type: "assistant_message",
            seq: this.#nextSeq(),
            timestamp: this.#now(),
            sessionId,
            ...(this.#branchId ? { branchId: this.#branchId } : {}),
            text: askUserQuestion,
          };
          this.#threadStore.append(sessionId, msg);
          return {
            outcome: "waiting_user",
            message: msg,
            question: askUserQuestion,
          };
        }

        const compactionUsage = usageForCompaction(response, messages, this.#requireUsageForCompaction);
        if ("failure" in compactionUsage) {
          return { outcome: "tool_failure", runtimeKind: "usage_telemetry", message: compactionUsage.failure };
        }
        if (compactionUsage.usage.input_tokens > this.#maxContextTokens - this.#autoCompactBuffer) {
          throwIfAborted(this.#signal);
          const failure = await this.#compactContext(sessionId);
          if (failure !== null) {
            return { outcome: "tool_failure", runtimeKind: "compaction", message: failure };
          }
        }
        continue;
      }
    }

    return { outcome: "tool_failure", message: "Max iterations exceeded" };
  }

  #refreshTools(): void {
    if (this.#toolsProvider) {
      this.#tools = this.#toolsProvider();
    }
    this.#toolDefs = new Map();
    for (const t of this.#tools) {
      this.#toolDefs.set(t.name, t);
    }
  }

  async #executeTool(
    tc: { id: string; name: string; args: Record<string, unknown> },
    sessionId: string,
  ): Promise<{ output: unknown; isError: boolean }> {
    try {
      throwIfAborted(this.#signal);
      const result = await raceAbort(
        this.#toolExecutor.execute(
          tc.name,
          tc.args,
          sessionId,
          {
            ...(this.#toolExecutionContext ?? {}),
            toolUseId: tc.id,
            ...(this.#signal ? { signal: this.#signal } : {}),
          },
        ),
        this.#signal,
      );
      throwIfAborted(this.#signal);
      return { output: result.output, isError: result.isError };
    } catch (err) {
      if (isAbortError(err)) throw err;
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }

  #prepareToolResults(
    sessionId: string,
    results: Array<{
      tc: { id: string; name: string; args: Record<string, unknown> };
      output: unknown;
      isError: boolean;
    } | null>,
  ): PreparedToolResult[] {
    const prepared: PreparedToolResult[] = results.map((r) => ({
      output: r!.output,
      isError: r!.isError,
    }));

    if (!this.#artifactStore) return prepared;

    const serialized = results.map((r) => serializeToolOutput(r!.output));
    const eligible = serialized
      .map((s, index) => {
        const toolName = results[index]!.tc.name;
        const threshold = this.#toolDefs.get(toolName)?.maxResultSizeChars
          ?? this.#artifactMaxResultSizeChars;
        return { index, sizeChars: s.sizeChars, threshold, mimeType: s.mimeType };
      })
      .filter((c) => Number.isFinite(c.threshold));

    const selected = new Set<number>();
    for (const candidate of eligible) {
      if (
        candidate.sizeChars > candidate.threshold ||
        candidate.mimeType === "application/octet-stream"
      ) {
        selected.add(candidate.index);
      }
    }

    let retainedChars = eligible.reduce((sum, c) => sum + c.sizeChars, 0);
    for (const candidate of eligible) {
      if (selected.has(candidate.index)) retainedChars -= candidate.sizeChars;
    }

    if (retainedChars > this.#artifactPerTurnBudgetChars) {
      const bySizeDesc = [...eligible]
        .filter((c) => !selected.has(c.index))
        .sort((a, b) => b.sizeChars - a.sizeChars);
      for (const candidate of bySizeDesc) {
        if (retainedChars <= this.#artifactPerTurnBudgetChars) break;
        selected.add(candidate.index);
        retainedChars -= candidate.sizeChars;
      }
    }

    for (const index of selected) {
      const r = results[index]!;
      const s = serialized[index]!;
      try {
        const info = this.#artifactStore.store(sessionId, s.data, s.mimeType);
        const preview = generatePreview(s.text, this.#artifactPreviewBytes);
        prepared[index] = {
          output: buildPersistedOutputMessage(info, preview, this.#artifactPreviewBytes),
          isError: r.isError,
          artifactInfo: info,
        };
      } catch (err) {
        const message = `Artifact persistence failed for ${r.tc.name}: ${
          err instanceof Error ? err.message : String(err)
        }`;
        prepared[index] = {
          output: message,
          isError: true,
          artifactFailure: message,
        };
      }
    }

    return prepared;
  }

  async #compactContext(sessionId: string): Promise<string | null> {
    try {
      const events = this.#readThread?.(sessionId) ?? this.#threadStore.getThread(sessionId);
      const boundary = this.#findCompactionBoundary(events);
      if (boundary === null) {
        return "Compaction could not find a safe event range to compact.";
      }
      if (this.#readThread) {
        return "Compaction for branched session views is not yet safe to apply without rewriting sibling branches.";
      }

      const oldEvents = events.slice(0, boundary);
      const block = await compact({
        events: oldEvents,
        seq: this.#nextSeq(),
        sessionId,
        modelProvider: this.#modelProvider,
        timestamp: this.#now(),
        requireUsage: this.#requireUsageForCompaction,
        ...(this.#signal ? { signal: this.#signal } : {}),
      });
      throwIfAborted(this.#signal);
      this.#threadStore.compactEvents(sessionId, 0, boundary - 1, block);
      this.#appendPostCompactionContextEstimate(sessionId);
      return null;
    } catch (err) {
      if (isAbortError(err)) throw err;
      return err instanceof Error ? err.message : String(err);
    }
  }

  #appendPostCompactionContextEstimate(sessionId: string): void {
    const messages = buildContext(this.#readThread?.(sessionId) ?? this.#threadStore.getThread(sessionId));
    const inputTokens = estimateTokensFromMessages(messages);
    const contextUsedPercent = (inputTokens / this.#maxContextTokens) * 100;
    const event: ContextUsageEvent = {
      type: "context_usage_event",
      seq: this.#nextSeq(),
      timestamp: this.#now(),
      sessionId,
      ...(this.#branchId ? { branchId: this.#branchId } : {}),
      source: "local_estimate",
      reason: "post_compaction",
      inputTokens,
      contextWindowTokens: this.#maxContextTokens,
      contextUsedPercent,
      estimated: true,
      message: `Local compacted context estimate · ctx ~${formatPercent(contextUsedPercent)} · in ~${inputTokens}`,
    };
    this.#threadStore.append(sessionId, event);
  }

  #findCompactionBoundary(events: SessionEvent[]): number | null {
    if (events.length < 2) return null;

    let tailTokens = 0;
    let boundary = events.length;
    for (let i = events.length - 1; i >= 0; i--) {
      tailTokens += estimateTokensFromEvent(events[i]!);
      boundary = i;
      if (tailTokens >= this.#compactionKeepRecentTokens) break;
    }

    if (tailTokens < this.#compactionKeepRecentTokens) return null;

    while (boundary > 0 && this.#tailHasDanglingToolResult(events, boundary)) {
      boundary--;
    }

    if (boundary <= 0 || boundary >= events.length) return null;
    return boundary;
  }

  #tailHasDanglingToolResult(events: SessionEvent[], startIndex: number): boolean {
    const toolCalls = new Set<string>();
    const toolResults: string[] = [];

    for (let i = startIndex; i < events.length; i++) {
      const event = events[i]!;
      if (event.type === "tool_call") {
        toolCalls.add(event.toolUseId ?? `call_${event.seq}`);
      } else if (event.type === "tool_result") {
        toolResults.push(event.toolUseId ?? `call_${event.seq - 1}`);
      }
    }

    return toolResults.some((id) => !toolCalls.has(id));
  }
}
