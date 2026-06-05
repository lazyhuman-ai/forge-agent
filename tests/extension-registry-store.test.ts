import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_EXTENSION_REGISTRY } from "../src/extensions/official-registry.js";
import { ExtensionRegistryStore, registryDocument } from "../src/extensions/registry-store.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "forgeagent-extension-registry-"));
}

describe("ExtensionRegistryStore", () => {
  it("ships a real built-in registry snapshot without mock sources or server-fetch", () => {
    expect(BUILTIN_EXTENSION_REGISTRY.length).toBeGreaterThan(10);
    for (const entry of BUILTIN_EXTENSION_REGISTRY) {
      expect(entry.source).toBeTruthy();
      expect(entry.source.toLowerCase()).not.toContain("mock");
      expect(JSON.stringify(entry.installInput)).not.toContain("server-fetch");
      if (entry.kind === "mcp_server") {
        expect(entry.provenance.packageName ?? entry.provenance.repository ?? entry.provenance.url).toBeTruthy();
      }
    }
    expect(BUILTIN_EXTENSION_REGISTRY.some((entry) => entry.id === "skill:serenity-invest-skill")).toBe(true);
    expect(BUILTIN_EXTENSION_REGISTRY.some((entry) => entry.id === "bundle:pdf-research")).toBe(true);
  });

  it("loads file registry sources and records install locks/events", () => {
    const root = tempRoot();
    try {
      let seq = 0;
      const store = new ExtensionRegistryStore({
        rootDir: root,
        nextSeq: () => ++seq,
        now: () => new Date(0).toISOString(),
      });
      const registryPath = join(root, "registry.json");
      writeFileSync(registryPath, JSON.stringify(registryDocument([
        {
          id: "skill:example-skill",
          kind: "skill",
          name: "example-skill",
          title: "Example Skill",
          description: "Example registry skill",
          source: "https://github.com/example/example-skill",
          sourceLabel: "Example source",
          trust: "community",
          capabilities: ["skill"],
          risk: "safe",
          riskSummary: "Readable skill.",
          installInput: { kind: "skill_github", url: "https://github.com/example/example-skill", name: "example-skill" },
          provenance: { type: "github", repository: "https://github.com/example/example-skill" },
        },
      ])));

      const source = store.addSource({ kind: "file", name: "Example", path: registryPath });
      expect(source.id).toBe("example");
      expect(store.listRegistryEntries().some((entry) => entry.id === "skill:example-skill")).toBe(true);

      const entry = store.listRegistryEntries().find((item) => item.id === "skill:example-skill")!;
      store.recordInstall({
        entry,
        installInput: entry.installInput,
        result: {
          kind: "skill",
          id: "example-skill@1.0.0",
          name: "example-skill",
          status: "active",
          message: "Skill installed and enabled: example-skill 1.0.0",
        },
      });
      expect(store.listLocks()[0]).toEqual(expect.objectContaining({
        id: "skill:example-skill",
        status: "active",
        sourceLabel: "Example source",
      }));
      expect(store.listEvents()).toEqual(expect.arrayContaining([
        expect.objectContaining({ detail: "source_added" }),
        expect.objectContaining({ detail: "enabled", extensionId: "skill:example-skill" }),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
