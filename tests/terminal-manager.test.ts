import { describe, expect, it } from "vitest";
import { TerminalManager, type TerminalOutputEvent } from "../src/runtimes/terminal/terminal-manager.js";

function waitForOutput(
  manager: TerminalManager,
  id: string,
  predicate: (event: TerminalOutputEvent) => boolean,
  timeoutMs = 4_000,
): Promise<TerminalOutputEvent> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("Timed out waiting for terminal output."));
    }, timeoutMs);
    unsubscribe = manager.subscribe(id, 0, (event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(event);
    });
    if (!unsubscribe) {
      clearTimeout(timer);
      reject(new Error("Terminal session missing."));
    }
  });
}

describe("TerminalManager", () => {
  it("keeps an interactive shell session and streams command output", async () => {
    const manager = new TerminalManager();
    const shell = process.platform === "win32" ? process.env.ComSpec : "/bin/sh";
    const session = manager.create(shell ? { shell } : {});
    try {
      const output = waitForOutput(
        manager,
        session.id,
        (event) => event.data.includes("forge-terminal-test"),
      );
      manager.write(session.id, "echo forge-terminal-test\n");
      await expect(output).resolves.toMatchObject({ stream: expect.any(String) });
      expect(manager.snapshot(session.id)?.status).toBe("running");
      manager.write(session.id, "exit\n");
    } finally {
      manager.shutdown();
    }
  });
});
