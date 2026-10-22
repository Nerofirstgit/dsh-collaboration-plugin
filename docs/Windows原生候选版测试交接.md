# Windows 本机测试交接：dsh 协作插件候选版

**用途：交给您另外打开的本机会话执行。本文不是 Windows 兼容性认证，也不是 65 项验收全部通过的报告。**

本开发版在云端实现；后续开发不依赖您的电脑在线。您后来明确要求由自己的本机会话测试，本文仅为那次测试提供操作范围；云端开发会话并未因此获得操作您电脑的权限。旧版“整改/只诊断”交接之后已经实现了 portable Node coordinator、Windows 资源身份候选、GUI 组合和真实宿主入口接线；但实际 Windows、完整 Desktop/Web 启动仍未验证。

## 0. 先说明边界，再动手

- **dsh 就是 DeepSeek Harness。目标是原生 Windows。** WSL、Linux 云机或 Windows 路径模拟测试都不能代替原生验收。
- 只保证启用插件、按受审计组合接入的 dsh 会话之间协作。其他程序编辑文件不保证阻止，只做尽力检测。dsh 自己的 shell、MCP、子代理、后台任务和插件工具不算“其他程序”：它们的项目写入必须受管理或被拒绝。
- 关闭/完整移除插件后不承诺协作保护。支持的退回方式是停止相关 profile、移除完整协作 overlay，再冷启动原版；不是在活跃任务中关闭一个布尔开关后立即放开原工具。
- **仅使用新建的临时项目、测试 Harness home、profile 和 coordinator 数据目录。不要把当前包安装进真实工作的 profile；不要打开生产项目做共享写实验。**
- 本文不会授权改系统安全设置、开 Developer Mode、提权、安装全局工具、创建新 API key、读取其他项目密钥或付费调用。缺少这些条件时先问用户，不能自动绕过。
- 实际测试有意使用原生产 IPC：Windows named pipe；模型可以由本地无密钥 HTTP fixture 代替。不是把协调器换成 loopback/mock。
- **一个例外需要提前告知：**为了保证同一 Windows 账户只有一个活动 coordinator，生产代码还会使用 `os.userInfo().homedir` 下的 `.dsh-collaboration-instance` SQLite 选主目录；它不随 `DSH_HOME`/`TEMP` 更改。不能承诺所有测试字节都只在临时目录。先确认没有其他协作 daemon 正在运行；不要删除这个目录/数据库来“解除锁”，不要为了隔离测试改掉生产选主规则。

## 1. 对齐代码与宿主，不猜用户使用的界面

宿主固定为：

- `@deepseek-ai/dsh@0.2.1-rc.2`
- 官方源码 commit `687f282e8625c6b8d11ff58211a90524be2e4317`
- Cordis `4.0.5`；开发验证 Node `24.19.0`，包声明 Node `>=24.0.0`
- 插件包名 `@nerofirstgit/dsh-collaboration`，当前开发版本 `0.1.0-dev.0`。**同版本号不等于同一产物**，必须核对随交付清单中的源码 commit 和 ZIP/tgz SHA256。

仓库：`https://github.com/Nerofirstgit/dsh-collaboration-plugin`（私有）。旧 main `fe7aad054e223163edb8a11b77826497db1c6819` 是早期 Linux 版，**不能用于这次 Windows 候选验收**。以本次交付的精确 commit/哈希为准；不要把“main 最新”当版本证明。不要打印 GitHub token 或复制凭据。

首先只收集：用户实际用的是 **Windows Desktop 安装版，还是原生 Windows CLI 启动的 Web GUI**；版本、安装来源、Node 版本、Windows 版本、项目盘文件系统（优先本地 NTFS，网络盘/同步盘另列未验证）。若实际宿主不是固定版本，先停止激活：升级适配需要单独计划，不自动降级用户应用。

原生 PowerShell 的只读检查示例：

```powershell
node -p 'JSON.stringify({platform:process.platform,node:process.version,arch:process.arch})'
git --version
npm.cmd --version
pnpm.cmd --version
Get-Command dsh -ErrorAction SilentlyContinue | Select-Object Name, Source
```

`platform` 必须为 `win32` 才是原生 Windows 证据。不要执行 `Get-ChildItem Env:` 或导出完整环境。不要凭 CLI Node 版本推断 Desktop 内嵌运行时：Desktop 后端由 Electron 的 Node 模式启动，版本和 `node:sqlite` 支持必须另核实。

## 2. 建立隔离工作区并验证源码包

选择不属于任何生产 Git 项目的新目录，例如 `$env:TEMP` 中的随机子目录。保留本次日志，不自动清理失败证据。

```powershell
$TestRoot = Join-Path $env:TEMP ('dsh-collab-accept-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TestRoot | Out-Null
$Logs = Join-Path $TestRoot 'logs'
New-Item -ItemType Directory -Path $Logs | Out-Null
# $Repo = 解压本次源码 ZIP 后的目录，或精确检出交付 commit 的独立 clone
# 不使用用户已有仓库，不把源码 checkout 本身当测试共享项目。
Get-FileHash -Algorithm SHA256 '<本次源码.zip>'
Get-FileHash -Algorithm SHA256 '<本次安装.tgz>'
```

在 `$Repo` 中，确认 `package.json` 的包名/pin、`lib` 可重新构建、锁文件来自同一次交付。依赖安装仅限这个目录；Node/pnpm/git 缺失时先请用户确认安装方案，不自动全局安装。

```powershell
Set-Location $Repo
npm.cmd ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed; do not continue.' }
npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed; do not continue.' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed; do not continue.' }
node .\lib\gui-configure.js --help
if ($LASTEXITCODE -ne 0) { throw 'Compiled CLI help failed; do not continue.' }
npm.cmd pack --dry-run
if ($LASTEXITCODE -ne 0) { throw 'Package inspection failed; do not continue.' }
```

任何命令失败都记录 `$LASTEXITCODE` 和原始输出。不要以删除锁文件、放宽版本或启用 raw-write fallback 修复。`--ignore-scripts` 不等于所有依赖完全无原生代码；官方宿主仍有自己的依赖，需要在实际运行时验证。

## 3. 先跑不监听、不付费的组件检查

本次代码冻结 `697f75c76084f2fc9abfa85c5abbb00cafd7f80e` 的干净归档（无 upstream checkout）通过 **620/620 安全组件测试、0失败/0跳过**，typecheck/build 通过。此前 GUI 核心冻结 `eafd8196ff5f1d0789770dd62b05b9211b427d4c` 为604/604；这些数字不能相加。Desktop 修正首次609/612的三个fixture依赖失败也已保留并说明。所有这些是 Linux/Node 24.19.0 证据，不能换标签当 Windows 通过。最终文档/源码交付 commit 以 manifest 为准，生产代码和测试须与上述冻结一致。

先执行无监听的连接状态机/配置生成/真实 GUI 接线子集，保留 TAP：

```powershell
node --import tsx/esm --test --test-reporter=tap `
  tests/client.test.ts tests/client-readiness.test.ts tests/gui-configure.test.ts `
  tests/host/gui-admission.test.ts tests/host/gui-mounted-controller.test.ts `
  tests/host/gui-session-controller.test.ts 2>&1 |
  Tee-Object (Join-Path $Logs 'native-components.tap')
$ComponentExit = $LASTEXITCODE
if ($ComponentExit -ne 0) { throw 'Component test failed; preserve TAP and diagnose before continuing.' }
```

这包含实际 Cordis/AgentLoop/SessionPersistence/stock SessionController/Gateway 的无网络组件，不等于整个 GUI 已启动。部分其他 GUI inventory 测试仅构造 Loader metadata，报告中必须区分。

**旧完整组件脚本的可移植性注意：**`npm run test:components` 包含从 Linux 阶段保留的 POSIX fd/权限故障注入、需要符号链接权限的测试，以及直接插入 workspace 而未走 Windows identity 初始化的 writer 夹具。不能把这些 Windows 夹具失败自动算产品缺陷，更不能删断言/全部 skip 后宣布通过。可以另跑完整脚本收集诊断，但须逐项归因并提出最小测试适配；真实写入、冲突与崩溃验收不能因此免除。不要自动开启 Windows Developer Mode 来让 symlink 测试变绿。

## 4. 原协调器 + 两个真实 Harness：无密钥基础场景

先确认没有其他协作 coordinator/参与会话运行。**本阶段确实启动本机 listener 和子进程**，由用户指定的本机会话在允许的环境执行。云端的 bind 限制不是本机产品错误，也不是要求更换 transport 的理由。

已有文件：`tests/integration/two-host-processes.test.ts`。它启动两个不同 PID 的官方 CLI Harness，使用各自独立会话；共享 SQLite coordinator 仍走生产 named pipe。只有模型端点被本地固定 HTTP/SSE fixture 替代，使用明确假的 key，不访问付费服务。

```powershell
$env:DSH_TEST_KEEP_ARTIFACTS = '1'
node --import tsx/esm --test --test-reporter=tap `
  tests/integration/two-host-processes.test.ts 2>&1 |
  Tee-Object (Join-Path $Logs 'two-real-harness.tap')
$TwoHostExit = $LASTEXITCODE
Remove-Item Env:DSH_TEST_KEEP_ARTIFACTS -ErrorAction SilentlyContinue
if ($TwoHostExit -ne 0) { throw 'Two-host fixture failed; preserve its artifacts before continuing.' }
```

保留日志中提示的 fixture 目录和 `evidence.json`。不要上传 `runtime.key`、整个数据库或未脱敏日志给无关渠道。先以只读方式检查当前 fixture 的统计和最终文件；不要修改 SQLite 状态以凑出结果。

**这个现有测试只有一个有限场景：**A/B 各 5 次模型边界请求；两者先读同一文件，A 修改并发现 B、发送一条消息；B 旧版本编辑被拒，看到带非人类授权标记的消息，重新读取后再编辑；最终 `shared.txt` 为 `base\nA\nB\n`，一条消息 delivered、有 context receipt、两条 committed file mutations。

它为了两个虚构测试会话明确配置 `same_project_enabled`，只授予同项目协调消息，不是对真实会话的一般授权。正常 GUI overlay 仍用 `explicit_only`。

**它不证明：**idle 投递、daemon 重启/被杀、恢复窗口、所有权限撤销、Windows GUI、正式 tgz 安装。它通过 `initProfile` + 源目录链接（Windows junction）接入插件，不是 `dsh plugin add <tgz>` 的包安装验收。开关保留产物之前的原测试成功后会清理临时目录；不要混淆新旧行为。

## 5. 单独验收实际 tgz 的官方安装路径

这一步与上面的源 fixture 分开。用全新的 `DSH_HOME`，不要复用默认 home。以下示例是 **原生 Windows Web 后端**；不能替代 Desktop 验收。

```powershell
$HarnessHome = Join-Path $TestRoot 'harness-home'
$State = Join-Path $TestRoot 'coordinator-gui'
$Project = Join-Path $TestRoot 'project-gui'
$Overlay = Join-Path $TestRoot 'gui.overlay.yml'
$Dump = Join-Path $TestRoot 'web.composed.yml'
New-Item -ItemType Directory -Path $HarnessHome,$Project | Out-Null
$env:DSH_HOME = $HarnessHome
$Dsh = Join-Path $Repo 'node_modules\@deepseek-ai\dsh\lib\bin.js'
& node $Dsh --version
if ($LASTEXITCODE -ne 0) { throw 'Pinned Harness version check failed; do not continue.' }
# 必须确认 0.2.1-rc.2。下面是正式 add，不是“plugin install <tgz>”。
& node $Dsh plugin --profile web add '<本次安装.tgz的绝对路径>'
if ($LASTEXITCODE -ne 0) { throw 'Official plugin add failed; do not continue.' }
```

宿主 plugin 命令需要其受支持的 pnpm 环境。不要用源码 symlink 替代这一步后再说包安装通过。记录实际安装的 package.json、导出入口是否存在、tgz SHA256；不要打印密钥。

获得官方组合 dump 时避免 Windows PowerShell 5 默认 UTF-16 重定向。下面显式以无 BOM UTF-8 写文件，不启动 profile；先确认 `$Dump` 尚不存在，不覆盖既有材料：

```powershell
if (Test-Path -LiteralPath $Dump) { throw 'Refuse to overwrite an existing dump.' }
$PreviousConsoleEncoding = [Console]::OutputEncoding
try {
  # PowerShell 5 must decode Node stdout as UTF-8, including Chinese paths.
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $DumpLines = & node $Dsh --profile web --dump-config
  if ($LASTEXITCODE -ne 0) { throw 'Harness config dump failed; do not continue.' }
  [IO.File]::WriteAllText($Dump, (($DumpLines -join [Environment]::NewLine) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
} finally {
  [Console]::OutputEncoding = $PreviousConsoleEncoding
}
$Profile = Join-Path $HarnessHome 'profiles\web'
$InstalledCli = Join-Path $Profile 'node_modules\@nerofirstgit\dsh-collaboration\lib\gui-configure.js'
& node $InstalledCli --input $Dump --surface web --home $HarnessHome `
  --profile-dir $Profile --data-dir $State --output $Overlay
if ($LASTEXITCODE -ne 0) { throw 'GUI overlay generation failed; do not continue.' }
& node $Dsh --profile web --patch $Overlay --dump-config
if ($LASTEXITCODE -ne 0) { throw 'Composed overlay validation failed; do not continue.' }
```

安装默认 bundle 是 headless 基线；**GUI 必须额外使用这个固定 overlay**，不能只加包后把原浏览器 profile 当作受保护。CLI 只生成新文件，不编辑现有 profile，不执行 dump 里的 `!!js`。检查原始 stock session-controller 保留、owned controller guard/editor 存在、启动依赖正确、没有未知启用插件。dump 通过仍不等于实际 READY。

确认没有真实 provider 凭据被意外带入该测试 home；不要复制原 home 的 credentials。实际 Web 只启动 UI 时也应先明确不发送付费 prompt。确认后才运行：

```powershell
Set-Location $Project
& node $Dsh --profile web --patch $Overlay --no-open
```

新终端与当前 `$env:DSH_HOME` 不自动共享变量，必须显式设置同一测试 home。仅访问控制台提供的本地鉴权 URL，不转发端口，不分享含 token 的 URL。若想开始模型交互，先选择经审查的本地 fixture，或取得明确的真实 endpoint/费用/凭据授权；不要凭这个 UI 启动命令推断已授权付费调用。

## 6. Windows Desktop 是独立门槛

1. 核实用户真实 Desktop 版本、来源、内嵌 Node/SQLite 与固定宿主是否一致。
2. `DSH_HOME` 只隔离 Harness home。Electron 的 `userData`、桌面设置和更新日志独立；**不能假设 `$env:DSH_HOME` 或随手加 `--user-data-dir` 就隔离了它们**。先确认该固定 Desktop 的受支持隔离/测试启动方式。若没有明确方式，不启动用户常用应用来试错，记录门槛并问用户。
3. 固定 overlay 的 `--surface desktop`、`--profile-dir <测试home\profiles\desktop>` 要与实际 profile 一致，持久 overlay 放置位置必须按官方 profile 层核对。不要把 CLI 临时 `--patch` 误认为 Desktop 启动一定会继承。
4. 验证实际 renderer/browser client 加载、API ready、会话新建/空白复用/选择工作区、冷打开、fork/archive、消息审批、受管理写入，以及停止/退出/更新检查。Desktop 还有 `runProfile` 之后的 app-owned plugin，不只有 Loader 表；按当前 source audit 检查 jobs registry 与 Office tool admission，不能拿 Web green 替代。
5. 不执行真实软件更新或安装 Office 依赖来验收插件。只验证 stock inspection/拒绝路径；任何更新安装是另一项用户动作。

如果此阶段无法安全隔离或宿主版本不同，结果应是“Desktop gate 未运行/阻塞”，不是“Windows 兼容”或“必须换 WSL”。

## 7. 基础场景以外仍需补的真实两进程验收

基础 fixture 通过后，按 `docs/acceptance-matrix.md` 补独立用例。不要直接把 65 行全勾上。每项都记录两进程 PID、逻辑 session id/新 incarnation、状态前后和原始证据；不得制造子会话冒充独立会话。

- **Idle 消息：**B 没有自动开启模型轮次；A 发消息后只排队，B 明确继续时在下一个模型边界看到一次 durable relay。证明不是 prompt 注入式假协作。
- **权限：**默认 explicit_only 未授权发送必须拒绝；一次允许只绑定该发送/接收者/key；后续消息、跨项目、历史访问不能继承。撤销后按矩阵检验，不自动切 same_project_enabled。
- **共享写：**同文件互斥、不同已有文件可独立；旧 read token/version 必须拒绝；同 mutation id 重试回相同结果，换内容要冲突；Windows 大小写/已有8.3别名不得分裂资源。缺失名称保守锁住父 namespace 可能串行化新建兄弟文件，这是已声明策略。
- **真实进程终止与恢复：**只终止本次创建且身份已核对的测试 PID；不要 `taskkill /IM node.exe`。终止 A 后验证 B 的旧身份不能代写；只在本测试 daemon 身份被确认后终止它，观察选主、epoch、恢复和旧请求拒绝。SIGKILL/TerminateProcess 的原生结果要记录，不能把 Linux 日志搬来。
- **文件 publication 窗口：**先设计可复现的 fixture/failpoint，再制造具体阶段中断。分别验证 prepared、publication 后、terminal commit 后；保留 journal/工件。无足够证据时 `needs_recovery`/`OUTCOME_UNKNOWN` 是正确停机，不应删除记录或换 operation id 强制继续。
- **启用/移除：**启用时 raw filesystem/shell/MCP/未知 tool definition 明确拒绝；临时卸载的旧 wrapper 关闭新入口，在途创建不得绕过 provider；完整移除 overlay 冷启动原版后 stock 行为恢复，关闭期间不承诺保护。历史 SQLite 不自动转成 JSONL，绝不删库来卸载。

这些扩大场景尚不是现有一条 integration test 的内容。优先补独立可重复脚本和明确断言；不在真实项目中手工破坏文件。Windows 不声明目录 fsync/整机断电认证，其他程序文件修改不属于阻止保证，网络盘/多账户/多容器共享也未认证。

## 8. 失败时的处理与报告模板

先保存证据，**不要**删除 SQLite/-wal/-shm/-journal、runtime key、recovery 工件，不猜成功/失败后以新 ID 重试。不要扩大权限、启用原始 shell/写入工具、关闭 guard 或放宽 package 白名单。

```text
测试者/日期：
插件 source commit / tgz SHA256：
宿主版本 / upstream pin：
Windows版本 / 架构 / 文件系统：
实际界面：Desktop 或原生CLI-Web（不是WSL）
CLI Node版本；Desktop Node版本（若已验证）：
隔离 home/profile/project/state；账户级选主目录是否已告知：
费用/凭据：仅本地fixture / 用户明确授权的端点（不填secret）
安装方式：正式tgz plugin add / 源fixture（分开）
执行命令、退出码、日志文件：
通过项：逐项编号 + 证据
失败项：期望 / 实际 / 第一处错误 / 最小复现
未运行项：原因（环境限制、平台夹具、缺权限、未实现、待审查分开）
两Host PID / session IDs / daemon身份确认方式：
最后文件内容hash、messages/context/intent统计：
结果未知的mutation IDs、保留目录（不上传key/原始私密历史）：
是否修改了测试或源码：精确diff；不得隐瞒
结论：组件结果 / packed安装结果 / Web / Desktop / 两进程结果分别写
```

## 9. 给本机会话的可直接粘贴指令

> 请按随附《Windows 本机测试交接》验收 DeepSeek Harness（dsh）协作插件候选版。目标为原生 Windows，不使用 WSL 代替。先确认我实际使用的 Desktop 或 CLI-Web、固定宿主版本、当前交付 commit/tgz SHA256及可隔离的运行环境；不操作我的生产项目/常用 profile，不扫描无关凭据。只在新建临时目录进行测试，并先告知生产选主还使用账户home下`.dsh-collaboration-instance`，不要删除它。先做无监听组件和正式包检查，再运行已有的两个真实 Harness、原生产IPC、无密钥模型fixture；保留TAP和清洗后的证据。不要把源symlink fixture算正式tgz安装通过。完整组件中如遇Linux专用测试夹具，记录并提出最小测试适配，不删断言、静默skip或修改生产guard凑绿。真实付费端点、新凭据、系统安全设置、全局安装、Desktop非隔离启动都先征求我的明确同意。Desktop与Web分开验收；无法隔离或版本不符就停止对应阶段。把失败、未运行、测试脚本不兼容和产品缺陷分开报告，不宣称所有65项已通过。任何OUTCOME_UNKNOWN/needs_recovery保留原ID、DB及工件，不清库强行重试。
