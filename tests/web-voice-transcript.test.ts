import { describe, expect, it } from "vitest";
import { mergeRollingTranscript } from "../web/src/voice-transcript.js";

describe("voice transcript rolling merge", () => {
  it("does not append a repeated rolling window", () => {
    expect(mergeRollingTranscript("你好 ForgeAgent", "你好 ForgeAgent")).toBe("你好 ForgeAgent");
  });

  it("appends only the non-overlapping suffix", () => {
    expect(mergeRollingTranscript("今天天气很好", "很好我们出门吧")).toBe("今天天气很好我们出门吧");
  });

  it("keeps existing text when the new window is fully contained", () => {
    expect(mergeRollingTranscript("请帮我总结一下这个项目", "总结一下")).toBe("请帮我总结一下这个项目");
  });
});
