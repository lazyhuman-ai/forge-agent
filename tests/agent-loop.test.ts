import { rmSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentLoop } from "../src/agent/agent-loop.js";
import { SessionThreadStore } from "../src/streams/session-thread-store.js";
import type { ModelProvider, ModelResponse, ModelMessage } from "../src/agent/model-provider.js";
import type { ToolExecutor, ToolExecResult } from "../src/agent/tool-executor.js";
import type { UserMessage } from "../src/streams/event-types.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";

const sid = "s1";
const ts = "2025-01-01T00:00:00.000Z";
const ARTIFACT_BASE = ".forge/test-agent-loop-artifacts";

function makeProvider(responses: ModelResponse[]): ModelProvider {
  let i = 0;
  return {
    generate: vi.fn().mockImplementation(async (_msgs: ModelMessage[]) => {
      const r = responses[i];
      if (!r) throw new Error(`Unexpected generate call #${i}`);
      i++;
      return r;
    }),
  };
}

function makeExecutor(results: ToolExecResult[]): ToolExecutor {
  let i = 0;
  return {
    execute: vi.fn().mockImplementation(async (_name: string, _args: unknown, _sid: string) => {
      const r = results[i];
      if (!r) throw new Error(`Unexpected execute call #${i}`);
      i++;
      return r;
    }),
  };
}

describe("AgentLoop", () => {
  let store: SessionThreadStore;
  let seq: number;
  const now = () => ts;
  const nextSeq = () => seq++;

  beforeEach(() => {
    rmSync(ARTIFACT_BASE, { recursive: true, force: true });
    store = new SessionThreadStore();
    seq = 2; // start after the seed user message (seq=1)
  });

  it("completes a simple turn with stop response", async () => {
    const provider = makeProvider([{ text: "Hello, world!", finishReason: "stop" }]);
    const executor = makeExecutor([]);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now);

    // Seed thread with a user message
    const userMsg: UserMessage = { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "hi" };
    store.append(sid, userMsg);

    const result = await loop.runTurn(sid);
    expect(result.outcome).toBe("turn_finished");
    if (result.outcome === "turn_finished") {
      expect(result.message.text).toBe("Hello, world!");
    }

    const thread = store.getThread(sid);
    expect(thread).toHaveLength(2); // user msg + assistant msg
    expect(thread[1]!.type).toBe("assistant_message");
  });

  it("handles tool calls and completes after tool results", async () => {
    const responses: ModelResponse[] = [
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "tc1", name: "read", args: { path: "/x" } }] },
      { text: "I read the file.", finishReason: "stop" },
    ];

    const results: ToolExecResult[] = [
      { toolCallId: "tc1", toolName: "read", output: "file contents", isError: false },
    ];

    const provider = makeProvider(responses);
    const executor = makeExecutor(results);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now);

    const userMsg: UserMessage = { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "read /x" };
    store.append(sid, userMsg);

    const result = await loop.runTurn(sid);
    expect(result.outcome).toBe("turn_finished");

    const thread = store.getThread(sid);
    // user_msg, tool_call, tool_result, assistant_msg
    expect(thread).toHaveLength(4);
    expect(thread[1]!.type).toBe("tool_call");
    expect(thread[2]!.type).toBe("tool_result");
    expect(thread[3]!.type).toBe("assistant_message");
  });

  it("refreshes tool definitions between model iterations", async () => {
    const tools = [{ name: "extension_install", description: "Install", params: {} }];
    let call = 0;
    const provider: ModelProvider = {
      generate: vi.fn().mockImplementation(async (_msgs: ModelMessage[], visibleTools?: Array<{ name: string }>) => {
        call++;
        if (call === 1) {
          expect(visibleTools?.map((toolDef) => toolDef.name)).toEqual(["extension_install"]);
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc1", name: "extension_install", args: {} }],
          } satisfies ModelResponse;
        }
        if (call === 2) {
          expect(visibleTools?.map((toolDef) => toolDef.name)).toContain("mcp__NewServer__echo");
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc2", name: "mcp__NewServer__echo", args: { text: "ok" } }],
          } satisfies ModelResponse;
        }
        return { text: "dynamic tool worked", finishReason: "stop" } satisfies ModelResponse;
      }),
    };
    const executor: ToolExecutor = {
      execute: vi.fn().mockImplementation(async (name: string) => {
        if (name === "extension_install") {
          tools.push({ name: "mcp__NewServer__echo", description: "Echo", params: {} });
          return { toolCallId: "tc1", toolName: name, output: "installed", isError: false };
        }
        return { toolCallId: "tc2", toolName: name, output: "echo ok", isError: false };
      }),
    };
    const loop = new AgentLoop(provider, executor, store, nextSeq, now, {
      toolsProvider: () => tools,
    });

    store.append(sid, { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "install and use" });

    const result = await loop.runTurn(sid);
    expect(result.outcome).toBe("turn_finished");
    expect(executor.execute).toHaveBeenCalledWith(
      "mcp__NewServer__echo",
      { text: "ok" },
      sid,
      expect.anything(),
    );
  });

  it("continues after tool execution returns error", async () => {
    const responses: ModelResponse[] = [
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "tc1", name: "bad_tool", args: {} }] },
      { text: "I saw the tool error and recovered.", finishReason: "stop" },
    ];

    const results: ToolExecResult[] = [
      { toolCallId: "tc1", toolName: "bad_tool", output: "crash", isError: true },
    ];

    const provider = makeProvider(responses);
    const executor = makeExecutor(results);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now);

    const userMsg: UserMessage = { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "use bad tool" };
    store.append(sid, userMsg);

    const result = await loop.runTurn(sid);
    expect(result.outcome).toBe("turn_finished");
    if (result.outcome === "turn_finished") {
      expect(result.message.text).toBe("I saw the tool error and recovered.");
    }

    const thread = store.getThread(sid);
    expect(thread.map((e) => e.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
    expect(thread[2]!.type).toBe("tool_result");
    if (thread[2]!.type === "tool_result") {
      expect(thread[2]!.isError).toBe(true);
      expect(thread[2]!.result).toBe("crash");
    }

    expect(provider.generate).toHaveBeenCalledTimes(2);
    const secondCall = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[1]!;
    const messages = secondCall[0] as ModelMessage[];
    expect(messages.some((m) => m.role === "tool" && m.content === "crash")).toBe(true);
  });

  it("persists large tool output to artifact and writes a pointer", async () => {
    const largeOutput = "x".repeat(50_001);
    const artifactStore = new ArtifactStore(ARTIFACT_BASE);
    const provider = makeProvider([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "tc1", name: "big", args: {} }] },
      { text: "I saw the artifact pointer.", finishReason: "stop" },
    ]);
    const executor = makeExecutor([
      { toolCallId: "tc1", toolName: "big", output: largeOutput, isError: false },
    ]);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now, { artifactStore });

    store.append(sid, { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "run big" });

    const result = await loop.runTurn(sid);
    expect(result.outcome).toBe("turn_finished");

    const artifacts = artifactStore.listBySession(sid);
    expect(artifacts).toHaveLength(1);
    expect(artifactStore.retrieve(artifacts[0]!.artifactId)?.toString()).toBe(largeOutput);

    const thread = store.getThread(sid);
    expect(thread.map((e) => e.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_result",
      "artifact_pointer",
      "assistant_message",
    ]);
    expect(thread[2]!.type).toBe("tool_result");
    if (thread[2]!.type === "tool_result") {
      expect(thread[2]!.result).toContain("<persisted-output>");
      expect(String(thread[2]!.result)).toContain(artifacts[0]!.artifactId);
      expect(String(thread[2]!.result).length).toBeLessThan(5_000);
    }
    expect(thread[3]!.type).toBe("artifact_pointer");
    if (thread[3]!.type === "artifact_pointer") {
      expect(thread[3]!.artifactId).toBe(artifacts[0]!.artifactId);
      expect(thread[3]!.sizeBytes).toBe(largeOutput.length);
    }

    const secondCall = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[1]!;
    const messages = secondCall[0] as ModelMessage[];
    expect(messages.some((m) => m.role === "tool" && m.content.includes("<persisted-output>"))).toBe(true);
    expect(messages.some((m) => m.role === "system" && m.content.includes("[Artifact:"))).toBe(true);
  });

  it("persists large error output while preserving isError and continuing", async () => {
    const largeError = "error\n" + "x".repeat(50_001);
    const artifactStore = new ArtifactStore(ARTIFACT_BASE);
    const provider = makeProvider([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "tc1", name: "bad", args: {} }] },
      { text: "Recovered after reading the error preview.", finishReason: "stop" },
    ]);
    const executor = makeExecutor([
      { toolCallId: "tc1", toolName: "bad", output: largeError, isError: true },
    ]);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now, { artifactStore });

    store.append(sid, { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "run bad" });

    const result = await loop.runTurn(sid);
    expect(result.outcome).toBe("turn_finished");

    const thread = store.getThread(sid);
    expect(thread[2]!.type).toBe("tool_result");
    if (thread[2]!.type === "tool_result") {
      expect(thread[2]!.isError).toBe(true);
      expect(thread[2]!.result).toContain("<persisted-output>");
    }
    expect(thread.some((e) => e.type === "artifact_pointer")).toBe(true);
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });

  it("persists largest outputs when aggregate tool results exceed per-turn budget", async () => {
    const largeA = "a".repeat(80_000);
    const largeB = "b".repeat(70_000);
    const artifactStore = new ArtifactStore(ARTIFACT_BASE);
    const provider = makeProvider([
      {
        text: "",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "tc1", name: "a", args: {} },
          { id: "tc2", name: "b", args: {} },
        ],
      },
      { text: "Done.", finishReason: "stop" },
    ]);
    const executor = makeExecutor([
      { toolCallId: "tc1", toolName: "a", output: largeA, isError: false },
      { toolCallId: "tc2", toolName: "b", output: largeB, isError: false },
    ]);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now, {
      artifactStore,
      artifactMaxResultSizeChars: 1_000_000,
      artifactPerTurnBudgetChars: 100_000,
    });

    store.append(sid, { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "run two" });

    const result = await loop.runTurn(sid);
    expect(result.outcome).toBe("turn_finished");

    const artifacts = artifactStore.listBySession(sid);
    expect(artifacts).toHaveLength(1);
    expect(artifactStore.retrieve(artifacts[0]!.artifactId)?.toString()).toBe(largeA);
    const thread = store.getThread(sid);
    expect(thread.filter((e) => e.type === "artifact_pointer")).toHaveLength(1);
  });

  it("returns artifact tool_failure when artifact persistence fails without writing raw output", async () => {
    class FailingArtifactStore extends ArtifactStore {
      override store(_sessionId: string, _data: Buffer | string, _mimeType: string): never {
        throw new Error("disk full");
      }
    }

    const largeOutput = "x".repeat(50_001);
    const provider = makeProvider([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "tc1", name: "big", args: {} }] },
    ]);
    const executor = makeExecutor([
      { toolCallId: "tc1", toolName: "big", output: largeOutput, isError: false },
    ]);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now, {
      artifactStore: new FailingArtifactStore(ARTIFACT_BASE),
    });

    store.append(sid, { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "run big" });

    const result = await loop.runTurn(sid);
    expect(result.outcome).toBe("tool_failure");
    if (result.outcome === "tool_failure") {
      expect(result.runtimeKind).toBe("artifact");
      expect(result.message).toContain("disk full");
    }

    const thread = store.getThread(sid);
    expect(thread.map((e) => e.type)).toEqual(["user_message", "tool_call", "tool_result"]);
    expect(thread[2]!.type).toBe("tool_result");
    if (thread[2]!.type === "tool_result") {
      expect(thread[2]!.isError).toBe(true);
      expect(thread[2]!.result).toContain("Artifact persistence failed");
      expect(thread[2]!.result).not.toBe(largeOutput);
    }
  });

  it("returns waiting_user when ask_user succeeds", async () => {
    const responses: ModelResponse[] = [
      {
        text: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "ask1",
          name: "ask_user",
          args: { question: "What should I do next?" },
        }],
      },
    ];

    const results: ToolExecResult[] = [
      { toolCallId: "ask1", toolName: "ask_user", output: "What should I do next?", isError: false },
    ];

    const provider = makeProvider(responses);
    const executor = makeExecutor(results);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now);

    const userMsg: UserMessage = { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "start" };
    store.append(sid, userMsg);

    const result = await loop.runTurn(sid);
    expect(result.outcome).toBe("waiting_user");
    if (result.outcome === "waiting_user") {
      expect(result.question).toBe("What should I do next?");
      expect(result.message.text).toBe("What should I do next?");
    }

    const thread = store.getThread(sid);
    expect(thread.map((e) => e.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
  });

  it("continues after executor throws by recording a tool error", async () => {
    const provider = makeProvider([
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "tc1", name: "explode", args: {} }] },
      { text: "Recovered from executor error.", finishReason: "stop" },
    ]);
    const executor: ToolExecutor = {
      execute: vi.fn().mockRejectedValue(new Error("executor exploded")),
    };
    const loop = new AgentLoop(provider, executor, store, nextSeq, now);

    const userMsg: UserMessage = { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "explode" };
    store.append(sid, userMsg);

    const result = await loop.runTurn(sid);

    expect(result.outcome).toBe("turn_finished");
    if (result.outcome === "turn_finished") {
      expect(result.message.text).toBe("Recovered from executor error.");
    }

    const thread = store.getThread(sid);
    expect(thread.map((e) => e.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
    expect(thread[2]!.type).toBe("tool_result");
    if (thread[2]!.type === "tool_result") {
      expect(thread[2]!.isError).toBe(true);
      expect(thread[2]!.result).toBe("executor exploded");
    }

    expect(provider.generate).toHaveBeenCalledTimes(2);
    const secondCall = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[1]!;
    const messages = secondCall[0] as ModelMessage[];
    expect(messages.some((m) => m.role === "tool" && m.content === "executor exploded")).toBe(true);
  });

  it("returns failure if max iterations exceeded", async () => {
    // Always returns tool_calls — forces infinite loop
    const responses: ModelResponse[] = Array.from({ length: 100 }, () => ({
      text: "",
      finishReason: "tool_calls" as const,
      toolCalls: [{ id: "tc", name: "ping", args: {} }],
    }));

    const results: ToolExecResult[] = Array.from({ length: 100 }, (_, i) => ({
      toolCallId: `tc${i}`, toolName: "ping", output: "ok", isError: false,
    }));

    const provider = makeProvider(responses);
    const executor = makeExecutor(results);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now);

    const result = await loop.runTurn(sid);
    expect(result.outcome).toBe("tool_failure");
    expect(result.message).toBe("Max iterations exceeded");
  });

  it("modelProvider is called with context from thread", async () => {
    const provider = makeProvider([{ text: "ok", finishReason: "stop" }]);
    const executor = makeExecutor([]);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now);

    const userMsg: UserMessage = { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "test" };
    store.append(sid, userMsg);

    await loop.runTurn(sid);

    expect(provider.generate).toHaveBeenCalledTimes(1);
    const call = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const msgs = call[0] as ModelMessage[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toBe("test");
  });

  it("runs LLM compaction when input tokens exceed threshold", async () => {
    const provider = makeProvider([
      {
        text: "final answer",
        finishReason: "stop",
        rawUsage: { input_tokens: 9, output_tokens: 1 },
      },
      {
        text: "## Active Task\nNone.\n\n## Critical Context\nCompacted prior user request.",
        finishReason: "stop",
      },
    ]);
    const executor = makeExecutor([]);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now, {
      maxContextTokens: 10,
      autoCompactBuffer: 5,
      compactionKeepRecentTokens: 1,
    });

    store.append(sid, { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "old request" });

    const result = await loop.runTurn(sid);

    expect(result.outcome).toBe("turn_finished");
    expect(provider.generate).toHaveBeenCalledTimes(2);
    const compactCall = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect(compactCall[1]).toBeUndefined();
    const compactMessages = compactCall[0] as ModelMessage[];
    expect(compactMessages[0]!.content).toContain("Do NOT call any tools");
    expect(compactMessages[1]!.content).toContain("old request");

    const thread = store.getThread(sid);
    expect(thread.map((e) => e.type)).toEqual(["compaction_block", "assistant_message", "context_usage_event"]);
    expect(thread[0]!.type).toBe("compaction_block");
    if (thread[0]!.type === "compaction_block") {
      expect(thread[0]!.summary).toContain("## Active Task");
      expect(thread[0]!.coversEvents).toEqual([1, 1]);
    }
    expect(thread[2]!.type).toBe("context_usage_event");
    if (thread[2]!.type === "context_usage_event") {
      expect(thread[2]!.source).toBe("local_estimate");
      expect(thread[2]!.reason).toBe("post_compaction");
      expect(thread[2]!.estimated).toBe(true);
      expect(thread[2]!.message).toContain("Local compacted context estimate");
    }
  });

  it("uses message token estimates to trigger compaction when provider usage is missing", async () => {
    const provider = makeProvider([
      {
        text: "final answer",
        finishReason: "stop",
      },
      {
        text: "## Active Task\nNone.\n\n## Critical Context\nEstimated input compacted.",
        finishReason: "stop",
      },
    ]);
    const executor = makeExecutor([]);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now, {
      maxContextTokens: 80,
      autoCompactBuffer: 20,
      compactionKeepRecentTokens: 1,
    });

    store.append(sid, {
      type: "user_message",
      seq: 1,
      timestamp: ts,
      sessionId: sid,
      text: "old request " + "context ".repeat(120),
    });

    const result = await loop.runTurn(sid);

    expect(result.outcome).toBe("turn_finished");
    expect(provider.generate).toHaveBeenCalledTimes(2);
    const thread = store.getThread(sid);
    expect(thread.map((e) => e.type)).toEqual(["compaction_block", "assistant_message", "context_usage_event"]);
  });

  it("returns usage telemetry failure instead of estimating when real usage is required", async () => {
    const provider = makeProvider([
      {
        text: "final answer",
        finishReason: "stop",
      },
    ]);
    const executor = makeExecutor([]);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now, {
      maxContextTokens: 80,
      autoCompactBuffer: 20,
      compactionKeepRecentTokens: 1,
      requireUsageForCompaction: true,
    });

    store.append(sid, {
      type: "user_message",
      seq: 1,
      timestamp: ts,
      sessionId: sid,
      text: "old request " + "context ".repeat(120),
    });

    const result = await loop.runTurn(sid);

    expect(result.outcome).toBe("tool_failure");
    if (result.outcome === "tool_failure") {
      expect(result.runtimeKind).toBe("usage_telemetry");
      expect(result.message).toContain("Provider did not return token usage");
    }
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(store.getThread(sid).map((e) => e.type)).toEqual(["user_message", "assistant_message"]);
  });

  it("returns compaction tool_failure when LLM compaction fails", async () => {
    const provider: ModelProvider = {
      generate: vi.fn()
        .mockResolvedValueOnce({
          text: "final answer",
          finishReason: "stop",
          rawUsage: { input_tokens: 9, output_tokens: 1 },
        })
        .mockRejectedValueOnce(new Error("summary failed")),
    };
    const executor = makeExecutor([]);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now, {
      maxContextTokens: 10,
      autoCompactBuffer: 5,
      compactionKeepRecentTokens: 1,
    });

    store.append(sid, { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "old request" });

    const result = await loop.runTurn(sid);

    expect(result.outcome).toBe("tool_failure");
    if (result.outcome === "tool_failure") {
      expect(result.runtimeKind).toBe("compaction");
      expect(result.message).toContain("summary failed");
    }
    expect(store.getThread(sid).map((e) => e.type)).toEqual(["user_message", "assistant_message"]);
  });

  it("keeps tool_call with retained tool_result when selecting compaction boundary", async () => {
    seq = 5;
    const provider = makeProvider([
      {
        text: "done",
        finishReason: "stop",
        rawUsage: { input_tokens: 9, output_tokens: 1 },
      },
      {
        text: "## Active Task\nNone.\n\n## Critical Context\nEarlier setup compacted.",
        finishReason: "stop",
      },
    ]);
    const executor = makeExecutor([]);
    const loop = new AgentLoop(provider, executor, store, nextSeq, now, {
      maxContextTokens: 10,
      autoCompactBuffer: 5,
      compactionKeepRecentTokens: 100,
    });

    store.append(sid, { type: "user_message", seq: 1, timestamp: ts, sessionId: sid, text: "setup" });
    store.append(sid, {
      type: "tool_call",
      seq: 2,
      timestamp: ts,
      sessionId: sid,
      toolName: "read",
      args: { path: "/tmp/a" },
      toolUseId: "tc1",
    });
    store.append(sid, {
      type: "tool_result",
      seq: 3,
      timestamp: ts,
      sessionId: sid,
      toolName: "read",
      result: "x".repeat(400),
      isError: false,
      toolUseId: "tc1",
    });
    store.append(sid, { type: "user_message", seq: 4, timestamp: ts, sessionId: sid, text: "continue" });

    const result = await loop.runTurn(sid);

    expect(result.outcome).toBe("turn_finished");
    const thread = store.getThread(sid);
    expect(thread.map((e) => e.type)).toEqual([
      "compaction_block",
      "tool_call",
      "tool_result",
      "user_message",
      "assistant_message",
      "context_usage_event",
    ]);
    expect(thread[1]!.type).toBe("tool_call");
    expect(thread[2]!.type).toBe("tool_result");
    if (thread[1]!.type === "tool_call" && thread[2]!.type === "tool_result") {
      expect(thread[1]!.toolUseId).toBe(thread[2]!.toolUseId);
    }
  });
});
