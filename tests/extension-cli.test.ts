import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-extension-cli-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("extensions CLI", () => {
  it("honors --data-dir without mixing it into search query", () => {
    const dataDir = makeTmpDir();
    const output = execFileSync(process.execPath, [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("src/cli/extensions.ts"),
      "search",
      "blender",
      "--data-dir",
      dataDir,
    ], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(output).toContain("mcp-catalog:mcp-server-blender");
    expect(output).toContain("Blender MCP");
    expect(output).toContain("setup_required");
    expect(output).not.toContain("--data-dir");
  });
});
