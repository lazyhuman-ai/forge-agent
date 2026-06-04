import { describe, expect, it } from "vitest";
import { shouldSubmitOnEnter } from "../web/src/ime.js";

function keyEvent(input: {
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}) {
  return {
    key: input.key ?? "Enter",
    shiftKey: input.shiftKey ?? false,
    nativeEvent: {
      isComposing: input.isComposing ?? false,
      keyCode: input.keyCode ?? 13,
    },
  };
}

describe("web app IME enter handling", () => {
  it("submits regular Enter", () => {
    expect(shouldSubmitOnEnter(keyEvent({}), 0, 1_000)).toBe(true);
  });

  it("keeps Shift+Enter available for newlines", () => {
    expect(shouldSubmitOnEnter(keyEvent({ shiftKey: true }), 0, 1_000)).toBe(false);
  });

  it("does not submit while the browser reports active IME composition", () => {
    expect(shouldSubmitOnEnter(keyEvent({ isComposing: true }), 0, 1_000)).toBe(false);
  });

  it("does not submit Safari/WebKit IME Enter events reported as keyCode 229", () => {
    expect(shouldSubmitOnEnter(keyEvent({ keyCode: 229 }), 0, 1_000)).toBe(false);
  });

  it("does not submit the Enter event that immediately follows compositionend", () => {
    expect(shouldSubmitOnEnter(keyEvent({}), 950, 1_000)).toBe(false);
    expect(shouldSubmitOnEnter(keyEvent({}), 899, 1_000)).toBe(true);
  });
});
