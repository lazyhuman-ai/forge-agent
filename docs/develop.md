# ForgeAgent 开发指导

本文是开发方式和架构取舍的指导文件。当前实现基准以 `docs/forge_agent_v_2_architecture_spec.md` 和代码为准；归档调研与问答只保留历史讨论，不作为实现依据。

Native 客户端入口记录在 `docs/native-apps.md`。macOS App 是本机 Forge Core 的桌面本体壳：启动/复用 LaunchAgent，并用 WKWebView 承载同一套 Web Console。Android App 是配对后的 WebView 远程设备，支持扫码配对和前台通知连接监控，不复制 Web Console 的消息、权限、MCP、memory、skills 或 browser runtime UI。

适合自上而下和面向对象，但要小心两个误区。

## 1. 自上而下适合这个项目

这个项目更像一个 **小型操作系统内核 / agent runtime**，不是普通功能型 app。

它的核心问题是：

```txt
session
runtime
scheduler
gateway
tool
thread
notification
trigger
resource
```

这些概念之间如果一开始没有顶层边界，后面靠 MVP 堆功能会很快失控。

所以我认为：

> **自上而下非常适合。**

但这里的自上而下不是先写一大堆抽象接口，而是先固定：

```txt
核心对象
生命周期
状态流转
事件流
模块边界
不可破坏的 invariant
```

然后再实现。

---

## 2. 面向对象适合，但不要“重 OO”

适合用对象建模，因为这个系统天然有稳定实体：

```txt
Core
Session
Thread
Runtime
Gateway
Scheduler
Trigger
Tool
Artifact
Skill
Memory
```

它们有身份、有生命周期、有行为。

但不建议做传统重 OO：

```txt
深继承
复杂抽象基类
大量 manager 套 manager
过早设计 plugin superclass
```

更适合的是：

> **对象建模 + 组合式实现 + 事件驱动。**

这里不是禁止边界明确的 `RuntimeManager` / `MemoryManager` 这类基础设施协调者，而是反对没有事实源、没有事件边界的 service manager 堆叠。

比如：

```ts
class Session {
  id
  status
  append(event)
  interrupt()
  archive()
}

class Core {
  route(input)
  schedule(trigger)
  supervise(session)
}

class RuntimeManager {
  ensureBrowser()
  attachTab(session)
  recover()
}
```

但对象之间通过事件交互，而不是互相深度调用。

---

## 3. 自动机非常适合引入

尤其适合三个地方。

### A. Session 状态机

这是最应该引入自动机的地方。

状态包括（6 个生命状态 + 1 个终态）：

```txt
idle          — 就绪等待
running       — 已排队或正在执行 turn
waiting_user  — 等待用户回复（turn 中途）
sleeping      — 主动休眠，有定时 trigger
blocked       — 框架级阻塞断路器
archived      — 终态
```

`turn_finished` 是一次 turn 的结果事件，不是 Session 状态。普通工具错误应作为 `tool_result` 回流给 Agent；只有 Core / Provider / Runtime / 协议级无法继续的问题进入 `blocked`。如果 `running` session 因缺少 ModelProvider/ToolExecutor 无法 dispatch，Core 会写入可读 `runtime_event` 并进入 `blocked`。上下文 compaction 使用当前主 `ModelProvider` 生成结构化 handoff summary；compaction 失败不做启发式 fallback，会作为框架级阻塞写入 `runtime_event` 并进入 `blocked`。

DeepSeek 是当前默认 provider 路径。DeepSeekProvider 必须请求并解析真实 usage telemetry：`input/output/total`、prefix cache hit/miss、reasoning tokens。Core 将每次模型调用写入 `.forge/usage/<sessionId>.jsonl`，同时追加可读 `usage_event` 到 thread，供 REPL/HTTP/多端 UI 展示 context used%、cache hit rate 和 cost。DeepSeek compaction 触发必须使用真实 `rawUsage.input_tokens / contextWindowTokens`；DeepSeek usage 缺失是 provider telemetry failure，进入 `blocked`，不能静默回退估算。估算 token 只允许给非 DeepSeek/usage 缺失的兼容 provider，并且必须标记 `estimated=true`。

工具权限和 workspace sandbox 是统一执行边界：`ToolDefinition.capabilities` 声明工具能力，ToolRuntime 在 handler 前经由 `ToolPolicyManager / PermissionBroker` 执行 allow / ask / deny。ask 会写入 durable `permission_request` 并通过 HTTP/SSE 交给已配对设备审批；不新增 `waiting_permission` 状态，等待审批仍属于 `running` turn。denied / timeout / noninteractive / sandbox block 都作为 `tool_result isError=true` 回流给 Agent，错误文本必须包含 tool、requested action、reason 和 recovery，不进入 `blocked`。permission events 是 audit/UI 事件，模型恢复主要依赖合法相邻的 `tool_result`，避免破坏 provider tool_call/tool_result 顺序。

文件工具统一经过 `PathSandbox`：默认 allowed roots 是项目根和 `.forge/workspaces/session_<id>` scratch，并用 realpath/deepest-existing-ancestor 防止 `..`、symlink、未存在父目录逃逸。bash cwd 保持项目根；启用 tool policy 的 Core 在 macOS 使用 Seatbelt/sandbox-exec 约束 bash 写入 roots，enforce 模式下 sandbox 不可用则返回可读工具错误。

工具大输出由 AgentLoop 自动落盘到 Artifact Store：默认单结果超过 50k chars 或同批 tool results 超过 200k chars 时，thread 中保留合法 `tool_result` 预览并追加 `artifact_pointer`。Agent 需要完整文本时使用 `read_artifact` 读取同 session artifact；Artifact 写入失败属于框架级 failure，会写入可读事件并进入 `blocked`。

Browser tools 已进入正式 built-in 工具层：Agent 可用 `browser_create_tab`、`browser_navigate`、`browser_current_page`、`browser_wait_for_selector`、`browser_type_text`、`browser_press_key`、`browser_click`、`browser_scroll`、`browser_extract`、`browser_extract_links`、`browser_screenshot` 完成真实网页阅读和少量交互。默认 browser runtime 是 ForgeWebridge：未显式传 `runtime` 时，browser tools 请求 `webridge`（或 `FORGE_WEBRIDGE_RUNTIME_NAME` 指定的名字），由 Chrome 扩展通过 device token 连接 HTTP Gateway 的 `/webridge/*` 端点，把用户当前 Chrome profile 的可见登录态页面暴露给 Agent。ForgeWebridge 面向普通用户的默认路径是“安装本机 ForgeAgent 服务、加载/刷新扩展、必要时点 Refresh connection”：`npm run install:local` 会安装 macOS LaunchAgent、启动 gateway、打包扩展并输出后续步骤；扩展先通过免认证 `/discovery` 自动发现本机 ForgeAgent，再从 loopback localhost 调用 `/auth/pairing-codes` 和 `/auth/pair` 获取 token；手动 pairing code 只作为 Advanced fallback。扩展会自动 re-pair、re-register、发送 `/webridge/heartbeat` 并 long-poll `/webridge/commands`；Core 端通过 `/webridge/status` 暴露 `online / stale / offline` 健康状态，健康变化写入 system stream。browser tools 执行前会做 readiness 判断：离线时快速返回可读 `tool_result isError=true`，说明上次看到扩展的时间和恢复方式，而不是等待不透明超时。扩展 popup 提供 `Copy diagnostics`，用于复制不含 device token 的诊断 JSON；CLI 提供 `npm run doctor`、`npm run logs`、`npm run webridge:package` 和 `npm run webridge:open`。CDP 入口不会默认接管用户 Chrome；只有设置 `FORGE_BROWSER_CDP_URL` 时，REPL/HTTP main 才注册名为 `chrome` 的 BrowserRuntime（可用 `FORGE_BROWSER_RUNTIME_NAME` 改名），Agent 需要显式传 `{"runtime":"chrome"}` 才会使用。缺 runtime、未安装/未刷新/未配对 ForgeWebridge 扩展、未建 tab、selector 不存在、CDP/extension exception、非 http(s) URL 都作为可读 `tool_result isError=true` 回流给 Agent。登录、验证码、风险确认应由 Agent 通过 `ask_user` 请求用户处理，不做 cloaking 或风控规避。

MCP 已作为本地产品级 client runtime 接入：`McpRuntimeManager` 管理 `.forge/mcp/servers.json`、`events.jsonl`、`oauth/`、`cache/` 和 catalog cache，支持 stdio / streamable-http / legacy SSE server。MCP tool 会投影成 Forge `ToolDefinition`，命名 `mcp__<server>__<tool>`，执行仍走 `ToolRuntime -> PermissionBroker -> Artifact -> Thread`；MCP resources/prompts 通过 utility tools 读取，不直接注入 system prompt。项目 `.mcp.json` 默认只发现为 disabled/untrusted，用户 enable 后才导入本机配置。OAuth needs_auth、断连、timeout、JSON-RPC error 和 MCP tool `isError:true` 默认都是 Agent 可读 `tool_result isError=true` 或 `runtime_event(runtimeKind="mcp")`，普通 MCP 失败不 blocked session。MCP sampling 支持但默认关闭，启用时必须经 `mcp.sampling` 权限；elicitation 通过 durable `mcp_elicitation_request/response` 接入 Web/HTTP。管理入口包括 `npm run mcp -- list/add/remove/status/connect/retry/auth/install/doctor/import`、HTTP `/mcp/*` endpoints 和 Web Console 右侧 MCP rail。

Extensions 是 skills / MCP servers / bundles 的统一 local-first 管理层，不是第二套权限系统。`ExtensionRegistryStore` 管理 `.forge/extensions/sources.json`、`registry-cache/`、`lock.json`、`events.jsonl`；事实源是本机 registry snapshot、用户添加的静态 registry source、skill package、MCP config 和 lock/audit。ForgeAgent 内置 registry snapshot 只使用真实来源：上游官方 MCP npm 包可标为 `official`，Forge 精选第三方 skills/bundles 标为 `curated` 或 `community`，不能冒充上游官方。GitHub skill 链接必须按 `SKILL.md` 所在目录安装完整 package（`references/ scripts/ templates/ assets/ tests/ examples`），禁止 raw-only 降级。需要 env/auth 的 MCP catalog entry 安装为 disabled/setupRequired；配置缺失时 runtime 返回可读错误，不进入 blocked。管理入口包括 Web Console Extensions 页面（Recommended / All / Installed / Needs Review / Sources / Events）、HTTP `/extensions/*` endpoints、CLI `npm run extensions -- search/install-bundle/add-source/refresh-source/doctor`，以及 Agent-facing `extension_search / extension_install / extension_enable`。安装 safe/curated skill 默认允许；MCP 进程启动、外网、高风险能力、采样和写入型工具仍走 ToolPolicy/Danger Free/session allow。

长期记忆采用 markdown-first 结构：`.forge/memory/MEMORY.md` 是短 manifest，`topics/<type>/<id>.md` 保存 active memory 正文，`proposals/*.json` 是后台内部 staging，`index.json` 可重建。新 session 不再被动注入同 session 全量记忆；system prompt 只包含 memory 使用规则、active `instruction` memory 和短 manifest。Agent 需要历史事实时主动调用 `memory_search`，再用 `memory_get` 精读。

MemoryManager 是后台维护者：turn 正常完成或进入 `waiting_user` 后，可用当前主 `ModelProvider`、禁用 tools，从本轮 thread 事件提取 proposals；pending proposals 达阈值、startup rehydrate 或显式 `runMemoryMaintenance()` 时 consolidation 到 active markdown memory。后台 extractor/consolidator 失败不做启发式 fallback，也不阻塞前台 session；Core 写入可读 `runtime_event(runtimeKind="memory", detail="degraded")` 和 system event，并按 backoff 重试。显式 memory 工具失败仍作为工具结果交给 Agent。

已移除 `paused`：用 `user_interrupt`（任意状态→idle）替代暂停/恢复；对 queued/active turn 会 abort/dequeue。若中断发生时已有未完成 tool call，Core 会补写 `isError: true` 的中断 `tool_result`，避免悬空 tool call 进入下一轮上下文。

进程重启后使用 thread-first semantic recovery：`loadSessions()` 只恢复 durable meta/thread，随后 `rehydrateAfterStartup()` 修复启动时仍为 `running` 的 session。Core 不持久化 supervisor queue，也不尝试恢复旧进程中已经死亡的 Promise；历史 `running` meta 表示旧进程中断的未完成 turn。启动时这些 session 会被写入可读 restart `runtime_event` 并转为 `blocked`，等待用户显式 retry，不自动重新排队抢占当前用户输入。若 thread 中存在未匹配的 `tool_call`，Core 会先补写 `isError: true` 的 `tool_result`，文本为 `Process restarted before this tool completed.`，保证下一次 retry 的 provider 上下文合法。

HTTP Gateway 已升级为单用户、多设备 Remote Gateway：默认监听 `127.0.0.1`，业务 API 和 SSE 默认需要可撤销的 device token；新设备通过 5 分钟、一次性 pairing code 配对。面向用户的默认入口是 `npm run install:local`：它先构建本地 Web Console，再安装 `com.forgeagent.gateway` LaunchAgent，使 gateway 登录自启、崩溃自动拉起，并写日志到 `.forge/run/forgeagent.log`。开发调试仍可用 `npm run forgeagent -- start/status/stop/restart` 管理一次性后台进程，服务进程把 PID、URL、日志路径写入 `.forge/run/gateway.json`；`npm run http` 保留为底层前台入口。`GET /health` 和 `GET /discovery` 免认证，用于 CLI、Chrome 扩展和本机诊断；业务 API 仍需要 device token。多端 UI 状态写入 `.forge/device-state/<deviceId>.json`，只保存 selected session、read cursor、mute 等 gateway 状态，不作为 session/agent 事实源。移动端断线恢复时使用 `/events?cursor=...`、`/sessions/:id/thread?afterSeq=...` 和 `/system-events?afterSeq=...` 补漏。

本地 Web Console 是当前 Beta 产品壳，不改变 Core 事实源：UI 只消费 HTTP/SSE/thread/system stream，权限审批也写回 durable `permission_request/permission_response`。Web Console 通过 loopback pairing 自动获取 web device token；浏览器 EventSource 通过 `/auth/stream-token` 建连。首次模型配置通过 `/setup/provider` 保存 DeepSeek `apiKey/baseUrl/model/contextWindowTokens` 到 `.forge/config/provider.json`，文件权限尽量收紧到 owner-only；所有 status/diagnostics 只返回 masked key。`.env` 仍是兼容入口，但普通用户路径是打开 Web Console 后完成配置。Gateway 同源服务 `web/dist`，API route 优先；无 UI build 时 `/` 返回可读提示，不影响 JSON API。

事件包括：

```txt
user_message      — 用户发消息
user_reply        — 用户回复 (waiting_user→running)
usage_event       — provider usage/cache/context/cost telemetry
turn_finished     — turn 正常完成 (→idle)
agent_ask_user    — Agent 提问 (→waiting_user)
agent_schedule_sleep — 有 trigger 的 turn 完成 (→sleeping)
trigger_fired     — 定时触发 (→running)
trigger_scheduled — idle session 新增 enabled trigger (→sleeping)
triggers_empty    — 最后一个 enabled trigger 被取消/删除 (sleeping→idle)
runtime_failure   — 故障 (→blocked)
runtime_recovered — 自动恢复 (→running)
user_interrupt    — 用户打断 (→idle)
user_retry        — 用户重试 (blocked→running)
user_archive      — 归档 (→archived)
```

设计原则：
- **每个状态都有明确的进入条件和退出路径**——不存在孤立状态
- **每条转移都有代码触发**——不存在"预留将来用"的转移
- **sleeping 是自动分流**——turn 完成后根据 enabled trigger 自动决定；idle 新增 enabled trigger 也会立即进入 sleeping

---

### B. Runtime 状态机

比如 Browser Runtime：

```txt
offline
starting
online
degraded
recovering
failed
```

事件：

```txt
start
connected
disconnect
healthcheck_failed
recover_success
recover_failed
```

这很适合 Core 做常驻维护。Runtime attachment 是 durable thread fact：Browser tab attach/detach/re-attach 会写入 `runtime_event(attached/detached/reattached)`，不改变 session 生命周期。BrowserRuntime/CDP 断线后默认按 1s 起步、30s 封顶、10 分钟 give-up 自动 reconnect；恢复成功会重新 attach target，并通过 RuntimeManager 的恢复回调重新调度受影响 session。

Runtime rehydration 不解析人类文本。`runtime_event` 保留 readable `message` 给人和 Agent，同时携带最小 `payload` 来恢复 attachment snapshot 和 runtime-blocked ownership。重启后 RuntimeManager 会重建 attachment、恢复 runtime-caused blocked sessions；非 runtime 原因的 blocked 不会被自动恢复。

---

### C. Scheduler / Trigger 状态机

Trigger 也可以有状态：

```txt
enabled
fired
queued
delivered
coalesced
disabled
```

尤其是长期任务、定时任务、事件密集合并，都需要清晰状态。

---

## 4. 但 Agent 本身不要设计成强状态机

要避免把模型行为也塞进自动机。

也就是说，不要设计：

```txt
planning
browsing
extracting
writing
verifying
done
```

这种业务状态机。

这会违背你们的原则。
Agent 的任务策略应该来自：

```txt
thread context
model reasoning
skill
tool result
```

而不是 runtime 固定的业务流程。

这里的 `skill` 也不是隐藏执行通道。当前实现是：

```txt
SkillStore -> short manifest in system prompt -> Agent read_file(SKILL.md/reference) -> skill_used event
```

- `skill.json + SKILL.md` 是 canonical package；legacy `<name>/SKILL.md` 只做无损兼容索引。
- 系统提示只注入短 manifest，不注入 skill 正文；不提供 model-facing `skill_load` / `skill_list` / `skill_search` 工具。
- skill scripts 只是普通文件，必须由 Agent 显式通过工具运行，并继续经过 ToolPolicyManager 和 PathSandbox。
- 远端 registry skill 逐文件下载、sha256 校验、签名校验；GitHub skill 链接以 `SKILL.md` 所在目录为 package root，安装整个目录（`references/`、`scripts/`、`templates/`、`assets/` 等），优先 per-file tree 下载，遇到 GitHub API rate limit 时 fallback 到 codeload tarball 后只取 package 目录并扫描；unsafe/unsigned/caution package 进入 quarantine，不出现在 prompt。
- `SkillEvolutionManager` 可以从 thread 后台生成 proposal，经 static scan、no-tools judge 和 eval 后自动启用 generated overlay；失败只写 skill degraded/backoff 事件，不阻塞前台 session。

所以自动机的边界是：

```txt
Core / Session runtime / Runtime health / Scheduler
```

不是：

```txt
具体任务执行逻辑
```

---

## 5. 最适合的总体范式

我建议是：

> **Top-down domain modeling + object-oriented core entities + append-only event streams + explicit finite state machines for infrastructure lifecycle.**

换句话说：

```txt
用对象表达领域实体
用事件表达事实
用状态机约束基础设施生命周期
用线性 thread 保持 agent 上下文
用模型处理任务语义
```

---

## 6. 不建议的开发方式

不建议：

```txt
MVP 一路堆功能
先写 WebUI 再补 Core
先写工具再补 session
先写 memory 再补 thread
把所有东西做成 service manager
把 agent 任务过程做成状态机
```

这些都会重新走旧版本的问题。

---

## 7. 推荐开发顺序

虽然不是 MVP 乱迭代，但可以按架构层自上而下实现。当前代码已越过早期骨架阶段，后续新增能力仍应按这个依赖顺序接入：

```txt
1. 定义领域对象和事件类型
2. 定义 Session 状态机
3. 定义 Core API
4. 实现 Session Thread Store
5. 实现 Session Supervisor
6. 实现 Agent Loop
7. 实现 Tool Registry / Runtime
8. 实现 Artifact Store 与 LLM Compaction
9. 实现 Runtime Manager、attachment 事件和重启 rehydration
10. 实现 Scheduler / Trigger
11. 实现 markdown 长期 Memory Store / MemoryManager
12. 实现 Remote Gateway / device auth / multi-device sync
```

也就是：

```txt
先骨架，再器官
不要先做某个功能 demo
```

---

结论：

> **适合自上而下，适合轻量面向对象，适合引入自动机。**
>
> 但自动机只用于 Core、Session、Runtime、Scheduler 这些基础设施生命周期；不要用于 agent 的业务执行策略。
