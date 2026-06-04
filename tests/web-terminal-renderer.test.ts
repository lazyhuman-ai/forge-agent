import { describe, expect, it } from "vitest";
import { renderTerminalOutput } from "../web/src/terminal-renderer.js";
import type { TerminalOutputEvent } from "../web/src/types.js";

function event(data: string, seq = 1): TerminalOutputEvent {
  return {
    seq,
    timestamp: "2026-01-01T00:00:00.000Z",
    stream: "stdout",
    data,
  };
}

describe("terminal output renderer", () => {
  it("overwrites a carriage-return redraw instead of duplicating the line", () => {
    expect(renderTerminalOutput([
      event("prompt % echo hello"),
      event("\rprompt % echo world"),
    ])).toBe("prompt % echo world");
  });

  it("renders shell backspace echo as deletion", () => {
    expect(renderTerminalOutput([
      event("prompt % abc"),
      event("\b \bd"),
    ])).toBe("prompt % abd");
  });

  it("applies common ANSI erase-line redraws", () => {
    expect(renderTerminalOutput([
      event("prompt % old command"),
      event("\r\x1b[Kprompt % new"),
    ])).toBe("prompt % new");
  });
});
