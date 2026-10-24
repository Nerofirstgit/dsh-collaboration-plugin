<div align="center">

# dsh-collaboration-plugin

**让 DeepSeek Harness 的多个独立会话，在同一项目中自动沟通、协调文件修改。**

**简体中文** | [English](README_EN.md)

![许可证](https://img.shields.io/badge/license-MIT-263146?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24-43853d?style=flat-square)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6?style=flat-square)
![状态](https://img.shields.io/badge/status-development-f0a441?style=flat-square)

给每个会话分配一次任务，后续的发现、消息传递和文件协调交给插件处理。

</div>

---

## 项目简介

多个 AI 会话同时处理一个项目时，需要知道谁在做什么，也需要避免用旧内容覆盖彼此的修改。本插件为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供项目范围的会话发现、持久消息和受协调的文件写入。

你仍然在 Harness 中创建独立会话、分配任务。参与协作的会话自行交流，在可以证明安全时合并不重叠的修改；遇到重叠或无法判定的冲突，会交回会话处理并说明情况。

这是可安装的 **Cordis / dsh 插件包**。当前版本为 `0.1.0-dev.0`，仍在开发中，完整发布验收尚未完成。

> 本 README 同时记录本地开发候选版的进展。相关源码及下文标注“本地待提交”的专题文档尚未随本次文档提交发布；从当前 GitHub 快照构建时，部分功能和验证记录可能尚未包含。

**导航：** [功能亮点](#功能亮点) · [兼容性](#兼容性与验证状态) · [安装](#安装) · [使用](#如何使用) · [配置](#配置) · [限制](#当前限制) · [开发](#开发与验证) · [文档](#文档)

## 功能亮点

- **同项目自动发现**：查看参与协作的会话、运行状态和简短任务摘要，帮助会话识别相关工作。
- **持久消息传递**：协调消息进入本地持久记录，并带有投递回执；会话之间无需用户手动转述。
- **文件占用协调**：普通受管写入自动申请文件占用，遇到短时竞争进行有界等待，写入结束后释放隐式占用。
- **保留双方修改**：过期编辑只有在完整三方比较能够证明不覆盖对方改动时才自动合并。重叠和歧义不会被盲目覆盖。
- **在原任务内继续协作**：运行中的任务可以等待消息，并在轮次结束处有限续步；消息不会重启已完成或已取消的任务。
- **可查询的操作结果**：不确定是否成功的写入保留原操作 ID，先查询结果，避免以新 ID 重复执行。
- **本地协调服务**：协调状态、消息与会话历史保存在本机；Windows 使用命名管道，Unix 使用本地套接字。
- **受审查的插件共存**：提供指定版本的 Sidebar、Hello、Acceptance Workbench 协作适配，以及受保护的原生插件管理入口。

## 兼容性与验证状态

| 项目 | 当前范围 |
| --- | --- |
| Node.js | `>=24.0.0` |
| 源码默认宿主 | DeepSeek Harness `0.2.1-rc.2`，精确 SDK 依赖 |
| Windows Desktop 兼容构建 | `0.2.0-rc.2`，使用单独适配、单独固定依赖的安装包 |
| 插件版本 | `0.1.0-dev.0`，开发候选版 |
| 主要验证平台 | 原生 Windows x64 / NTFS；另有早期 Linux 开发检查 |
| 发布验收 | 部分场景已验证，完整验收矩阵仍有开放项 |

**已记录的验证：** 原生 Windows 组件测试、两个独立 Harness 进程通过真实命名管道协作、安装归档后的 Web 启动与资源检查；本机 Desktop `0.2.0-rc.2` 的真实模型双会话发现、消息传递、文件协调，以及指定插件共存和原生插件管理流程。

这些是有限场景的测试记录，不代表任意宿主版本、任意插件或全部崩溃恢复路径都已通过。`0.2.0-rc.2` 与 `0.2.1-rc.2` 的包不能混用，也不能只修改版本号来跳过检查。详见 Windows 本地复测（`docs/windows-local-retest.md`，本地待提交）、插件共存（`docs/plugin-coexistence.md`，本地待提交） 和 插件管理恢复（`docs/plugin-management-restoration.md`，本地待提交）。

## 安装

### 1. 从源码构建

在独立开发目录中运行以下命令。Windows PowerShell 可使用 `npm.cmd` 代替 `npm`。

```sh
git clone https://github.com/Nerofirstgit/dsh-collaboration-plugin.git
cd dsh-collaboration-plugin
npm ci --ignore-scripts
npm run typecheck
npm run test:components
npm run build
npm pack --ignore-scripts --dry-run
npm pack --ignore-scripts
```

当前归档名为 `nerofirstgit-dsh-collaboration-0.1.0-dev.0.tgz`。`--ignore-scripts` 跳过打包生命周期，因此须先完成上面的显式构建。检查归档只包含编译文件、bundle 配置、文档和许可证，不包含运行密钥、数据库或测试工作区。

仓库声明了 `private: true`，请使用可信源码生成的本地归档；本文不提供 npm 注册表安装方式。

### 2. 安装到隔离的 headless 测试配置

以下 PowerShell 示例对应源码默认的 **DSH `0.2.1-rc.2`**，在上述仓库目录中执行。示例中的测试目录可自行替换。

```powershell
$archive = (Resolve-Path './nerofirstgit-dsh-collaboration-0.1.0-dev.0.tgz').Path
$env:DSH_HOME = 'C:\dsh-collaboration-test\home'
dsh --version
# 确认输出为 0.2.1-rc.2 后继续
dsh plugin --profile headless add $archive --ignore-scripts
```

宿主须具备官方插件命令需要的 pnpm 环境。bundle 通过 `dsh.bundle.patch` 注册，安装后检查最终配置，并冷启动对应 profile。不要重复手工添加相同 bundle 条目。

### 3. Web / Desktop 配置

GUI 需要在官方 `web` 或 `desktop` 配置基础上应用生成的专用 overlay。**仅安装默认 headless bundle 不足以启用 GUI。**

构建后可以先查看离线生成工具的参数：

```sh
node lib/gui-configure.js --help
```

工具读取安装 bundle 后的官方 `--dump-config` 输出，需要明确指定 `--surface`、`--home`、`--profile-dir`、`--data-dir`；`--host-version` 默认 `0.2.1-rc.2`。它只生成新的配置文件，不会启动应用或修改现有 profile。具体步骤见 [安装说明](docs/installation.md) 和 [GUI 配置说明](docs/gui-candidate.md)。

上述文档保留了早期检查点，部分“尚未验证”描述属于当时状态；当前支持范围以本 README 和后续专题记录为准。已有 Desktop `0.2.0-rc.2` 安装需要匹配的兼容构建和 overlay。

## 如何使用

在完成受支持配置的安装后：

1. 在同一项目中创建两个或更多参与协作的 Harness 会话，并让它们使用同一个本地协调目录。
2. 分别分配任务，例如让 A 修改某份文档的安装说明，让 B 修改同一文档的使用说明。
3. 会话通过工具发现彼此、发布任务摘要、发送协调消息。普通受管写入自动处理文件占用。
4. 遇到过期内容时，插件尝试安全合并；无法自动解决时，会话根据冲突信息继续协调，必要时向用户说明。

模型需要支持并正确调用工具。插件提供协调能力，不保证模型在每个任务中都采取相同的协作策略。

主要工具由插件注册给模型，一般无需用户手动调用：

| 工具 | 用途 |
| --- | --- |
| `session_list_sessions` | 发现同工作区或同项目会话 |
| `session_update_task_summary` | 发布当前任务的简短摘要 |
| `session_send_message` | 发送持久协调消息 |
| `session_poll_events` | 查询可见事件 |
| `session_wait_for_coordination` | 在当前运行任务内等待消息 |
| `session_collaboration_status` | 查看当前配置、能力与限制 |
| `claim_files` / `release_files` | 显式申请或释放文件占用 |
| `apply_file_change` | 提交受管文件创建、替换、补丁、删除或无覆盖重命名 |

## 配置

在可信的 profile overlay 中配置 `session-collaboration`。下例为 Windows 路径示例，文件存放在项目目录之外：

```yaml
- id: session-collaboration
  config:
    enabled: true
    workspace_root: 'C:/dsh-collaboration-test/project'
    data_dir: 'C:/dsh-collaboration-test/state'
    communication_policy: same_project_enabled
    heartbeat_ms: 10000
    offline_ms: 45000
    lease_ttl_ms: 60000
    auto_renew: true
```

| 配置项 | 说明 |
| --- | --- |
| `workspace_root` | headless 工作区根目录；GUI 会话使用经过校验的会话工作区 |
| `data_dir` | 参与方共用的本地协调目录，须位于所有项目目录之外 |
| `communication_policy` | 新配置默认 `same_project_enabled`；`explicit_only` 要求明确授权 |
| `heartbeat_ms` / `offline_ms` | 心跳与离线判定间隔；离线阈值须大于心跳间隔 |
| `lease_ttl_ms` / `auto_renew` | 文件占用有效期及自动续期 |

共享协调参数须保持一致；`workspace_root` 是各宿主自己的设置。已有协调域不会随默认值变化自动迁移通信策略，升级时需停机、备份并显式迁移。`explicit_only` 在没有可用授权入口时会返回 `PERMISSION_REQUIRED`。

可在启动前检查最终组合配置：

```powershell
dsh --profile headless --patch 'C:\dsh-collaboration-test\collaboration.local.yml' --dump-config
```

输出可能包含本地设置，分享前请检查并移除敏感信息。GUI 检查时还需带上其专用 overlay；配置输出本身不等于运行时就绪。

## 当前限制

- 协作范围是**已启用插件并通过运行时检查的 dsh 会话**。外部编辑器和其他程序的写入不受插件阻止。
- 会话可以看到授权范围内的任务摘要和协调消息，不能凭发现能力读取任意私有对话，消息也不能替代用户授权。
- 仅支持已审查的宿主组合。Shell、MCP、Git 写入和其他未适配执行入口可能被禁用或拒绝。
- 当前共存验证针对 Better Sidebar `0.25.0-coop.1`、Hello `0.1.0-coop.1`、Acceptance Workbench `0.15.0-coop.1`。原始包或其他版本不能据此视为兼容。
- 恢复原生插件管理不代表任意 npm / Git 插件都可执行。新增插件仍须通过适配与准入检查；安装后可能需要冷重启，热重载尚未认证。
- 文件操作不支持覆盖式重命名、跨文件系统移动、目录移动、二进制写入或外部工具结果的暂存导入。
- Windows 目录 fsync、整机断电持久性、网络共享和跨用户协作尚未认证。不确定的写入可能需要恢复处理。
- 协作会话历史使用独立持久存储；旧会话不会自动导入，卸载也不会自动迁回原生 JSONL。升级或卸载前请停机并备份配置和完整状态目录，不要删除选举数据库、密钥或操作记录来绕过检查。

## 开发与验证

```sh
npm run typecheck
npm run test:components
npm run build
```

独立进程集成测试单独运行：

```sh
npm run test:integration
```

集成测试涉及真实进程和本地 IPC，应在隔离环境中执行，并先确认没有其他协调实例占用账号级选举。测试夹具使用本地模拟模型；真实模型 Desktop 测试属于单独的验证记录。组件通过、构建成功和完整发布验收是不同的检查范围。

## 文档

| 文档 | 内容 |
| --- | --- |
| 自动协作（`docs/automatic-collaboration.md`，本地待提交） | 消息、等待、自动合并及旧协调域迁移 |
| [安装与升级](docs/installation.md) | 本地打包、隔离安装、停用和回退 |
| [GUI 配置](docs/gui-candidate.md) | Web / Desktop overlay 与运行时检查 |
| Windows 本地复测（`docs/windows-local-retest.md`，本地待提交） | 原生组件、双进程和已安装 Web 测试记录 |
| 插件共存（`docs/plugin-coexistence.md`，本地待提交） | 指定适配包的功能范围与剩余工作 |
| 插件管理恢复（`docs/plugin-management-restoration.md`，本地待提交） | 原生安装入口、准入检查和重启边界 |
| [架构](docs/architecture.md) · [消息](docs/messaging.md) · [文件写入](docs/writer.md) | 设计与实现细节 |
| [范围修订](docs/scope-revision.md) · [验收矩阵](docs/acceptance-matrix.md) | 需求范围和完整验收清单 |

## 反馈与贡献

欢迎通过 [GitHub Issues](https://github.com/Nerofirstgit/dsh-collaboration-plugin/issues) 反馈问题或提交 Pull Request。请附上宿主和插件版本、操作系统、复现步骤，以及去除凭据和私有会话内容后的日志。修改涉及宿主、文件写入或第三方插件时，请注明实际测试的平台与功能范围。

README 的双语入口与展示结构参考了 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)，功能与安装说明以本仓库实现为准。

## 许可证

[MIT](LICENSE) · Copyright © 2026 Nerofirstgit
