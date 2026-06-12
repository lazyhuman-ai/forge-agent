# DeepSeek-Forge

<p align="center">
  <img src="assets/forge_en.png" alt="DeepSeek-Forge DeepSeek-native local agent workspace" width="100%" />
</p>

<p align="center">
  <strong>A DeepSeek-native local agent workspace for Mac, Chrome, Android, MCP, browser automation, and real project work.</strong>
</p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

> [!IMPORTANT]
> DeepSeek-Forge is an independent open-source project. It is not an official DeepSeek product or affiliated with DeepSeek. The name describes the product's DeepSeek-first runtime path and telemetry support.

DeepSeek-Forge runs a private agent core on your Mac and gives it a durable workspace: project files, command tools, browser access, MCP servers, long-context memory, extension skills, mobile access, and a single conversation/activity stream. It is meant to feel like a local agent product, not a hosted SaaS tab.

The runtime is built around DeepSeek rather than treating it as a generic OpenAI-compatible endpoint. When DeepSeek returns usage, context, prefix-cache, and reasoning-token telemetry, DeepSeek-Forge records those facts and uses them for compaction, cost visibility, and debugging long sessions.

## Why DeepSeek-Forge

- **DeepSeek-native by default.** Real token usage, context usage, cache hit/miss, reasoning tokens, and cache-shape diagnostics are first-class product data.
- **Local-first workspace.** Core, Web Console, macOS app, Android app, Chrome extension, MCP tools, permissions, artifacts, and session history share one local fact source.
- **Not coding-only.** Coding is a high-density workspace adapter alongside documents, browser work, MCP/Blender tasks, research, generated reports, and automation.
- **Multi-device private access.** Pair Android or iPhone/iPad Safari to the Mac running Core. Remote access is private-network first, with Tailscale as the recommended free path.
- **Extension and MCP ready.** Install local skills, GitHub-hosted skill packages, and MCP servers into the same permission and artifact model.
- **Beta-grade recovery.** Tool failures, sandbox denials, browser bridge outages, provider telemetry gaps, and blocked sessions are surfaced as readable state instead of silent hangs.

## Features

- DeepSeek provider setup with masked local key storage.
- Usage ledger for token, context, reasoning, prefix cache, and cost events.
- Context compaction with visible before/after telemetry.
- Local Web Console for sessions, files, tasks, artifacts, usage, MCP, skills, memory, browser status, and mobile pairing.
- macOS app that starts or reuses Core through LaunchAgent and keeps the local service online.
- Android paired WebView client with QR pairing, connection recovery, and activity notifications.
- ForgeWebridge Chrome extension for controlling the visible logged-in Chrome profile without reading cookies or passwords.
- MCP registry and extension installer with packaged skills, assets, references, scripts, and templates.
- Coding workspace support with LSP-oriented navigation, structured workspace activity, worktree/subagent flows, and release E2E gates.

## Install

Requirements:

- macOS for the local desktop Core and packaged app.
- Node.js 20+.
- A DeepSeek API key, or another configured provider.
- Chrome if you want browser automation through ForgeWebridge.
- Android Studio/JDK 17 only if you build the Android app locally.

```sh
npm install
npm run install:local
```

`install:local` builds the Web Console and installs the local gateway service. Then open:

```text
http://127.0.0.1:3000
```

DeepSeek's default API base URL is:

```text
https://api.deepseek.com
```

## Quick Start

1. Open the local Web Console.
2. Configure DeepSeek from setup.
3. Create or select a workspace folder.
4. Start a session and ask DeepSeek-Forge to inspect, edit, test, or automate something in that workspace.
5. Add Chrome, MCP servers, skills, or mobile pairing only when the workflow needs them.

Some internal commands and compatibility identifiers still use `forgeagent`, including the CLI script, URL scheme, package directories, LaunchAgent label, and device tokens. This keeps existing local installs, Android pairing, and Chrome bridge discovery working during the rename.

## macOS App

Build and package the desktop shell:

```sh
npm run macos:package
open apps/macos/ForgeAgentMac/dist/DeepSeek-Forge.app
```

The packaged app:

- starts or reuses the local Core service;
- installs `com.forgeagent.gateway` as a LaunchAgent;
- stores data in `~/Library/Application Support/ForgeAgent/data`;
- uses `ForgeAgentPowerHelper` to keep Core online while the display sleeps;
- renders the same Web Console inside WKWebView.

## Mobile

DeepSeek-Forge is local-first. Your phone connects to the Mac running Core.

Recommended remote access:

1. Install Tailscale on the Mac and phone.
2. Sign in to the same tailnet.
3. Open **Pair Mobile** in the Web Console or macOS app.
4. Scan the QR code from Android, or open the link from iPhone/iPad Safari.

Android debug builds are written to:

```text
apps/android/ForgeAgentAndroid/app/build/outputs/apk/debug/app-debug.apk
```

## Chrome

ForgeWebridge connects DeepSeek-Forge to your existing visible Chrome profile. It lets the agent operate logged-in pages you can see, while avoiding cookie/password extraction and stealth automation.

```sh
npm run webridge:package
npm run webridge:open
```

The extension auto-discovers the local gateway, pairs through a short-lived code, keeps a heartbeat, and returns readable offline errors to the agent when Chrome is not connected.

## MCP And Skills

DeepSeek-Forge is an MCP client and a local extension host. MCP tools and skill commands run through the same permission broker, sandbox, artifact store, and thread model as built-in tools.

Useful commands:

```sh
npm run mcp -- list
npm run mcp -- add
npm run extensions -- list
npm run skills -- install-github
```

GitHub skill installs preserve the full package when a skill directory includes `references/`, `scripts/`, `templates/`, `assets/`, or `tests/`.

## Release Builds

Run the release gate before sharing beta artifacts:

```sh
npm run release:gate
npm run release:bundle
```

The bundle step writes artifacts under:

```text
.forge-release/dist/
```

Expected public beta artifacts include:

- `DeepSeek-Forge-<version>-macos-arm64.zip`
- `DeepSeek-Forge-<version>-android-debug.apk`
- `ForgeWebridge-<version>.zip`
- `release-manifest.json`
- `SHA256SUMS`

See [docs/release-checklist.md](docs/release-checklist.md) before publishing.

## Safety Model

DeepSeek-Forge is intended for one user and their personal devices.

- Do not expose the local gateway directly to the public internet.
- Prefer Tailscale, ZeroTier, a trusted private network, or a carefully configured HTTPS reverse proxy for remote access.
- Browser automation does not bypass login, CAPTCHA, payment, risk, or consent prompts.
- Destructive commands, package installs, external runtimes, and permission-sensitive tools remain explicit permission boundaries.
- Provider keys and local data stay on the machine unless a configured tool or provider call sends them out.

## Documentation

- [Native apps](docs/native-apps.md)
- [Release checklist](docs/release-checklist.md)
- [Blender MCP quick start](docs/blender-mcp-quickstart.md)
- [Architecture spec](docs/forge_agent_v_2_architecture_spec.md)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=lazyhuman-ai/forge-agent&type=Date)](https://www.star-history.com/#lazyhuman-ai/forge-agent&Date)

## Contributors

Thanks to everyone who has contributed to DeepSeek-Forge.

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/leileqiTHU">
        <img src="https://github.com/leileqiTHU.png?size=96" width="72" height="72" alt="雷乐其" />
        <br />
        <sub><b>雷乐其 (@leileqiTHU)</b></sub>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/putshua">
        <img src="https://github.com/putshua.png?size=96" width="72" height="72" alt="putshua" />
        <br />
        <sub><b>putshua (@putshua)</b></sub>
      </a>
    </td>
  </tr>
</table>

<a href="https://github.com/lazyhuman-ai/forge-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=lazyhuman-ai/forge-agent" alt="Contributors" />
</a>

## License

DeepSeek-Forge is released under the [MIT License](LICENSE). Forks, modifications, private use, and commercial use are welcome under the license terms.
