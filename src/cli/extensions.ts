import { CoreAPI } from "../core/core-api.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { ExtensionInstallInput } from "../extensions/types.js";

function usage(): void {
  console.log(`ForgeAgent Extensions

Usage:
  npm run extensions -- status
  npm run extensions -- search <query>
  npm run extensions -- install-skill <name> [--source <sourceId>] [--version <version>] [--registry-url <url>] [--trust-unsigned]
  npm run extensions -- install-skill-github <url> [--name <name>] [--version <version>] [--force]
  npm run extensions -- install-bundle <bundleName>
  npm run extensions -- install-mcp-catalog <catalogId> [--enable]
  npm run extensions -- add-mcp <name> --command <command> [--args "a,b,c"] [--enable]
  npm run extensions -- enable skill <name>
  npm run extensions -- enable mcp_server <serverId>
  npm run extensions -- enable bundle <bundleName>
  npm run extensions -- sources
  npm run extensions -- add-source <name> --kind http|github|file --url <url>|--path <path>
  npm run extensions -- refresh-source <sourceId>
  npm run extensions -- events [afterSeq]
  npm run extensions -- doctor
`);
}

function flag(name: string, argv = process.argv): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function hasFlag(name: string, argv = process.argv): boolean {
  return argv.includes(name);
}

function commandArgs(): string[] {
  const args = process.argv.slice(3);
  const clean: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--data-dir") {
      i++;
      continue;
    }
    clean.push(arg);
  }
  return clean;
}

function makeApi(dataDir: string): CoreAPI {
  const registry = new ToolRegistry();
  const api = new CoreAPI(registry, { dataDir });
  api.registerBuiltInTools();
  api.initToolPolicy();
  api.initSkillEcosystem({ autoRun: false });
  api.initMcpEcosystem();
  api.initExtensionEcosystem();
  return api;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  const dataDir = flag("--data-dir") ?? process.env.FORGE_DATA_DIR ?? ".forge";
  const args = commandArgs();
  const api = makeApi(dataDir);
  if (command === "status") {
    console.log(JSON.stringify(api.getExtensions(), null, 2));
    return;
  }

  if (command === "doctor") {
    const status = api.getExtensions();
    console.log(`ForgeAgent extension doctor`);
    console.log(`Installed: ${status.counts.installed}`);
    console.log(`Enabled: ${status.counts.enabled}`);
    console.log(`Attention: ${status.counts.quarantined + status.counts.invalid}`);
    console.log(`Registry sources: ${status.registry.sources.length}`);
    console.log(`Registry entries: ${status.registry.entries.length}`);
    console.log(`Locks: ${status.registry.locks.length}`);
    if (status.registry.diagnostics.length > 0) {
      console.log("\nDiagnostics:");
      for (const diagnostic of status.registry.diagnostics) console.log(`- ${diagnostic}`);
    }
    return;
  }

  if (command === "search") {
    const query = args.join(" ").trim();
    const candidates = api.searchExtensions({ query, includeInstalled: true });
    if (candidates.length === 0) {
      console.log("No matching extensions found.");
      return;
    }
    for (const candidate of candidates) {
      console.log(`${candidate.id}\t${candidate.status}\t${candidate.trust}\t${candidate.title}`);
      console.log(`  ${candidate.description}`);
      if (candidate.reviewState && candidate.reviewState !== "safe") {
        console.log(`  attention: ${candidate.reviewState}${candidate.reviewAction ? ` (${candidate.reviewAction})` : ""}`);
      }
      if (candidate.setupRequired) console.log(`  setup_required: ${candidate.postInstall ?? "configure required values before enabling"}`);
      console.log(`  install_input: ${JSON.stringify(candidate.installInput)}`);
    }
    return;
  }

  if (command === "install-skill") {
    const name = args[0];
    if (!name) throw new Error("Missing skill name.");
    const input: ExtensionInstallInput = {
      kind: "skill",
      name,
    };
    const version = flag("--version");
    const sourceId = flag("--source");
    const registryUrl = flag("--registry-url");
    if (version) input.version = version;
    if (sourceId) input.sourceId = sourceId;
    if (registryUrl) input.registryUrl = registryUrl;
    if (hasFlag("--trust-unsigned")) input.trustUnsigned = true;
    console.log(JSON.stringify(await api.installExtension(input), null, 2));
    return;
  }

  if (command === "install-skill-github") {
    const url = args[0];
    if (!url) throw new Error("Missing GitHub/raw SKILL.md URL.");
    const input: ExtensionInstallInput = {
      kind: "skill_github",
      url,
    };
    const name = flag("--name");
    const version = flag("--version");
    if (name) input.name = name;
    if (version) input.version = version;
    if (hasFlag("--force")) input.force = true;
    console.log(JSON.stringify(await api.installExtension(input), null, 2));
    return;
  }

  if (command === "install-bundle") {
    const bundleName = args[0];
    if (!bundleName) throw new Error("Missing bundle name.");
    const [candidate] = api.searchExtensions({ query: bundleName, includeInstalled: true })
      .filter((item) => item.kind === "bundle" && item.name === bundleName);
    if (!candidate) throw new Error(`Bundle not found: ${bundleName}`);
    console.log(JSON.stringify(await api.installExtension(candidate.installInput), null, 2));
    return;
  }

  if (command === "install-mcp-catalog") {
    const catalogId = args[0];
    if (!catalogId) throw new Error("Missing MCP catalog id.");
    console.log(JSON.stringify(await api.installExtension({
      kind: "mcp_catalog",
      catalogId,
      enable: hasFlag("--enable"),
    }), null, 2));
    return;
  }

  if (command === "add-mcp") {
    const name = args[0];
    const commandFlag = flag("--command");
    if (!name) throw new Error("Missing MCP server name.");
    if (!commandFlag) throw new Error("Missing --command.");
    const mcpArgs = flag("--args")?.split(",").map((part) => part.trim()).filter(Boolean);
    console.log(JSON.stringify(await api.installExtension({
      kind: "mcp_server",
      server: {
        name,
        enabled: false,
        transport: "stdio",
        launchMode: "lazy",
        trust: "untrusted",
        command: commandFlag,
        ...(mcpArgs ? { args: mcpArgs } : {}),
        source: "local",
      },
      enable: hasFlag("--enable"),
    }), null, 2));
    return;
  }

  if (command === "enable") {
    const kind = args[0];
    const id = args[1];
    if (kind !== "skill" && kind !== "mcp_server" && kind !== "bundle") {
      throw new Error("Kind must be skill, mcp_server, or bundle.");
    }
    if (!id) throw new Error("Missing extension id/name.");
    console.log(JSON.stringify(await api.enableExtension(
      kind,
      id,
      undefined,
      hasFlag("--trust-warnings") ? { trustWarnings: true } : undefined,
    ), null, 2));
    return;
  }

  if (command === "sources") {
    console.log(JSON.stringify(api.getExtensionSources(), null, 2));
    return;
  }

  if (command === "add-source") {
    const name = args[0];
    const kind = flag("--kind");
    if (!name) throw new Error("Missing source name.");
    if (kind !== "http" && kind !== "github" && kind !== "file") throw new Error("--kind must be http, github, or file.");
    console.log(JSON.stringify(api.addExtensionSource({
      kind,
      name,
      ...(kind === "file" ? { path: flag("--path") ?? "" } : { url: flag("--url") ?? "" }),
      ...(hasFlag("--trust-unsigned") ? { trustUnsigned: true } : {}),
    }), null, 2));
    return;
  }

  if (command === "refresh-source") {
    const id = args[0];
    if (!id) throw new Error("Missing source id.");
    console.log(JSON.stringify(await api.refreshExtensionSource(id), null, 2));
    return;
  }

  if (command === "events") {
    const afterSeq = Number(args[0] ?? 0);
    console.log(JSON.stringify(api.getExtensionEvents(Number.isFinite(afterSeq) ? afterSeq : 0), null, 2));
    return;
  }

  usage();
  throw new Error(`Unknown extensions command: ${command}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
