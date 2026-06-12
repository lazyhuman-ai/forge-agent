# DeepSeek-Forge

<p align="center">
  <img src="assets/forge_zh.png" alt="DeepSeek-Forge 面向 DeepSeek 深度适配的本地 Agent 工作台" width="100%" />
</p>

<p align="center">
  <strong>面向 DeepSeek 深度适配的本地优先 Agent 工作台，覆盖 Mac、Chrome、Android、MCP、浏览器自动化和真实项目工作流。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

> [!IMPORTANT]
> DeepSeek-Forge 是独立开源项目，不是 DeepSeek 官方产品，也不代表与 DeepSeek 存在官方隶属关系。这个名字表达的是产品对 DeepSeek 路径、telemetry 和长上下文工作流的优先适配。

DeepSeek-Forge 在你的 Mac 上运行一个私有 Agent Core，并提供真实工作区：项目文件、命令工具、浏览器、MCP servers、长期记忆、扩展 skills、移动端访问，以及一条可持久化的会话和活动流。它的目标是一个本地 Agent 产品，而不是一个托管 SaaS 页面。

运行时不是把 DeepSeek 当成普通 OpenAI-compatible endpoint。只要 DeepSeek 返回 usage、context、prefix cache、reasoning token 等 telemetry，DeepSeek-Forge 就会记录这些事实，并用它们驱动 compaction、成本可见性和长会话调试。

## 为什么是 DeepSeek-Forge

- **DeepSeek-native 默认路径。** token usage、context usage、cache hit/miss、reasoning token 和 cache-shape 诊断都是一等产品数据。
- **本地优先工作区。** Core、Web Console、macOS App、Android App、Chrome 扩展、MCP 工具、权限、artifact 和 session history 共享同一个本地事实源。
- **不只是 coding CLI。** 代码能力是高密度 workspace adapter，和文档、浏览器任务、MCP/Blender、研究、报告生成、自动化共享同一套模型。
- **私有多端访问。** Android 或 iPhone/iPad Safari 连接的是运行 Core 的 Mac；远程访问默认走私有网络，推荐 Tailscale。
- **扩展和 MCP 就绪。** 本地 skills、GitHub skill packages 和 MCP servers 都进入同一套权限和 artifact 模型。
- **Beta 级恢复能力。** 工具失败、沙盒拒绝、浏览器桥离线、provider telemetry 缺失、blocked session 都会呈现为可读状态，而不是静默卡住。

## 功能

- DeepSeek provider 设置，支持本地 masked key 存储。
- Usage ledger 记录 token、context、reasoning、prefix cache 和成本事件。
- Context compaction 展示压缩前后 telemetry。
- 本地 Web Console 覆盖 sessions、files、tasks、artifacts、usage、MCP、skills、memory、browser status 和 mobile pairing。
- macOS App 通过 LaunchAgent 启动或复用 Core，并保持本地服务在线。
- Android 配对 WebView client，支持 QR 配对、连接恢复和活动通知。
- ForgeWebridge Chrome 扩展连接当前可见且已登录的 Chrome profile，不读取 cookie 或密码。
- MCP registry 和 extension installer 支持带 references、scripts、templates、assets、tests 的完整 skill package。
- Coding workspace 支持 LSP 导航、结构化 workspace activity、worktree/subagent flows 和 release E2E gates。

## 安装

环境要求：

- macOS，用于本地桌面 Core 和打包 App。
- Node.js 20+。
- DeepSeek API key，或其他已配置 provider。
- 如果需要浏览器自动化，需要 Chrome。
- 只有本地构建 Android App 时才需要 Android Studio/JDK 17。

```sh
npm install
npm run install:local
```

`install:local` 会构建 Web Console 并安装本地 gateway service。然后打开：

```text
http://127.0.0.1:3000
```

DeepSeek 默认 API Base URL：

```text
https://api.deepseek.com
```

## 快速开始

1. 打开本地 Web Console。
2. 在 setup 中配置 DeepSeek。
3. 创建或选择 workspace folder。
4. 创建 session，让 DeepSeek-Forge 去检查、编辑、测试或自动化当前工作区里的任务。
5. 只有当工作流需要时，再添加 Chrome、MCP servers、skills 或移动端配对。

为了保持兼容，部分内部命令和标识仍保留 `forgeagent`，包括 CLI script、URL scheme、package 目录、LaunchAgent label 和 device token。这样已有本地安装、Android 配对和 Chrome bridge discovery 不会因为改名失联。

## macOS App

构建并打包桌面壳：

```sh
npm run macos:package
open apps/macos/ForgeAgentMac/dist/DeepSeek-Forge.app
```

打包后的 App 会：

- 启动或复用本地 Core service；
- 安装 `com.forgeagent.gateway` LaunchAgent；
- 使用 `~/Library/Application Support/ForgeAgent/data` 存储数据；
- 使用 `ForgeAgentPowerHelper` 在屏幕休眠时保持 Core 在线；
- 在 WKWebView 中渲染同一套 Web Console。

## 移动端

DeepSeek-Forge 是 local-first：手机连接的是正在运行 Core 的那台 Mac。

推荐远程访问方式：

1. 在 Mac 和手机上安装 Tailscale。
2. 登录同一个 tailnet。
3. 在 Web Console 或 macOS App 中打开 **Pair Mobile**。
4. Android 扫描 QR code；iPhone/iPad Safari 打开配对链接。

Android debug build 输出到：

```text
apps/android/ForgeAgentAndroid/app/build/outputs/apk/debug/app-debug.apk
```

## Chrome

ForgeWebridge 会把 DeepSeek-Forge 连接到你当前可见的 Chrome profile。Agent 可以操作你看得到的已登录页面，但不会读取 cookie/password，也不会做隐身式风控规避。

```sh
npm run webridge:package
npm run webridge:open
```

扩展会自动发现本地 gateway，通过短期 pairing code 配对，保持 heartbeat，并在 Chrome 未连接时把可读离线错误返回给 Agent。

## MCP 与 Skills

DeepSeek-Forge 是 MCP client，也是本地 extension host。MCP tools 和 skill commands 会进入同一套 permission broker、sandbox、artifact store 和 thread model。

常用命令：

```sh
npm run mcp -- list
npm run mcp -- add
npm run extensions -- list
npm run skills -- install-github
```

GitHub skill 安装会保留完整 package。如果 skill 目录中包含 `references/`、`scripts/`、`templates/`、`assets/` 或 `tests/`，会一起安装。

## 发布构建

分享 beta artifact 前先跑 release gate：

```sh
npm run release:gate
npm run release:bundle
```

bundle 输出目录：

```text
.forge-release/dist/
```

预期 beta artifacts：

- `DeepSeek-Forge-<version>-macos-arm64.zip`
- `DeepSeek-Forge-<version>-android-debug.apk`
- `ForgeWebridge-<version>.zip`
- `release-manifest.json`
- `SHA256SUMS`

发布前请阅读 [docs/release-checklist.md](docs/release-checklist.md)。

## 安全模型

DeepSeek-Forge 面向单用户和个人设备。

- 不要把本地 gateway 直接暴露到公网。
- 远程访问推荐 Tailscale、ZeroTier、可信私网，或谨慎配置的 HTTPS reverse proxy。
- 浏览器自动化不会绕过登录、验证码、付款、风控或确认操作。
- destructive commands、package installs、external runtimes 和权限敏感工具仍然是显式权限边界。
- Provider keys 和本地数据默认留在本机，除非你配置的工具或 provider call 需要发送出去。

## 文档

- [Native apps](docs/native-apps.md)
- [Release checklist](docs/release-checklist.md)
- [Blender MCP quick start](docs/blender-mcp-quickstart.md)
- [Architecture spec](docs/forge_agent_v_2_architecture_spec.md)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=lazyhuman-ai/forge-agent&type=Date)](https://www.star-history.com/#lazyhuman-ai/forge-agent&Date)

## Contributors

感谢所有参与 DeepSeek-Forge 的贡献者。

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

DeepSeek-Forge 使用 [MIT License](LICENSE) 发布。你可以按许可证条款 fork、修改、私有使用或商业使用。
