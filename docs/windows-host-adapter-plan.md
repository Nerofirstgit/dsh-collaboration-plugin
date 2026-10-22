# Windows 正常界面的协作插件适配计划

> Historical incremental checkpoint. Later implemented resource identity, GUI production wiring and exact remaining gates are described in [gui-candidate.md](gui-candidate.md). Earlier “not implemented” statements below describe that frozen step, not the latest source.

本文件是下一步补丁计划，不是 Windows、Desktop 或 Web 已可用的声明。当前实现只审计了 headless 组合。替换 Linux 文件操作和 IPC 后，还必须完成这里的宿主接入。不要把现有包安装到真实工作的 Desktop profile 来试错。

## 范围和依据

- dsh 指 DeepSeek Harness。目标是 Windows 原生运行，不能用 WSL 测试替代。
- 用户已将范围收窄为启用插件的 dsh 会话之间协作。其他程序的文件修改只做尽力检测，不保证阻止。旧文档要求抵抗任意同用户进程修改的部分不再适用。
- dsh 自己执行的 shell、MCP、子代理、后台任务和插件工具仍是参与者，必须经过管理写入或明确拒绝。不能将它们称为“其他程序”而绕过版本、互斥和恢复协议。
- 关闭插件后不保证协作和写保护。启用期间的会话身份、写入串行化、旧实例拒绝、消息持久化和崩溃恢复仍然要求保留。
- 以下事实基于宿主源码 `687f282e8625c6b8d11ff58211a90524be2e4317`、npm `@deepseek-ai/dsh@0.2.1-rc.2` 及同版本 Web bundle。依赖升级要重新检查。仓库中的 `upstream/` 是本次审计材料，不是分发包的一部分。

## 已确认的接入冲突

| 位置 | 事实 | 必须改什么 |
| --- | --- | --- |
| `src/host/profile.ts` | 只接受 20 个固定 root entry，必需 `headless-startup`、`headless-runner`，拒绝所有 scoped entry | 新增独立的已审计 GUI 组合。保留原 headless 检查，不把白名单改成通配 |
| `cordis.patch.yml` | 禁用 `typert-gateway`、`remote-access`、`settings`、`storage*`、`approval` | 另写 GUI overlay，保留正常会话、设置、附件、审批及存储依赖。不能复用这份 headless 禁用清单 |
| 官方 `dsh-web-app/cordis.patch.yml` 与 `presets/*.patch.yml` | Web 加入 session-controller、workspace-controller、Web server、connection、modules，以及四种 per-session preset | 必须同时审计 root host service 和 preset 里的实际代码，不只检查 root 列表 |
| 官方 `presets/standard.patch.yml` | `tool-fs`、PowerShell、Bash 在 preset 内重新注册，且有 planning、compaction、delegation scoped group | root `tool-fs` 禁用并不等于没有写工具。需要专门的协作 preset；不能直接使用 standard |
| 官方 `presets/minimal.patch.yml` | 仍包含 terminal 和 persistent PowerShell/Bash | minimal 也不是安全替代品 |
| `src/plugin.ts` | Agent 创建时只允许插件自己持有的工具定义；执行前再次核对定义对象 | 新增 GUI 行不等于内置工具可用。保留最终定义核对，按明确审计结果扩展非写工具；原始 shell/MCP 不能按名字放行 |
| `src/plugin.ts`、`src/host/persistence.ts:create` | 旧实现将进程 cwd 作为所有会话的 root；本地 `32bde094` 已修正逐会话 cwd 路径 | 仍需真实 GUI 创建/恢复验收，不能用 Desktop 后端 profile 目录代替工作区 |
| `src/host/filesystem.ts` | 全局 FS provider 拒绝 writeText/editText | 区分模型项目写入与宿主自身状态存储。逐项确认 GUI 所用 provider，不能通过恢复全局原始 FS 解决界面报错 |

`tests/host/gui-topology.test.ts` 从实际安装的 npm 包解析 YAML，验证前述 bundle/preset 结构，并确认当前检查器仍拒绝未适配的 GUI 和 scoped entry。它不加载 GUI 或执行任何 `!!js` 表达式。

## 宿主已有的可复用接口

官方 Desktop 与 Web 共用后端，不是两份独立会话实现。

- [Desktop project-manager](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/src/project-manager.ts) 使用 `WEB_PROFILE.bundles` 初始化 profile。
- [Desktop host](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop-host/src/index.ts) 调用 `runProfile`，profile 名为 `desktop`，启动完成后向 Electron 发送 `ready`。外壳通过 [host-process.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/src/host-process.ts) 拉起 Node 模式后端。因此还要在实际 Electron 所带运行时验证 SQLite/依赖，不能仅以独立 Node 测试代替。
- [session-controller/agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/agent.ts) 的 `createSession` 支持空会话复用，`resumeObserved` 调用 `ctx.agents.resume`，`createAgent` 将 cwd、agentPreset 写入元数据。现有 SessionPersistence provider 和 agent lifecycle hooks 可以接住这些调用。
- `createAgent` 在创建 Agent 之前直接 `mkdir(cwd, {recursive:true})`。这是明确的人类工作区选择/创建流程，不是模型任意文件写入接口。应记录并测试这一分类，禁止模型借 UI API 任意创建/改写项目内容。
- [Web index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/web-app/src/index.ts) 等待 Loader settlement 和 `auditStartupEntries` 后才发布 URL。仅延迟 URL 不会阻止已挂载 API 的调用。

`DSH_HOME` 默认是用户主目录下 `.dsh`，不是必然 `%APPDATA%`。Desktop 的 Electron userData 又是另一项配置。会话工作区、dsh profile、协作数据目录、Electron 配置目录必须分别处理，不能相互推断。

## 下一补丁的顺序

### 1. 先建立可验证的 GUI 组合

新增 GUI 专用 overlay 和组合描述，不修改现有 headless overlay 的含义。按固定版本核对 root rows、resolved package、inject 列表、preset 配置和服务覆盖。正常会话列表、创建、恢复、工作区选择、附件、审批、用户设置所需的代码逐项保留。

为协作模式增加专门 preset。它使用管理读写工具，保留经审计的提示词、压缩等能力。不要复制 standard 后仅关闭 root shell；所有嵌套 group 都要检查。preset 编辑、动态安装插件、terminal-controller、后台 jobs 和 MCP 在接入管理路径前明确不可用，界面提示原因，不能只在模型提示词中禁止。

GUI API 分三类处理：

| 类别 | 处理 |
| --- | --- |
| 会话/设置/附件等宿主状态 | 允许原有可靠存储，但路径必须属于已审计宿主状态目录；不得把项目路径当状态路径传入 |
| 模型或后台执行引起的项目内容变化 | 通过同一个协调器写入；尚未适配的入口拒绝 |
| 人类直接操作界面的工作区创建、文件打开、终端等 | 逐 API 分类。明确的人类目录创建可保留；通用终端不能假定只供人类使用，也不能保留模型可访问的绕行入口 |

approval 是交互授权，不代替版本检查和单写入者。审批通过也不能触发原始 FS 写入兜底。

### 2. 验证每个会话的项目身份

这部分源码修复已进入 `32bde094`，以下描述是应保留并在 GUI 验证的行为。

GUI 创建路径使用可信宿主传入的 `SessionHeader.cwd`。Git 项目沿用项目根解析；非 Git 项目保存最初选定的 workspace root。恢复必须使用已保存的项目身份，不能重新取当前 profile cwd。显式 `workspace_root` 可继续用于固定单工作区部署，但应验证会话目录属于该 root，否则拒绝，不能悄悄重绑。

两个 UI 创建的独立会话应各自取得规范 session ID，不要伪造成父子代理。fork 必须保留真实继承语义，但获取新的执行凭据。多个 Windows profile 必须汇聚到同一个协作协调域，不能各自启动独立 writer 后都认为自己持有同一项目。

### 3. 使用无循环的启动屏障

继续由协作插件安装 SessionPersistence、生命周期 hooks、工具 guard 后发布 `collaborationReady`。配置使 `agent-loop` 依赖 `sessionPersistence` 与 `collaborationReady`，使能够接收创建/恢复/运行请求的 API controller 也依赖 readiness。其余能独立发起 Agent 的服务必须逐个检查，不能漏掉 job、schedule、subagent 入口。

当前 `AgentRegistry` 先提供 `agents`，`AgentLoop` 再注册 factory。协作插件依赖 registry 而不依赖 SessionController，因此这个方向可作为下一实现起点；仍须用真实 Loader graph 测试证明无环。

不要在协作插件的 activation 内 `await loader.await()` 再发布 readiness。下游若正在等待 readiness，整棵树就无法 settlement。分开执行两类检查：

1. 激活前检查有效配置、固定包、预期依赖及 preset 声明，不要求下游已激活。
2. hooks 和 provider 就位后发布 readiness。下游挂载后及每次模型/工具调用前核对实际 provider、scope 和定义身份。

Web 的 URL-ready 和 Desktop 的 IPC-ready 保留原流程。它们需要在协作屏障后的 Loader 审计成功才发布。即使客户端提前请求 API，服务也必须尚未挂载或明确拒绝，不能依赖浏览器“通常晚一点打开”。

### 4. 保留生命周期和最终执行核对

复用现有 `agent/created`、`agent/pre-step`、`agent/disposed`、`tools/execute` 与 `llm/stream` hooks。补测真实 scoped preset 的 setup 顺序和工具覆盖。最终 guard 比较实际定义对象，不只比较名字；审批、异步 hook 和 preset 改动之后也不能换成原始写工具。

GUI 自动标题、压缩等辅助模型请求要核对会话身份和持久化边界，不能删除全局 LLM 防护来消除报错。若某个辅助功能尚不能映射到会话，明确禁用该项并记录限制，不应让整个 GUI 悄悄缺失会话行为。

卸载时先停止接收新调用，等待在途持久化和 writer 请求结束，再释放连接/单实例所有权。重载 preset、改 profile 或关闭窗口均要覆盖。用户选择关闭插件后不再保证协作，不代表在途写入可以随意中断并返回成功。

## 验证和验收门槛

本补丁之前，先保留可复现的配置证据：

```sh
node --import tsx/esm --test tests/host/gui-topology.test.ts
```

2026-10-22 在云端运行得到 4/4 通过。只解析 npm 配置并调用纯检查器，没有启动监听器、GUI、模型或协调器。这不是 Windows 兼容测试，也不是宿主双进程验收。

下一实现至少需要以下测试，前两项可以先在无监听器环境完成：

1. 配置测试验证 GUI 必需服务没有被禁用、collaboration preset 没有原始写入入口、所有已审计 scope 均精确匹配；未知包和未知 scope 仍拒绝。
2. 实际 Loader 的隔离组件测试覆盖 readiness 依赖，无环、有失败诊断，且控制器不能先于屏障接收调用。模拟 UI header 时覆盖两个不同 cwd、非 Git 子目录恢复、空会话复用、fork、archive、cold reopen。
3. Windows 原生真实 Node + 已打包插件 + 原版 IPC，运行两个真实 Harness 进程。分别记录两 PID、session ID、项目身份、消息序号、mutation ID、版本和恢复结果。组件内伪造 Agent 不算这一项。
4. Windows 正常 CLI Web profile 验证列表、创建、恢复、附件、审批、两工作区隔离，以及启用/关闭插件的对照。付费模型不得默认使用，优先经审计的无密钥 fixture。
5. 实际 Desktop 安装/运行时再执行同一场景，验证打包安装、后端重启、窗口关闭与 ready IPC。Web 测试不能替代 Electron 后端验证。
6. 有参与会话运行时切换 preset、尝试 shell/MCP/subagent 绕行，应得到明确拒绝或管理协议结果。重启协调器后原会话凭据、旧锁和未知 mutation 必须按既有恢复协议处理，不能“换 ID 重试”。

云端原有 socket 限制仍然存在，本次不重试、不换传输来绕过。该限制不是插件产品缺陷的证据。Windows 真实执行应在用户另外授权的测试会话和隔离测试目录中进行；本文不授权云端代理操作用户电脑。

## 当前完成和未完成

已完成源码审计及 4 项只读配置契约测试。没有修改现有生产 profile，也没有创建一个被宣称可用的 GUI overlay。每会话 cwd 的代码修复已进入本地冻结提交 `32bde094`，不等于 GUI 已验收。GUI 组合、scoped 工具接入和 readiness 激活测试仍待实现与评审。Windows IPC、SQLite 与 writer 的重构由其他补丁处理；这些补丁通过也不能替代这里的宿主验收。

## 只读候选配置契约

新增 `src/host/gui-profile-contract.ts`，尚未接入 `plugin.ts` 或现有 active verifier。它记录官方 `--profile web --dump-config` 的完整 root 模块身份，并约束下一步 GUI 候选配置。普通 UI、会话、审批、附件、storage、settings 条目保留；原始 shell、MCP、jobs、动态插件/preset 编辑、原始 session JSONL writer 和 FS backend 禁用。新增的空 `collaboration` preset 不安装额外子插件，因此只能继承 root 的管理工具定义。它不是完整 standard preset 的替代实现。

`inspectGuiProfileContract` 检查固定版本、重复/未知 entry、明确启停、session-controller/file-upload/agent-loop 启动依赖、专用 preset、状态目录与测试项目隔离。Windows 路径检查使用 Node `path.win32`，只是配置的词法检查，不冒充实际文件系统验证。返回类型将 `activation_allowed` 固定为 `false`，调用方不能把检查成功当作启动授权。

特别是 `settings` 依赖 `configEditor`，写入会修改 profile 并热重组代码。候选配置禁用原始 editor，所以正常设置功能仍缺一个命名空间受限的适配器。这是 `SETTINGS_ADAPTER_REQUIRED`，不是已解决的依赖问题。其余 blockers 包括 ProtectedFileSystem 的 GUI 兼容、全部 retained service 的写入审计、实际 Loader 的启动/卸载、运行时 guard、Windows 双进程，以及 Desktop 的独立运行时门槛。

`GUI_WRITE_BOUNDARIES` 列出已找到的具体写入路径和来源文件，包括 JSON storage、attachments/cache、credentials、settings、用户 workspace mkdir、只读 workspace-files 及禁用的 spill/process 路径。这份列表不声称已穷尽全部 retained service。状态根后续必须在真正的服务实例配置上验证，不能信任一份分离声明。

新增 `tests/host/gui-profile-contract.test.ts` 覆盖正向“仅配置有效但不可激活”和负向输入。另用官方 CLI 的 `--dump-config` 对照记录的全部 root 身份，仍不启动服务。不要将本模块改成 active checker 的替代品来让 GUI 表面启动。

本轮候选契约新测试 27/27，通过原有 topology 测试后合计 31/31；`npm run typecheck` 通过。中途工作树的 `npm run test:components` 为 346/346，通过日志保存于云端 `gui-contract-components.log`。其他 worker 当时仍在修改，这不是最终集成冻结结果。该命令不是含 socket 的完整测试集，未运行监听器或 Windows/GUI 验收。
