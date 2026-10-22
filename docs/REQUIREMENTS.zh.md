# DeepSeek harness 会话协作能力迁移：开发提示词

> 使用方式：将本文件完整交给能够访问 DeepSeek harness 仓库的开发 agent。
> 本次实施 P0：会话发现、消息通信、共享文件写入保护。
> P1–P3 是后续开发规格，本次只保留必要扩展点，不提前实现。
> 修订版：2026-10-20。已补充并发竞态、消息投递与崩溃恢复审查；修订摘要见第 15 节。

## 1. 任务与完成定义

你负责在现有 DeepSeek harness 中实现项目级会话协作能力。多个独立会话可能由不同进程启动，并指向同一个代码工作目录。当前它们无法发现对方、交换消息，也无法可靠阻止基于旧文件内容的覆盖。

本次必须交付可运行的 P0，包括真实接入、自动化测试、使用文档和演示。不能只添加工具定义、提示词、设计稿或未被调用的服务。

先检查仓库，确认实际语言、架构、会话生命周期、模型调用循环、工具分发、持久化、shell 执行、安全边界和测试框架。沿用现有结构实现，文中的类型和模块名称是设计契约，不是要求新建同名目录。不要因为文中出现 TypeScript 风格类型就更换项目语言。

“与 Codex 一样”在本任务中定义为：**对本文列出的会话发现、通信、任务控制、子 agent 协作和工作目录隔离能力，逐项实现可验证的行为等价。**不要求界面像素一致，不涉及其他 Codex 产品功能，也不能声称复刻了未公开的 Codex 内部实现。

需要明确：

- 独立会话之间的通信，与同一任务内主/子 agent 通信，使用不同的授权和生命周期规则。
- 会话共享文件不意味着它们共享完整上下文。
- 能发送消息不意味着能自动避免文件覆盖。
- 文件租约、内容版本校验和崩溃恢复是本方案的工程要求；不得宣传成已经确认的 Codex 原生文件锁机制。
- P0 完成只能标记为“P0 行为达标”，不能标记为“全部 Codex 协作能力已经等价”。

## 2. 行为对齐清单

在仓库中维护一份 capability-parity 文档。至少包含下表，并记录实现入口、测试编号、限制和状态。状态使用 `planned | implemented | verified | unsupported`。

| 能力 | 本方案要求 | 阶段 |
|---|---|---|
| 发现独立会话 | 查询同项目会话、状态、工作目录和任务摘要 | P0 |
| 读取协作状态 | 查询当前任务、文件活动、消息状态；不默认暴露完整对话 | P0 |
| 定向通信 | 持久化投递，运行中安全注入，空闲时保留待收消息 | P0 |
| 自动协作感知 | 在会话启动、恢复和运行循环边界注入相关变化 | P0 |
| 共享文件保护 | 文件租约、版本前置条件、所有受管写入经过统一入口 | P0，增强要求 |
| 跨会话追加任务 | 授权后向独立会话提交任务，按状态启动或排队 | P1 |
| 查看历史和等待结果 | 分页历史、游标等待、完成/需关注事件 | P1 |
| 主/子 agent 协作 | 创建、列举、消息、追加任务、等待、中断、结果回传 | P1 |
| 独立 worktree | 每个任务独立目录、初始化、验证、整合 | P2 |
| 会话分叉和目录交接 | 定义上下文复制及 Local/Worktree 迁移规则 | P2 |
| 归档、恢复和审计 | 可恢复快照、历史、故障诊断、运行指标 | P2–P3 |

参考行为来源：

- OpenAI Subagents：https://learn.chatgpt.com/docs/agent-configuration/subagents
- OpenAI Multi-agent primitives：https://developers.openai.com/api/docs/guides/responses-multi-agent
- OpenAI Git worktrees：https://learn.chatgpt.com/docs/environments/git-worktrees
- Codex 桌面环境可提供 `list_threads`、`read_thread`、`send_message_to_thread`、`wait_threads` 等工具。它们属于客户端工具能力，不应当被描述为所有 Codex 客户端都具备的同一个公共协议。

本文后续的接口是 DeepSeek harness 的目标接口，不是 Codex 官方 API 的逐字复制。若开发时查到参考行为变化，记录差异，优先保持本文明确约定的兼容行为；不要未经说明改变范围。

## 3. 先完成仓库接入调查

开始编码前输出一个简短接入表，每一行必须填真实文件路径和符号：

| 接入点 | 需要查明的内容 |
|---|---|
| 会话创建/恢复/结束 | 稳定 session ID、进程信息、cwd、恢复路径、退出回调 |
| 项目解析 | 仓库识别、Git common dir、worktree、无 Git 目录 |
| 模型运行循环 | 每次请求前、工具执行前后、流式生成中、等待状态 |
| 工具注册/执行 | 参数校验、调用者身份、权限、错误序列化 |
| 文件读取 | 如何拿到完整原始字节、文件版本、读取凭据 |
| 所有文件修改入口 | edit、write、patch、create、delete、rename、编辑器集成 |
| shell/外部工具 | 重定向、脚本、格式化器、代码生成器、依赖安装和 Git 命令 |
| 上下文/压缩 | 如何持久化消息、注入事件、恢复未处理通知 |
| 存储与 UI | 数据库、迁移、设置、状态展示、日志 |
| 测试 | 单元测试、跨进程测试、平台测试、故障注入 |

如果存在类似服务，扩展或复用。不要维护两套会话真相来源。缺少仓库或必要输入时明确说明，不能虚构代码位置。

## 4. P0 架构和身份规则

### 4.1 协调服务

所有参与协作的 harness 进程必须连接同一个协调服务。单机默认可以采用本地 daemon + SQLite；已有后端和数据库时优先复用。SQLite 放在本机文件系统，不把它作为多主机共享数据库使用。

协调服务负责：

1. 会话注册、心跳、状态和恢复。
2. 消息持久化、授权、事件游标与投递。
3. 文件租约、有效代次、写入序列化和版本校验。
4. 写入意图、结果、事件的持久化与故障恢复。

协调数据放在应用管理的数据目录，不污染用户源码和 Git 提交。模型不能直接修改协调数据库或绕过服务伪造租约。多个 harness 同时启动时只能选出一个有效协调服务实例；避免各自创建独立的“共享”状态。

P0 固定采用**单机、单个有效协调服务、实际文件修改由受信任 writer 执行**的边界。客户端领取租约后不能自行拿着 token 裸写文件；fencing token 必须由真正执行文件修改的组件校验。

服务启动先取得由操作系统持有的排他实例锁，再递增持久化 `coordinator_epoch`，然后完成恢复，最后才开放写入。超时或心跳失联不能单独作为创建第二个 writer 的依据。旧服务只是暂停、尚持有实例锁时，新服务必须拒绝接管；旧服务仍存活的可写 helper 必须退出或被实际隔离，不能让它在主进程死亡后继续裸写。

文件级恢复期间设置持久化 `recovering/needs_recovery` 栅栏；此时不授予该资源的新租约，不执行新写入。其他可确认安全的资源可以继续工作。数据库损坏或无法判断协调域归属时，整个相关 workspace 暂停写入。恢复/重建旧数据库必须建立新的协调域凭据并使旧 token 失效，不能回滚计数后继续接受旧请求。

### 4.2 三种标识

```text
project_id   同一项目的稳定身份；多个 worktree 可以归属同一项目。
workspace_id 同一实际工作目录的稳定身份；不同 worktree 必须不同。
session_id   用户可恢复的逻辑会话身份。
```

另设 `incarnation_id`，表示 session 当前这一次运行实例。进程重启后产生新 incarnation；旧实例的心跳、租约和写入凭据不能重新生效。

同一个 session 的恢复注册必须是比较并交换操作：携带预期旧实例身份或明确的接管授权，原子登记新实例，并作废旧实例的投递批次、续租和工具调度资格。两个进程不能同时恢复为有效 owner。P0 就必须有每 session 的执行互斥和 `execution_epoch`，确保上下文追加、压缩和工具调度不会被两个 agent loop 同时推进；这项基础互斥不能推迟到 P1。

Git 项目以规范化的 Git common dir 等信息关联项目；不要只用远端 URL，两个独立 clone 不应自动成为一个共享写入域。工作目录身份使用真实路径，并考虑 Windows 大小写、盘符、junction/symlink 等别名。

没有 Git 时，以用户选定的规范化项目根目录注册身份。

同项目、物理不重叠的不同 workspace：可以发现与通信，不争用同一份普通源码文件租约。同 workspace：文件租约和版本检查必须互相可见。

注册时必须检测跨项目/跨 workspace 的物理重叠。会话从同一项目的子目录启动应归并到相同 workspace；无法归并的父子工作根目录，P0 明确拒绝同时进入受保护模式。不能仅因 workspace_id 不同就给重叠的物理文件建立独立锁域。

Git worktree 共享的 common dir、对象库和 refs 等仓库级资源也不属于“普通源码文件互不影响”的保证。P0 对修改这些共享资源的操作使用独立仓库级协调，尚未实现时明确禁止；不能借不同 worktree 身份绕过它。

### 4.3 最小数据模型

```text
Session
  id, project_id, workspace_id, incarnation_id, execution_epoch
  title, task_summary
  state: starting | running | waiting | idle | interrupted | completed | failed
  presence: online | offline
  host_id, started_at, last_heartbeat_at

Message
  id, project_id, from_session_id, to_session_id
  kind: coordination | task | result
  body, related_paths[], in_reply_to?
  idempotency_key, request_fingerprint, created_at, recipient_sequence
  delivery_state: queued | reconciling | delivered | rejected | expired
  terminal_reason?, admitted_parts[]
  delivered_at?, acknowledged_at?, acknowledged_by?
  handling_state: pending | acknowledged | resolved
  resolved_at?, resolution?

ContextDelivery
  receiver_session_id, message_id, part_index, part_count
  content_digest, delivery_id, batch_id
  incarnation_id, execution_epoch, expected_context_revision
  context_record_id?, committed_at?

Event
  id, project_id, workspace_id?, sequence, type
  actor_session_id?, payload, created_at

FileLease
  workspace_id, resource_key, owner_session_id, owner_incarnation_id
  lease_id, coordinator_epoch, fencing_token, expires_at

ResourceGuard
  workspace_id, resource_key, last_fencing_token
  recovery_state: ready | recovering | needs_recovery

FileMutation
  mutation_id, workspace_id, session_id, incarnation_id, coordinator_epoch, request_fingerprint
  operation, resource_keys[], expected_versions[], resulting_versions[]
  state: prepared | applied | committed | aborted | needs_recovery
  temp_artifact_refs[], recovery_evidence?, original_result?
  created_at, committed_at?, error?

Outbox
  event_id, source_type, source_id, payload, published_at?
```

`state` 和 `presence` 分开：心跳过期表示离线，不能据此把任务宣布成功、失败或已完成。

`acknowledged_at` 表示显式确认收到；`resolved` 表示通过显式操作记录了处理结论。两者都不能由 delivered、轮次结束或任意一条回复自动推导。

`delivered` 仅表示完整消息的全部分片已经持久化进入接收方的上下文记录，并且仍可通过活动上下文或待处理引用检索。它不表示模型请求已成功、不表示模型已经阅读/理解，也不表示对方同意。

## 5. P0 接口设计

### 5.1 通用约定

所有接口必须有输入 schema 校验、稳定错误码和一致结果结构。身份来自可信运行时，不能由模型参数指定 `from_session_id`、租约所有者或权限。

本文使用短工具名描述行为。若框架支持命名空间，独立会话工具使用 `sessions.*`，子 agent 工具使用 `collaboration.*`；否则使用 `session_send_message`、`agent_send_message` 等明确前缀。不能在同一个模型工具集合中注册两个语义不同的 `send_message`，也不能靠目标 ID 的格式猜测授权路径。

下列为语言无关契约：

```text
Result<T> {
  status: "success" | "warning" | "error",
  summary: string,
  data: T | null,
  error: null | {
    code: string,
    message: string,
    retryable: boolean,
    details: object,
    recovery_action: string,
    stop_condition: string
  },
  next_actions: string[],
  artifacts: { type: string, id?: string, path?: string }[],
  request_id: string
}
```

列表使用稳定游标分页，禁止默认返回所有历史。时间使用 UTC 序列化；租约有效性由服务端判断，不信任客户端时钟。工具输出限制体积，文件全文和历史按需读取。

所有运行时私有请求携带可信的 `session_id / incarnation_id / execution_epoch / coordinator_epoch` 凭据；公共工具的这些字段由适配器附加，不能让模型填写或扩大权限。旧实例不能确认投递、续租、释放新实例租约或追加上下文。

消息发送、claim、释放和文件修改均需稳定幂等标识。运行时在发起请求前持久化标识与规范化请求；同一个逻辑操作发生网络重试、恢复查询时沿用它。同 key 配不同逻辑内容返回冲突，不能默默复用。

消息 key 的唯一作用域为 `(project_id, from_session_id, idempotency_key)`；文件修改为 `(workspace_id, session_id, mutation_id)`；claim/release 为 `(session_id, request_id)`。接收方、路径、操作、前置版本和正文/补丁等纳入请求指纹；重连凭据、批次 ID 等瞬态字段不纳入逻辑内容指纹。消息回复的 `in_reply_to` 必须存在且对调用者可见，不赋予额外权限。

P0 不自动删除已接受操作的幂等记录；正文/历史可按明确策略归档，但要保留足以识别重复请求的 tombstone。未完成 mutation、未投递消息和未发布 outbox 不得被普通事件清理任务删除。后续若引入保留期，必须返回 `IDEMPOTENCY_WINDOW_EXPIRED`，禁止把超过窗口的旧请求当新操作重做。

### 5.2 模型可调用的发现与通信工具

```text
list_sessions({
  scope?: "same_workspace" | "same_project",  // 默认 same_project
  states?: SessionState[],
  include_offline?: boolean,                // 默认 false
  cursor?: string,
  limit?: integer                          // 默认 20，最大 100
}) -> {
  sessions: SessionSummary[],
  next_cursor: string | null
}

get_session_status({
  session_id: string
}) -> {
  session: SessionSummary,
  file_activity: FileActivitySummary[],
  last_public_result?: string
}

send_message({
  to_session_id: string,
  body: string,
  related_paths?: string[],
  in_reply_to?: string,
  idempotency_key: string
}) -> {
  message_id: string,
  delivery_state: DeliveryState              // 新接受通常 queued；幂等重试可返回当前终态
}

get_message_status({
  message_id: string
}) -> {
  delivery_state: DeliveryState,
  handling_state: "pending" | "acknowledged" | "resolved",
  delivered_at?: string,
  acknowledged_at?: string,
  resolved_at?: string
}

read_message({
  message_id: string,
  cursor?: string,
  max_tokens?: integer                      // 默认 1000，最大 2000
}) -> {
  body_part: string,
  content_digest: string,
  next_cursor: string | null
}

mark_message_handled({
  message_id: string,
  action: "acknowledge" | "resolve",
  resolution?: string                        // resolve 必填
}) -> {
  handling_state: "acknowledged" | "resolved"
}

poll_events({
  cursor?: string,
  limit?: integer,                          // 默认 20，最大 100
  wait_ms?: integer                         // 默认 0，最大 30000
}) -> {
  events: EventSummary[],
  next_cursor: string | null,
  has_more: boolean,
  resync_required: boolean
}

get_coordination_snapshot({
  cursor?: string,                           // 同一 snapshot 的后续分页
  limit?: integer
}) -> {
  snapshot_id: string,
  sessions: SessionSummary[],
  file_activity: FileActivitySummary[],
  pending_message_refs: MessageReference[],
  event_high_watermark: string,
  next_cursor: string | null
}
```

P0 的 `send_message` 只创建 coordination 消息，不启动空闲会话的新模型轮次。`task` 和 `result` 类型为后续任务/子 agent 机制预留，调用者不能伪造这些类型绕过调度授权。

P0 对存在且仍可恢复的 idle、offline、completed、failed、interrupted 会话接受消息并保持 queued；不会自动恢复该会话。对已永久删除的收件人拒绝新消息。默认不自动过期已接受消息；若配置 TTL，过期必须持久化终态、通知发送方并计入审计，不能清理后假装已送达。

TTL 到期对领取中的批次采用与第 7 节撤销相同的接纳核对屏障。不能因确认延迟把已完整合法接纳的消息改为 expired；只有待处理分片被可靠停止后才关闭为过期终态。

`mark_message_handled` 仅允许接收方或经明确授权的用户操作，采用幂等且单向的状态转换。acknowledge 仅确认收到；resolve 记录处理结论，不是为该结论涉及的其他操作授予权限。

`read_message` 是限长摘要/引用的正文检索入口，按消息可见权限检查。主动检索可以重复显示正文，但不推进自动投递游标；“不重复投递”限定为自动消费不重复追加同一分片记录，不禁止用户或模型有意重读。

项目范围从调用者身份推导；不得允许模型传入其他 project_id 绕过隔离。消息默认限制 8 KiB，超限返回 `PAYLOAD_TOO_LARGE`，不静默截断。

同项目发现权限不等于查看所有私信的权限。事件订阅按接收者和授权过滤，消息正文只对通信参与者及明确授权的协调者可见；分页游标也不能用于读取其他会话的私信。P0 默认处理同一用户管理的本机会话，多用户共享服务必须增加独立认证边界。

`related_paths` 必须连同来源 workspace 解释。两个 worktree 中同名路径不能被当成同一个物理文件。

### 5.3 运行时私有接口

以下接口由 harness 生命周期调用，不直接暴露给模型：

```text
register_session(project_context, workspace_context, session_identity, expected_previous_incarnation?)
heartbeat(runtime_identity)
update_session_state(runtime_identity, state, task_summary?)
close_session(runtime_identity, reason)
fetch_delivery_batch(runtime_identity, delivery_cursor, context_revision, budget)
commit_context_delivery(runtime_identity, batch_id, context_record_ids, expected_context_revision)
renew_claims(runtime_identity, lease_ids, request_id)
get_mutation_status(runtime_identity, mutation_id)
reconcile_mutation(runtime_identity, mutation_id)   // 只触发受限恢复/核对，不等于重新执行
```

会话状态由调度器更新，任务摘要可以来自模型，但它不能覆盖真实运行状态。

可配置初始默认值：心跳 10 秒、离线判定 45 秒；测试使用可控时钟，不通过长时间 sleep 验证。

### 5.4 文件租约接口

```text
claim_files({
  paths: string[],
  purpose: string,
  request_id: string,
  ttl_ms?: integer                          // 默认 60000；范围由服务配置
}) -> {
  claims: {
    path: string,
    lease_id: string,
    coordinator_epoch: integer,
    fencing_token: integer,
    expires_at: string
  }[]
}

release_files({
  lease_ids: string[],
  request_id: string
}) -> {
  released: string[],
  already_released: string[]
}
```

多路径 claim 必须一次全成功或全失败。冲突返回被占用文件、占用者的可见摘要和可操作建议，不暴露无权限的信息。

续租由运行时管理，不要求模型手动维持心跳。续租只能延长当前有效 incarnation 的租约。完成、取消和退出时主动释放；进程崩溃时通过到期和代次检查回收。

`claim_files` 的重试返回原 claim 结果，不暗中生成新租约或延长 TTL；原租约已失效时返回失效状态，重新申请使用新的 request_id。fencing token 每资源持久化递增，释放/删除租约行不得重置计数。服务重启使旧 epoch 下的租约全部失效；已提交 mutation 的查询仍可返回原结果。

运行中的 TTL 用单调时钟计量，UTC expires_at 只用于展示；重启后不把旧单调时钟值直接比较。机器时间跳变不能使旧租约重新生效。续租需要执行器仍有效且该工作仍需要占用文件，不能由独立心跳线程为已停止的任务无限续租。

租约只表示修改责任，不提供文件内容版本保证，也不禁止其他会话读取。

### 5.5 文件读取和写入

扩展现有文件工具，不另造一套容易被绕过的平行工具。

```text
read_file(path, range?) -> {
  content: string,
  version: "sha256:<digest>",
  read_token: string,
  truncated: boolean,
  file_activity: FileActivitySummary
}

get_mutation_status({
  mutation_id: string
}) -> {
  state: "not_found" | "prepared" | "applied" | "committed" | "aborted" | "needs_recovery",
  original_result: object | null,
  recovery_action: string | null
}

apply_file_change({
  path: string,
  operation: "create" | "replace" | "patch" | "delete",
  expected_version: string | null,
  read_token?: string,
  lease_id: string,
  coordinator_epoch: integer,
  fencing_token: integer,
  mutation_id: string,
  content?: string,
  patch?: StructuredPatch
}) -> {
  mutation_id: string,
  previous_version: string | null,
  new_version: string | null,
  event_cursor: string
}
```

语义必须明确：

- `version` 针对文件完整原始字节计算，不只对展示片段计算；不是 mtime。
- 展示内容、完整哈希、读取范围和 read_token 必须来自同一个稳定字节快照。不能先读内容、放开锁，再重新打开文件计算版本。P0 可在资源短锁内读取完整字节，再基于该快照算哈希并截取输出；检测到外部变化或无法保证一致读取时重试或报错，不能签发不匹配的 token。
- `read_token` 绑定调用者、workspace、规范路径、版本以及读取范围，不能通过猜 token 获得写权限。
- `create` 使用显式 `expected_version: null`，含义为“目标必须不存在”。省略前置条件不能视为 null。
- `replace / patch / delete` 必须带有效旧版本；缺少前置条件直接拒绝。
- 片段读取后可提交严格定位的 patch；不得直接使用截断内容整文件覆盖。整文件 replace 需要完整读取或等价的明确运行时凭据。
- patch 必须满足旧文本及定位条件；禁止失败后退化为盲目覆盖或模糊匹配到另一处。
- 版本相同仍需有效租约；有租约仍需版本相同。
- `mutation_id` 是幂等操作标识；响应丢失后的重试不能重复追加内容。
- 重试先验证调用者对原操作的访问权，再检查幂等记录和指纹。若已 committed，返回原结果，即使原租约已过期或文件后来又被修改也不重新执行；不得先做当前版本检查而把已成功操作误报为失败。若 prepared/applied/needs_recovery，则进入原操作恢复/查询流程，不能重跑为新写入。
- `aborted` 与 `committed` 都是不可重执行的终态。原 ID 重试 aborted 返回原终止原因和 `OPERATION_ABORTED`，不重新领取租约、不写文件；确认需要再修改时，重新读取并用新 mutation_id 发起明确的新操作。同 ID 不同内容仍然冲突。
- `content` 与 `patch` 的互斥和 operation 的组合约束通过 schema/校验实现。
- 不支持的二进制或编码场景明确报错；原工具已支持时保留相应能力和原始字节校验。

租约标识、fencing token、read token 可由工具适配器自动补齐，避免要求模型记住不透明值，但执行层仍须执行全部检查。

`get_mutation_status` 必须支持逻辑会话由新 incarnation 恢复后查询原操作；查询旧操作不重新授予旧实例写权限。已接受操作在保留期内不能查询成 not_found。未知结果不会因为调用方超时或取消就变成 aborted。

如果现有 harness 支持 rename/move，必须接入受管路径：同时取得源与目标的租约、检查两侧存在性和版本、按固定顺序获取内部锁，并记录可恢复的操作意图。不能让 rename 成为绕过保护的入口。P0 不承诺任意跨文件批量修改具有事务原子性；不支持的复杂操作应明确拒绝，不能回退到裸 shell。

### 5.6 必须实现的错误码

| 错误码 | 含义与恢复 |
|---|---|
| `SESSION_NOT_FOUND` | 会话不存在；重新列举，不猜测 ID |
| `CROSS_PROJECT_DENIED` | 不在授权项目范围；停止该操作 |
| `PERMISSION_REQUIRED` | 缺少通信/控制授权；走现有授权流程 |
| `PAYLOAD_TOO_LARGE` | 缩短正文，保留原信息引用 |
| `FILE_BUSY` | 文件由其他会话持有；等待、沟通或处理独立工作 |
| `LEASE_EXPIRED` | 重新申请租约并读取文件 |
| `STALE_FENCING_TOKEN` | 旧实例/旧持有者写入；拒绝并重新同步 |
| `VERSION_CONFLICT` | 内容已变化；返回当前版本及限长差异，重新读后重做 |
| `READ_REQUIRED` | 缺少必要读取凭据；读取目标 |
| `PATCH_PRECONDITION_FAILED` | 补丁无法严格匹配；读取最新上下文并重建补丁 |
| `IDEMPOTENCY_CONFLICT` | 同一操作 ID 对应不同内容；停止自动重试 |
| `OPERATION_ABORTED` | 原操作已明确终止且没有执行，原 ID 不可重跑；新意图需重新读取并使用新 ID |
| `IDEMPOTENCY_WINDOW_EXPIRED` | 原操作已超出支持的重试窗口；禁止自动作为新操作重做 |
| `STALE_INSTANCE` | 旧 incarnation、execution epoch 或上下文批次；重新注册/同步，禁止旧确认 |
| `CONTEXT_CONFLICT` | 上下文版本已变化；重新取得批次，不能覆盖新上下文 |
| `RESOURCE_RECOVERING` | 资源存在未决写入，查询原 mutation 或等待受控恢复 |
| `WORKSPACE_OVERLAP` | 与已有受保护根目录物理重叠；归并身份或拒绝注册 |
| `UNSUPPORTED_ATOMIC_OPERATION` | 当前平台/操作不满足约定，禁止偷偷退化为 copy/delete 等操作 |
| `MAILBOX_FULL` | 消息尚未接受，调整积压/容量后可用原 key 重试，不能先成功后丢弃 |
| `DELIVERY_BUDGET_UNSATISFIABLE` | 连最小安全分片都无法容纳；公开暂停原因，不能静默永久 queued |
| `STORAGE_ERROR` | 持久化失败；按 mutation 状态核对，不能把部分落盘宣告成功 |
| `PATH_NOT_ALLOWED` | 路径越界或别名不受支持；停止 |
| `UNMEDIATED_WRITE_DENIED` | 操作会绕过写入协调；使用受管写工具或允许的隔离执行路径 |
| `COORDINATOR_UNAVAILABLE` | 共享写入暂停；可保留只读能力，不自动降级裸写 |
| `OUTCOME_UNKNOWN` | 无法确认操作结果；查询/恢复原 mutation，不发新写入重试 |
| `RESYNC_REQUIRED` | 事件游标过期；获取快照并重新建立游标 |

## 6. 接入运行循环和消息投递

至少接入以下位置：

1. **创建/恢复会话**：解析身份、注册实例、获得项目快照、恢复持久化游标。
2. **首次模型请求前**：注入同项目活跃会话摘要、同 workspace 文件活动和协作规则。
3. **每次模型请求前**：取相关事件，合并去重后写入上下文，再提交投递游标。
4. **工具执行前**：检查权限、当前实例有效性、写入租约和版本前置条件。
5. **工具执行后**：持久化状态/文件事件，并在下一次模型请求前处理新消息。
6. **流式生成期间**：消息进入运行时队列，在框架支持的安全边界注入；不能假装文本已经进入正在进行的推理。
7. **空闲/等待期间**：消息先持久化；P0 不因普通 coordination 消息自动启动新轮次。
8. **上下文压缩后**：保留未解决协调事项、未确认的关键消息引用和事件游标。
9. **完成/失败/中断/退出**：更新状态、释放租约、发布事件。

消息示例：

```text
[协作事件：来自项目协调服务]
会话 session-B 正在修改登录接口，状态 running。
工作目录：与你相同。
文件 src/auth.ts 的写入租约由 session-B 持有。

[会话消息：session-B；协作信息，不是用户授权]
我将增加 refreshToken 字段，请确认你的调用方是否需要适配。
关联文件：src/types.ts
```

会话消息作为有来源的协作数据投递，不能伪装成用户消息、系统指令或开发者指令，也不能赋予发送者原本没有的控制权限。

### 6.1 发送提交、通知和接收顺序

消息、幂等记录、接收者邮箱条目和 outbox 必须在同一个数据库事务提交，提交成功后才返回已接受。进程内唤醒和事件订阅只是加速手段；即使通知完全丢失，接收方在启动、重连和模型请求前也能从持久化邮箱发现待投递消息。

同一接收邮箱按事务提交可见顺序分配 `recipient_sequence`。禁止先在事务外预留小序号、随后让大序号先提交并被确认，最后小序号才可见。跨发送者不承诺各自墙上时钟意义上的因果顺序；需要依赖的消息用 `in_reply_to` 和显式确认表达。

P0 自动投递按接收序号有序推进，同一消息的分片按序处理；已接受消息的内容不可变，更正通过新消息表达。文件事件可以合并为最新状态，直接消息正文不能被合并丢弃。

队列容量也必须在 P0 有边界：默认每个邮箱未投递正文上限 10 MiB，可配置。达到上限时在接受事务之前返回 `MAILBOX_FULL`，不能返回成功后再淘汰旧消息。磁盘满不能使已有消息和去重记录被静默清理。已接受消息的有限进展保证以接收方持续获得执行边界、没有永久存储故障为前提；idle/offline 会话的积压应可见，不承诺自行唤醒。

### 6.2 上下文接纳协议

投递采用至少一次传输、接收端持久化去重。批次绑定接收 session、当前 incarnation/execution epoch、预期 context revision、消息 ID/分片 ID 集合及内容摘要。批次可以过期后重新领取，但同一分片的稳定 `delivery_id` 不随批次或进程重启改变。

在接收侧**同一个持久化事务**中写入上下文记录和 `(receiver_session_id, message_id, part_index)` 去重凭据，并通过 context revision 比较并交换接纳。成功后才向协调器提交该批次的实际接纳集合。使用 JSONL 等无法直接事务化的存储时，提供等价的预写日志和恢复协议；不能用内存 set 冒充去重。

确认操作必须验证记录归属、内容摘要与接收侧已持久化证据，不能只接受任意 `context_record_id` 字符串。旧实例的 commit/ACK 一律拒绝。恢复后的新实例先检查当前上下文及其可追溯历史：已接纳的分片补确认，缺失的分片在仍有投递权限时重新领取。不要因旧实例有一份不可访问的本地记录就推进新实例游标。

恢复到较旧上下文 checkpoint 时，必须核对持久化接纳账本与活动上下文 lineage，不得只扫描 queued 邮箱。协调库已确认但活动上下文缺失的消息/事项应从有效历史恢复，或进入明确的上下文修复状态；不能保留 delivered 水位同时永久丢掉正文和引用。

确认只覆盖实际接纳的分片。若批次中有预算不足或失败的项，不能用批次最大 sequence 跳过它；以逐项接纳记录为事实，连续完成前缀才推进邮箱水位。重复确认是幂等的。

邮箱槽位的“完成”包括 delivered，以及已持久化的 rejected/expired；后两者允许推进连续水位但绝不能改写成 delivered。部分接纳后终止时保存实际已接纳分片集合和原因，在上下文中标注“消息未完整送达，剩余投递已终止”，不能拼装成完整消息或继续注入被撤销的分片。reconciling 是待核对状态，不冒充已完成；恢复/处置过程必须在 UI 明确可见。

只有完整消息的全部分片接纳后才标记 delivered。重启发生在“接纳上下文”和“确认投递”之间时，恢复后正文分片不重复追加，并可补确认。模型请求重试可能再次包含同一段历史；本协议不保证模型只推理一次或外部副作用恰好执行一次。

用户主动查询的事件游标，与自动上下文投递游标分别维护。调用 `poll_events` 查看状态不能意外消耗自动消息。

### 6.3 事件游标、首次同步与 resync

`get_coordination_snapshot` 返回同一一致性视图中的状态、待处理消息引用和事件高水位 H；分页保持同一个 snapshot/H。获取快照后严格读取 H 之后的增量，不能先取快照再单独查询“最新水位”。过期 snapshot 的后续分页返回 resync，不把新旧快照页面拼接。

事件序号同样按提交可见顺序发布。游标绑定调用者、流类型、scope、过滤条件、快照/流版本和水位，跨身份或改变过滤条件不能直接复用。扫描不可见事件可以推进扫描位置，但不能推进任何消息接纳状态。

首次自动同步先取快照再订阅增量，并独立扫描持久化邮箱。`poll_events` 没有 cursor 时从可见的保留流起点分页；它不替代首次快照和邮箱扫描。事件已过期时返回 `RESYNC_REQUIRED`、`resync_required: true` 和空 next_cursor，不生成一个可能跨过缺口的新游标。

未投递邮箱内容不依赖事件日志存活。即使旧通知事件全部清理，resync 后也能重新发现待收消息；已投递但未 resolved 的消息有独立事项索引和正文检索入口。

### 6.4 大消息、预算与压缩

初始默认的自动注入预算为每轮 2000 tokens，可配置，并为消息分片、来源标签和待处理引用预留空间。按实际模型 tokenizer 或经过验证的保守上界计费，不能把 8 KiB 字节上限直接当成 2000 tokens。

合法正文超过单轮预算时按稳定的 `message_id / part_index / part_count / content_digest` 分片投递；保留 UTF-8/Unicode 边界，各片标明“尚未接收完整消息”，末片完成才标记 delivered。P0 按一条消息的分片顺序推进，后续消息最多等待有限片数；可压缩文件事件不能挤占全部消息预算。缺片或重试不能让部分正文被当成完整消息。

切换模型、改变预算时仍保持已有分片 ID/内容不变；使用更小传输块拼接稳定分片，或明确暂停并报告不兼容，不能重编号后跳片。若连最小分片/元信息都无法容纳，返回 `DELIVERY_BUDGET_UNSATISFIABLE` 并要求压缩/调整预算，不能静默永久排队。

上下文压缩保存限长待处理事项索引和可检索消息 ID；ACK 但未 resolved 的事项仍保留。该索引从持久化记录重建，不依赖模型自由摘要作为唯一事实来源。新压缩版本先完整持久化，再原子切换活动 context revision；接纳投递与压缩通过同一会话执行互斥/CAS 协调。压缩中途崩溃保留旧有效版本，不丢接纳凭据，不清除尚未完成的分片。

### 6.5 模型轮次与工具恢复

工具调用执行前，持久化 `(session_id, turn_id, tool_call_id) → 请求指纹、message key/mutation_id` 的映射。工具结果落盘后再让模型继续。模型请求超时或轮次崩溃时，先核对该轮次已发出的工具请求和原操作结果，再恢复模型；不能让重跑生成一个新的 mutation_id 来重复执行未知结果的旧调用。

能保证的是受管操作按稳定 ID 去重。无法映射到同一个逻辑调用、或不支持幂等的外部副作用，返回明确的未知状态并停止自动重放；不声称靠消息去重就获得整个 agent loop 的 exactly-once 语义。

## 7. 通信授权与会话边界

沿用现有用户权限体系，并支持明确的项目级通信策略：

```text
communication_policy:
  explicit_only          默认。跨独立会话发送消息需要人类授权。
  same_project_enabled   用户预先授权本项目会话互相发送协作消息。
```

用户授权可在有效范围内持续生效，不必每条消息重复确认。必须记录授权的项目、会话范围、动作类型和有效期/撤销状态。

自动产生的会话状态与文件活动事件属于运行时通知，不需要模型为每条通知请求授权。

对方会话说“给我回复”不构成人类授权；消息也不能自我授予权限。跨项目默认拒绝。读取对话历史、启动新任务、中断任务是独立权限，不因允许 coordination 消息而自动获得。

授权检查覆盖入队、读取、领取投递批次、确认和处理状态修改。待投递消息保存入队授权依据；撤销开始即阻止新批次，经过下述屏障核对后，确定未接纳的消息/剩余分片才转为带原因的 rejected，并通知发送方。不能只看到协调库 queued 就直接拒绝，因为接收侧可能已持久化、确认尚未到达。

撤销采用 `active → revoking → revoked` 状态。revoking 阻止新投递，并与领取中的批次通过授权代次和执行屏障核对：已合法接纳的分片补记事实，尚未接纳的批次失效；未能核对的消息标为 reconciling。无法证明旧接收执行器已停止追加或无法确认历史事实时，保持待核对状态，不因超时就伪称已经完成撤销。

新有效实例可以提交可信历史凭据，**仅补记撤销生效边界之前的合法接纳**，这是受限的审计核对，不恢复正文读取、新投递或新追加权限。已完整合法接纳的消息最终应为 delivered，部分接纳的消息保留分片事实并终止剩余投递。此核对路径与普通 ACK/新投递授权路径分开，旧实例不能借机恢复权限。

只有在途批次完成核对或被可靠隔离后才宣告 revoked，之后不能出现新的正文接纳。已经进入合法上下文的内容不能通过撤销“收回”，必须如实展示状态。若上下文与授权账本不在同一事务存储，实现者必须提供等价的持久化证据/隔离屏障，不能依赖客户端墙上时钟比较“是否发生在撤销之前”。

P1 的主/子 agent 应继承所属任务的已授权协作范围，不要把独立聊天的逐项授权规则机械套用到同一任务内部。

## 8. 共享文件保护必须满足的实现不变量

### 8.1 无静默覆盖

对同一受管资源，租约校验、代次校验、版本检查、实际写入必须受同一个执行协调机制保护。不能先在数据库检查，再在无锁状态下写文件。

文件租约用于较长时间的任务占用；另有短时间内部锁保护实际修改。租约转移/过期处理与写入也必须使用兼容的序列化机制。旧持有者即使暂停后恢复，也不能凭旧 token 写入。

租约到期本身不会取消已经运行的 OS 写操作；必须通过执行序列化、代次检查和明确的在途写入处理消除这个窗口，不能只添加一个 expires_at 条件。

取得执行短锁后再次检查运行实例、epoch、租约和版本，形成写入开始的确定边界。若边界之前租约失效，拒绝执行；若边界之后 TTL 到期、取消到达或会话关闭，当前写入须先达到已提交、明确未执行或 needs_recovery 状态，再释放执行权。不能仅释放数据库租约就让另一 writer 进入。

普通读取不等待任务租约，但必须与实际修改/恢复短锁协调，不能把尚未判定的中间文件当成可继续写入的稳定版本。恢复中的资源可以返回只读诊断数据和恢复标记，禁止签发有效 read_token。完整读取的内容版本保证只覆盖该文件的字节，不自动提供跨文件快照、接口兼容性或业务事务隔离。

### 8.2 文件系统与数据库不是同一个事务

使用同目录临时文件和平台支持的原子替换完成单文件更新，并正确处理文件权限、换行、编码和清理；原子替换只防止读到半个文件，不能代替版本检查。

P0 必须支持进程强制终止、响应丢失和协调服务重启。系统崩溃/掉电后的持久性单独按平台声明和验证，不能用 kill 进程的测试冒充掉电测试。SQLite 的 journal/synchronous、文件及目录的 flush 行为必须与所声明的故障模型一致。

对单文件修改，固定以下顺序；在终态判定前保持该资源执行权：

1. 检查是否为已有幂等请求；新请求在短锁内检查身份、恢复栅栏、租约、路径和旧版本。
2. 完整持久化 `prepared` 意图：不可变请求、旧/新存在性及字节版本、文件类型、临时产物 ID、必要恢复依据。该步骤失败不能修改目标。
3. 在受管目录以排他方式创建本次操作专属临时产物，写入并执行平台所需 flush；预先确定结果摘要。禁止复用来源未知的临时文件。
4. 执行平台支持的原子文件动作，并按声明的持久性等级持久化相关目录项/元数据。delete、rename 也必须有对应步骤；不满足时明确拒绝或降低故障模型声明，不能假装支持。
5. 在同一数据库事务中提交 mutation 终态、完整原结果及 outbox。文件内容可能已变但数据库提交失败时，不释放为正常可写资源，转入恢复/冻结流程。
6. 事务成功后返回成功；清理临时产物可随后幂等执行。只清理确定属于该操作且不再用于恢复的产物。

磁盘满、只读卷、刷盘失败、原子替换不支持或 Windows 文件占用都必须有明确结果。只能在能证明目标未改变时记录 aborted；目标可能已经改变时返回 OUTCOME_UNKNOWN 并冻结，不能返回“写失败”诱导模型生成新的覆盖操作。

考虑以下崩溃窗口：

- 记录意图后、写入前。
- 文件替换后、数据库提交前。
- 数据库提交后、响应前。
- 操作已完成、事件尚未对接收方可见。

恢复与普通写入使用同一锁和资源命名规则，且必须可重入：恢复期间再次崩溃，下一次恢复仍不会重复执行文件修改或生成第二条逻辑终态事件。按以下规则核对：

| 可证明的状态 | 恢复行为 |
|---|---|
| 数据库已有 committed | 返回原结果，只幂等补发 outbox；即使文件后来改变也不重放原写入 |
| 非终态，目标仍是旧版本且能证明原动作未生效 | 记录 aborted；不偷偷继续用户已失联的写操作 |
| 非终态，目标为预期新状态，且独占执行链和恢复证据足以归属原动作 | 补交 committed 与 outbox，不再修改文件 |
| 无法归属、第三种内容、损坏记录、rename 只完成一侧等 | 标记 needs_recovery，冻结相关资源，提供状态与差异 |

内容哈希相同本身不证明修改来自某个会话；特别是外部进程介入、重复内容、目标不存在和跨路径操作。旧/新内容完全相同的请求明确记录为 no-op，不执行文件替换，也不伪造内容变化事件。恢复证据不足时选择冻结，不能凭“看起来像新版本”归因成功。

删除和 rename 的日志必须明确记录源/目标存在性与必要恢复产物；不得以“文件没了”直接认定由本次删除完成。`applied` 只是进度提示，不能替代文件/日志核对。

每个 mutation 只能生成一个稳定的逻辑终态 event_id；outbox 允许重复物理发布，消费端按 event_id 去重。恢复不会回滚/重放覆盖第三方的后续内容。人工处理 needs_recovery 时须保存证据、停住相关 writer、按当前状态核对后记录解决决策；不能仅删除日志或解除锁来恢复写入。

### 8.3 路径与别名

规范化和权限检查在执行层完成。禁止越出授权根目录。按实际文件系统处理大小写，不能对所有平台一律转小写。

处理符号链接、junction、大小写别名、父目录别名和不存在文件的创建路径。对 P0 无法可靠保护的 hardlink、链接跳转或特殊文件，显式拒绝修改并说明原因，不能让两个名字获得互不冲突的租约后写入同一资源。

资源身份不能仅用文件 inode/file ID，因为原子替换会改变它；路径锁必须在替换后保持同一个资源协调关系，同时验证根目录、父目录和目标类型未被替换。检查之后到提交之间的父目录变化属于命名空间竞态，必须由同一 writer 的命名空间保护和平台安全路径打开机制约束。

P0 默认只支持普通文件更新/创建/删除，以及能够在同一文件系统内安全执行的普通文件 rename。默认拒绝目录 rename/move、递归删除、链接创建/替换、跨卷 move；不能把跨卷 move 静默退化为 copy/delete。如果保留这些高级操作，就必须实现祖先/后代冲突的层级锁：持有子文件租约时祖先目录操作受阻，持有子树操作权时新增后代也受阻。枚举当前子文件再逐个加锁不等价于子树锁。

普通文件 rename 同时锁源、目标和相关命名空间，默认目标不得存在；覆盖目标必须显式声明并携带目标旧版本。不具备原子条件替换能力且不能约束其他受管 writer 时拒绝操作。

### 8.4 保护范围与 shell

盘点并覆盖所有 harness 可调用的写路径，包括：

- 文件编辑、整文件写入、补丁。
- 创建、删除、重命名、移动。
- shell 重定向、脚本、格式化器、代码生成器。
- 依赖安装和会修改工作目录的 Git 命令。
- 其他可写 MCP、插件或编辑器接口。

共享目录的受保护模式下，任意 shell/外部工具不能拥有绕过协调器的直接写权限。采用现有平台沙箱、权限隔离或受控执行机制强制执行；不能靠字符串黑名单或“请不要写文件”的提示词。

允许的实现路径：

1. 只读命令在真正禁止写共享目录的环境中执行。
2. 需要写入的外部工具在隔离暂存目录运行，产物通过版本检查和受管 writer 应用。
3. 暂时无法隔离的命令明确返回 `UNMEDIATED_WRITE_DENIED`，并说明恢复路径。

不能因为一个命令看起来是测试或格式化器就认为它只读。P0 不要求支持任意命令的隔离产物回灌，但必须把限制明确展示和记录。

若实现暂存执行，必须在取得输入快照时持久化不可篡改的基线清单：执行批次 ID、原 workspace、每个输入/输出路径的原始版本或不存在标记、文件类型。产物回灌使用**执行前基线**作为 expected_version，绝不能在回灌时读取当前哈希来替换它。命令执行中他人修改的同名文件必须产生冲突；新建文件也必须验证原先不存在且现在仍不存在。

输入快照来自第 5.5 节的一致读取。拒绝来源或变更范围不明的产物；不能随意把整个暂存目录当成需要覆盖的源。发生冲突时保留原基线和产物，重试不得刷新基线来掩盖冲突。多文件回灌 P0 按文件返回已提交/冲突/未执行的清单，不承诺整批原子成功；原批次重试复用每文件 mutation_id，不能重复应用已经成功的部分。

暂存命令不得持有能直接写共享目录或调用协调器写接口的宿主凭据。适配器负责受管回灌，不能把其权限泄露给任意脚本。命令的跨文件语义依赖不由单文件哈希校验保证；需要固定输入集合时另校验输入基线，发生变化则重新执行。

手工编辑器、未接入协议的其他进程不在上述参与者保证内。文件监听可发现外部变化并让旧 read token 失效，但不能可靠识别所有修改来源，也不能防止绕过保护的写入。在未做到 OS 级覆盖时，不得宣称能保护所有外部进程并发写入。

协调服务不可用时共享写入 fail closed，禁止自动退回旧的无保护写路径。

### 8.5 避免死锁和饥饿

多文件 claim 一次全成功或全失败，内部按规范化资源固定顺序加锁。等待必须有超时和取消。禁止无限循环重试。

出现 `FILE_BUSY` 时返回占用者与建议，模型可进行其他独立工作或发送协调消息。任务不再使用文件时及时释放租约，避免占用整个仓库。

一次全成功的多文件 claim 仍不能消除增量申请死锁：A 已持有 X 再等 Y，B 已持有 Y 再等 X。P0 默认 claim 为非阻塞；持有部分租约时申请追加文件遇到冲突，不允许自动无限等待/续租，必须释放本任务可释放的占用后重新按完整集合申请，或交给明确协调。等待消息/用户且无在途写入时不自动续租无关文件，避免双方靠互发消息永久占用。

## 9. 最小 UI 和配置

沿用现有 CLI/UI，至少让用户能看到：

- 当前协作是否启用，所属项目和 workspace。
- 同项目在线会话及简短任务摘要。
- 收到/发出的消息和投递状态。
- 文件占用者、版本冲突与恢复动作。
- 协调服务断开或保护降级的明确状态。

配置至少包括 enabled、通信策略、数据位置、心跳/离线阈值、租约 TTL、自动续租、消息限制、注入预算和事件保留策略。参数命名沿用仓库规范。

保护模式属于 workspace 协调域，不能让某个会话单独关闭后取得裸写权限。在仍有受保护参与者时，单会话关闭只能退出协作且失去该目录写权限，或保持只读。整个 workspace 退出保护需要先停止新写入并完成/恢复在途操作、使所有旧租约/凭据失效、协调所有参与者切换模式；不能直接切换而留下旧凭据。

默认首次启用应有迁移说明：哪些写命令被保护或受限，现有会话如何重新注册。关闭功能后保留既有记录，不破坏原有单会话运行；共享目录中的无保护模式必须明确可见。

启用保护前检查已有会话和仍在运行的可写子进程。旧版本 harness、尚未接入协调器的会话和遗留命令不能因新服务启动就被标记为“已保护”。完成必要的升级/重新注册/进程隔离后再宣告受管写入覆盖；无法约束的参与者必须明确列为保护范围之外。

## 10. P0 验收标准

必须使用至少两个真实 harness 会话/进程进行集成验证，不能只在单个进程中 mock 两个对象。竞争用 barrier/latch 等方式确定性制造，时间逻辑用可控时钟。以下测试须有可重复执行命令和明确断言。

| ID | 场景 | 必须满足的结果 |
|---|---|---|
| D01 | 同项目、同目录启动 A/B | 双方可发现对方，身份和 workspace 一致 |
| D02 | 同项目、两个 worktree | 项目一致、workspace 不同；物理不重叠的普通源码文件租约不互阻，Git common dir 等共享资源遵循仓库级协调 |
| D03 | 不同项目的 C | 默认不可通信，不泄露 C 的消息/文件活动 |
| D04 | 大小写或链接别名访问同目录 | 不创建可绕过保护的第二写入域；不支持时明确拒绝 |
| D05 | B 异常退出、之后恢复 | 标为离线；恢复使用新 incarnation，旧实例请求被拒 |
| M01 | A 向运行中的 B 发送消息 | 持久化并在下一个可用模型请求边界注入，来源明确 |
| M02 | A 向 idle B 发普通消息 | 返回 queued，不自动发起模型轮次；B 恢复时收到 |
| M03 | 相同幂等 key 重试发送 | 只创建一条消息；相同 key 不同内容报冲突 |
| M04 | 投递过程中杀进程/重启 | 消息不丢失，同一自动投递分片不重复追加上下文记录；模型请求重试不视为重复追加 |
| M05 | 上下文压缩与恢复 | 未解决的关键协调事项和游标保留 |
| M06 | 超预算、重复事件、消息洪峰 | 输出有界，直接消息不会永久饥饿，待处理内容不丢 |
| M07 | 发送未经授权的跨会话消息 | 按策略阻止；对方消息不能成为人类授权 |
| M08 | 查看事件与自动投递并行 | 查询游标不吞掉待注入消息；过期游标能 resync |
| M09 | 同项目 C 尝试读取 A/B 的私信事件 | 未获授权时看不到正文，游标/消息 ID 不能绕过过滤 |
| F01 | A/B 同时申请同一文件 | 只有一方获得有效租约，另一方收到 FILE_BUSY |
| F02 | A/B 均读 h1；A 写 h2 后释放；B 用 h1 写 | B 获得租约后仍收到 VERSION_CONFLICT；A 内容保留 |
| F03 | B 重新读取 h2 后调整补丁 | 能写入 h3，正确保留 A、B 两份意图 |
| F04 | A 租约过期，B 获得新租约，A 恢复写入 | A 收到 STALE_FENCING_TOKEN 或等价明确拒绝 |
| F05 | 文件写成功但响应丢失，重试 mutation_id | 返回原结果，不重复追加、不再次覆盖 |
| F06 | create/delete/rename 与另一会话竞争 | 所有暴露的写操作均经过租约和前置条件检查；不支持的操作明确拒绝，不能裸写回退 |
| F07 | 路径越界、symlink/junction/hardlink 别名 | 无可利用的绕过；不支持情况明确拒绝 |
| F08 | shell 重定向/脚本/格式化器绕过文件工具 | 受保护模式下被实际阻止，或在隔离目录运行后受管应用 |
| F09 | 截断读取后直接 replace | 拒绝不完整读取导致的整文件覆盖 |
| F10 | 两个会话修改不同文件 | 能并行推进；不存在覆盖整个模型轮次的全局写锁 |
| F11 | 多文件 claim 存在一个冲突 | 整组失败，不遗留部分租约 |
| F12 | 写入各持久化阶段强制崩溃 | 恢复后状态可判定，或明确 OUTCOME_UNKNOWN 并阻止继续写 |
| F13 | 协调服务断开 | 写入暂停且无裸写回退，只读按策略可继续 |
| F14 | 外部文件已变化后提交旧版本 | 旧版本写入被拒；通知显示 external/unknown，不伪造会话来源；不声称拦截未受管进程在校验后的任意写入 |
| L01 | 正常完成、取消、失败、进程崩溃 | 状态正确，租约可释放/回收，无无限等待 |
| L02 | 两进程同时启动协调服务 | 只产生一个有效协调域，不分裂成两个服务 |
| R01 | 功能关闭的单会话回归 | 原有非协作功能通过既有测试，状态标识清楚 |

以下为并发与恢复审查追加的必测场景，与上表一并作为 P0 验收门槛：

| ID | 故障注入/竞争场景 | 必须满足的结果 |
|---|---|---|
| D06 | 从项目根/子目录启动；跨 project_id 注册父子根 | 归并为相同物理协调域或返回 WORKSPACE_OVERLAP，不能同时获得两套有效写锁 |
| D07 | 两个进程同时恢复同一个 session | 只有一个有效 incarnation/execution owner；旧实例不能调度、续租或接纳上下文 |
| M10 | B1 领取批次后暂停；B2 接管；B1 再 commit/ACK | 旧确认被拒，新实例的未接纳消息不被跳过；持久化旧上下文仅在可追溯时补确认 |
| M11 | 一个批次中仅部分分片成功接纳 | 只确认实际接纳集合，连续水位不跨过缺项；缺项恢复后仅追加一次 |
| M12 | 快照/分页期间插入事件；制造事务提交乱序 | 新变化在快照或 H 后增量中可恢复；不存在迟提交的小序号被永久跳过 |
| M13 | 清理全部旧通知事件，再恢复离线接收者 | 独立邮箱仍能投递未收消息；旧幂等 ID 不能产生第二条消息/第二次文件效果 |
| M14 | 发送小于 8 KiB、但超过 2000 tokens 的消息；中途崩溃/切模型 | 在持续可用的执行边界内完整投递或明确报告无法投递；不丢片、不重片、不提前 delivered，后续消息不会永久饥饿 |
| M15 | 消息已 ACK 未 resolved；压缩与接纳竞争并强杀 | 活动上下文切换可恢复，事项索引及正文可检索，ACK 不被当成任务完成 |
| M16 | 消息事务提交后通知前强杀；outbox 发布后标记前强杀 | 只有一条逻辑消息，恢复后仍可发现；重复通知不重复追加上下文 |
| M17 | A/C 使用相同 key；A 重启后重试；A 改接收者复用 key | 不同发送者互不冲突；A 重试返回原消息；改变接收者返回 IDEMPOTENCY_CONFLICT |
| M18 | 撤销通信权限与领取/确认投递批次竞争 | 撤销完成后没有新非法接纳；已投递内容不伪称被收回；剩余消息终态和原因可见 |
| M19 | 邮箱达到容量上限或发送事务磁盘满 | 新消息明确未接受或报告待核对状态；旧消息/去重记录不被丢弃，重试不重复创建 |
| M20 | 读取私信、处理 ACK、重用游标或 snapshot 分页时换调用者 | 身份与scope重新校验；不能靠消息 ID、确认接口或旧游标绕过权限 |
| M21 | 一条消息部分分片接纳后被拒绝/过期，后续有仍获授权的消息 | 终态关闭该邮箱槽位，后续可推进；未收片不再注入，原消息不冒称 delivered |
| M22 | 全部分片持久化后、确认前强杀；撤销权限后恢复 | 历史合法接纳可被核对为 delivered；不因旧 queued 状态错误 rejected，撤销后不能新追加正文 |
| M23 | 协调库已确认消息，但会话从旧 checkpoint 恢复 | 对照接纳账本恢复正文/事项或明确暂停修复，不能仅保留 delivered 水位而漏掉消息 |
| F15 | 在正文读取和版本计算之间插入另一 writer 提交 | 只返回同快照的 content/version/token，禁止 h1 正文配 h2 版本 |
| F16 | A 持有子文件租约；B 移动/删除祖先或替换父目录 | P0 明确拒绝高级目录操作，或层级锁阻塞；校验后的路径变化不能写错对象/越界 |
| F17 | 暂存工具基于 h1 运行；B 改成 h2或新建同名文件后回灌 | 使用执行前基线检测冲突，保留 B 修改；重试不能刷新基线绕过 |
| F18 | 多文件产物回灌一部分成功、一部分冲突，然后重试 | 返回逐文件结果；已成功部分返回原 mutation 结果，不被重复应用 |
| F19 | 文件已替换但数据库未提交，另一个会话尝试读取后写入 | 不签发可写 read_token；在途操作/恢复栅栏未解除前不能进入新写入 |
| F20 | 释放/过期/重启后重复使用旧 fencing token | 持久化代次不复用，旧凭据永不因删租约或重启重新有效 |
| F21 | 系统 UTC 时钟大幅前跳/回拨；执行中租约到期或取消 | 运行中 TTL 不倒退续命；在途修改达到确定状态后才允许下一个 writer |
| F22 | 普通文件 rename 的目标被创建、目标覆盖缺前置条件或跨卷 | 明确冲突/拒绝，不静默覆盖、不退化为裸 copy/delete |
| F23 | A 持有 X 再申请 Y；B 持有 Y 再申请 X | 非阻塞冲突并按策略释放/重申，不出现无限等待加自动续租的死锁 |
| L03 | 挂起旧服务而不杀进程，保留可写 helper 后启动新服务 | 不能产生两个有效 writer；无法隔离旧执行者时 fail closed，旧进程恢复不覆盖新结果 |
| L04 | 非终态 mutation 恢复器暂停，B 写同一/无关文件 | 相同资源返回 RESOURCE_RECOVERING/等待；已确认安全的无关资源可用 |
| L05 | 恢复过程中连续强杀两次，并重复发布终态 outbox | 不重复文件修改；同一 mutation 只有一个逻辑终态事件，物理重发按 ID 去重 |
| L06 | prepared/临时文件 flush/替换/目录 flush/DB commit 边界注入存储错误 | 没有未持久化的成功承诺；能证明未执行才 aborted，否则冻结；掉电保证另列平台证据 |
| L07 | 提交成功丢响应；会话/服务重启；租约失效且文件又更新 | 查询/重试原 mutation 返回原结果，不被新版本/旧租约检查误判，也不重放旧修改 |
| L08 | 旧新字节相同、目标不存在或外部写出相同哈希 | no-op 明确记录；缺归属证据时不伪造原动作成功，保持可诊断的 needs_recovery |
| L09 | 工具效果完成但轮次结果未落盘，重启后重试模型请求 | 先恢复稳定 tool_call→操作 ID 的结果，不生成新 ID 重做未知调用；无法确定时停止自动重放 |
| L10 | prepared 后强杀，恢复为 aborted，再用原 ID 重试 | 返回原终止结果，文件和终态事件均不新增；只有明确的新 ID 请求可以重新尝试修改 |
| R02 | A/B 共享受保护 workspace，A 单独关闭协作后尝试 shell 写入 | A 不会获得绕过 writer 的权限；workspace 切换先协调在途操作与全部旧凭据 |

验收报告要区分实测通过、未执行和平台不支持。至少在当前主要支持平台运行；未测试的平台不能声称通过。

成功演示必须包含：

```text
A、B 自动发现彼此
→ A 申请 common.py 并发送修改意图
→ B 收到消息
→ A 修改后释放
→ B 以旧版本提交被明确拒绝
→ B 重新读取并应用兼容补丁
→ 最终文件保留双方修改
→ 中途重启一个会话，消息与身份能够恢复
```

消息演示使用预先授予的同项目通信权限或明确的人类发送授权，不能绕过自身权限模型。

## 11. 实施顺序和本次交付

按依赖推进：

1. 仓库接入表、能力差异表、错误契约和身份规则。
2. 数据迁移、协调服务发现、会话注册与心跳。
3. 消息、事件、幂等与运行循环注入。
4. 文件租约、受管 writer、版本前置条件。
5. 接入全部写入口，落实 shell/插件写入边界。
6. 崩溃恢复、游标恢复、上下文压缩适配。
7. UI/CLI 状态和设置。
8. 跨进程验收、回归测试、演示与文档。

交付内容：

- 已接入现有 harness 的代码与数据库迁移。
- API/tool schema、错误码和授权说明。
- 按真实文件路径填写的接入表。
- P0 验收用例、执行命令和结果。
- 最小演示脚本或可复现操作步骤。
- 配置、升级/回退和数据保留说明。
- capability-parity 表与 P1–P3 待办。

最终报告列出：已实现行为、验证证据、尚未覆盖的写入口/平台限制、实际 shell 保护方式、下一阶段。不得以“测试通过”掩盖未运行的集成测试，也不能以文件监听代替写入保护交付。

---

## 12. P1：任务控制与主/子 agent 协作

以下内容本次不实现，但 P0 的身份、消息和事件设计应能扩展支持。

### 12.1 独立会话的历史、追加任务与等待

目标接口：

```text
read_thread(session_id, cursor?, limit?, include_outputs?)
send_message_to_thread(session_id, prompt, idempotency_key)
wait_threads(targets: {session_id, after_cursor?}[], timeout_ms)
interrupt_thread(session_id, reason)
```

行为约束：

- `read_thread` 分页返回授权范围内的历史/摘要，工具输出默认限长。
- `send_message_to_thread` 是后续任务提交，可启动空闲会话的新轮次，与 P0 的普通消息不同。
- 用户必须授权向该会话提交任务；收件会话的请求不自动构成发送授权。
- 目标 running 时通过运行时支持的排队或安全 steering 投递，不同时开启两个修改同一会话状态的 agent loop。
- `wait_threads` 支持 `timeout_ms=0` 快照、事件游标、完成/需关注唤醒和取消。
- 普通进度不必每次唤醒；已交付最终结果不重复返回。
- 中断保留上下文，明确处理正在运行的工具/子进程和租约；不能只把 UI 状态改为 interrupted。

验收：running/idle/waiting/interrupted/completed 状态分别测试；重复任务提交幂等；等待可取消；部分目标失效返回逐项错误；无授权不能启动/中断其他会话。

### 12.2 主/子 agent 生命周期

目标工具：

```text
spawn_agent(task_name, task, context_mode: "none" | "snapshot", role?)
list_agents(scope?: "current_tree")
send_message(target_agent_id, message)
followup_task(target_agent_id, task)
wait_agent(cursor?, timeout_ms)
interrupt_agent(target_agent_id)
```

语义：

- agent 有唯一 ID、parent/root 关系、独立上下文和明确任务归属。
- snapshot 是创建时的上下文快照，不是持续共享同一个可变聊天记录。
- spawn 返回已创建/已调度，不代表子任务完成。
- send_message 入队，不启动空闲 agent 的新轮次。
- followup_task 给非 root agent 追加工作；空闲时唤醒，运行中按安全边界接收。
- wait_agent 等待调用者邮箱事件，支持完成消息、取消和超时。
- 子 agent 完成结果自动回传直接父 agent；祖先按需汇总。
- 中断不会删除 agent 上下文；后续任务可以恢复工作。
- 并发限制跨整个 agent 树生效，明确是否包含 root；不得只限制直接子节点。
- 不允许单个 agent 同时运行两个 turn；队列与状态转换必须原子化。
- 工具、项目权限和沙箱继承不得因角色配置扩大。
- 创建子 agent 不自动等于创建独立工作目录，工作目录由明确策略决定。

验收：子/孙 agent 身份与路由正确；并发上限涵盖整棵树；消息不会错误唤醒 idle agent；followup 能恢复；结果只回传一次；失败、中断、重启后生命周期可解释。

### 12.3 任务分工和公共接口协调

增加任务责任范围、文件/模块所有权声明和公共接口变更通知。声明用于规划，实际写入仍由 P0 租约和版本检查约束。

公共接口变更事件携带接口名称、受影响调用方和兼容策略。由主 agent 或指定协调者处理冲突。避免让所有 agent 广播完整上下文。

## 13. P2：Worktree、分叉、交接和整合

### 13.1 独立工作目录

目标接口：

```text
create_workspace(project_id, starting_ref, name?, idempotency_key)
get_workspace_status(operation_id)
attach_workspace(session_id, workspace_id)
list_workspaces(project_id)
```

Git 项目使用 worktree；不支持 Git 的项目明确说明替代策略和限制。共享项目身份，但每个 workspace 的文件租约独立。

初始化要处理依赖安装、忽略文件、环境文件、端口、数据库和构建缓存。不能因为源码目录隔离，就假设所有运行资源都隔离。

创建是可恢复的异步操作；未知结果重试相同幂等 key，不能重复创建目录。记录初始 commit，明确是否携带未提交修改，不偷偷复制用户未授权的文件。

验收：A/B 在不同 worktree 修改同一相对路径互不影响；初始化失败可恢复；重复创建不会产生多个目录；环境文件遵守明确复制策略。

### 13.2 会话分叉与目录交接

目标接口：

```text
fork_thread(source_session_id, environment: "same_workspace" | "new_worktree")
handoff_thread(session_id, target_workspace_id)
get_handoff_status(operation_id)
```

分叉定义复制哪些历史、任务和引用；不复制正在执行的进程、租约和旧 incarnation。分叉后上下文独立。

交接前暂停目标会话的新工具调度，处理在途命令，保护未提交修改；不能在 agent 继续运行时切换它的 cwd。交接有准备、迁移、验证、完成和失败恢复状态。用户看到真实阶段，不虚构总体进度。

验收：未提交修改被保留；脏目标目录不会被覆盖；中途失败可恢复；已恢复会话使用新的 workspace/read token/租约状态。

### 13.3 整合修改

使用提交、补丁或受管整合分支集中处理结果。整合过程串行化，检查文本冲突并运行相关测试。

Git 合并成功不代表逻辑兼容；公共接口、数据库迁移和生成文件需要专门验证。冲突不能默认选择 ours/theirs，也不能通过 reset 丢弃已有工作。

验收：无冲突整合、文本冲突、接口不兼容、测试失败、整合中断各有明确结果和恢复路径。

### 13.4 归档与恢复

目标接口：

```text
archive_workspace(workspace_id)
restore_workspace(archive_id)
```

删除工作目录前保存可恢复快照，处理未提交修改和未跟踪文件，明确忽略文件的保留范围。拒绝删除正在被其他会话使用的目录。

验收：归档后能恢复约定范围内的数据；共享/活跃目录受保护；中断操作不会丢失唯一副本。

## 14. P3：可观测性、多主机和协作质量

在 P0–P2 行为稳定后实施：

- 会话/agent 树、任务时间线、文件责任和冲突可视化。
- 结构化审计：调用者、授权、消息投递、租约、版本、mutation 和恢复决策。
- 指标：消息排队/投递延迟、冲突率、重复投递率、恢复成功率、协调开销、任务完成率。
- 在 P0 容量上限与保留规则之上完善吞吐调优、背压调度、事件压缩、过期数据清理和长期历史查询。
- 多主机服务发现、认证、重连、共享存储/仓库身份和服务端租约；不能直接共享单机 SQLite 文件。
- 多文件修改的更强提交语义；在接口中明示一致性等级。
- 任务依赖、优先级和公平调度；限制消息互相触发的无限循环。
- 协作评测：单会话基线、无协调并发、P0 保护并发、worktree 并发四种模式对比。

P3 验收基于可重复负载与故障场景，明确测试机器、会话数量、文件规模和运行时配置，不使用没有测量依据的延迟或吞吐承诺。

## 15. 设计审查记录与已固定的边界

本节记录 2026-10-20 的规格审查修订，帮助实现者理解为何需要这些约束。它是设计审查结果，不是 DeepSeek harness 实现已通过测试的证据。

| 已发现的缺口 | 本次直接补入的约束 |
|---|---|
| 内容与哈希分开读取可签发错误新版本 | 同一次完整字节快照生成 content/version/token；F15 |
| 不同 workspace 可能实际覆盖同一目录 | 跨项目检测物理重叠，归并或拒绝；D06 |
| 目录操作、父目录替换可绕过文件租约 | P0 限制操作范围；若支持则实现层级/命名空间保护；F16/F22 |
| 暂存产物用当前哈希回灌会覆盖新修改 | 固定执行前基线，按文件幂等回灌和报告部分结果；F17/F18 |
| 暂停的旧服务/存活 helper 仍可能写盘 | 实际 writer 生命周期排他、epoch、接管和恢复栅栏；L03/L04 |
| 替换文件和 DB 提交之间有崩溃窗口 | 明确持久化顺序、状态判定、outbox 与可重入恢复；L05/L06 |
| 未知结果缺查询接口，旧租约会阻断成功重试 | get_mutation_status、先查已提交记录再验证新写条件；L07 |
| 投递 ACK 可由旧实例推进新上下文游标 | 批次绑定实例/执行代次/context revision，接纳和去重同事务；M10/M11 |
| 拒绝/过期消息堵塞水位，撤销与未确认接纳相互矛盾 | 终态关闭邮箱槽位、撤销屏障与历史事实核对；M21/M22 |
| 快照和新游标之间可漏消息 | 原子 snapshot+水位、提交可见顺序、独立邮箱；M12/M13 |
| 消息保存与通知发布有双写缺口 | Message/幂等/邮箱/outbox 同事务，通知不作为唯一事实；M16 |
| 8 KiB 合法消息可能永远塞不进 2000 tokens | 稳定分片、完整送达定义、正文检索和有界容量；M14/M19 |
| ACK、解决事项与上下文压缩混为一谈 | 显式处理状态、可检索正文、原子切换压缩版本；M15 |
| 幂等记录清理或轮次重跑可重复副作用 | 明确 key 作用域、P0 保留记录、持久化 tool_call 映射；M17/L09 |
| aborted 原 ID 被错误当成可重新执行 | 终态不可重跑，重试返回原终止结果；L10 |
| 增量申请锁和单会话关闭可破坏整个保护域 | 非阻塞申请及释放策略、workspace 级保护模式；F23/R02 |

实现时保留以下边界，不做未验证的扩张承诺：

- P0 保护的是接入且被实际执行约束覆盖的参与者；外部任意进程的写入不受纯应用租约保证。
- 单文件内容前置条件不等于跨文件事务、业务正确性或一致的整仓库快照。
- 自动投递保证不重复追加同一分片，不保证模型只处理一次；受管工具使用自己的幂等协议。
- 进程崩溃恢复必须实现；掉电持久性按平台能力和证据声明。
- 用户要求的直接修订按上述明确默认选择落实，后续产品范围不因此提前实施。

## 16. 最终执行指令

现在开始调查真实仓库并实施 P0。遇到已有机制先复用，必要的结构调整保持可审查。除缺少必需输入或必须由用户决定的产品语义外，按本文默认值推进。

开发过程中持续更新接入表和验收状态。最终必须提交一个从会话启动、发现、通信到受管写入都实际连通的实现。P1–P3 只作为后续规格和待办保留。
