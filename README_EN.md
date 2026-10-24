<div align="center">

# dsh-collaboration-plugin

**Automatic communication and coordinated file edits for independent DeepSeek Harness sessions working on the same project.**

[简体中文](README.md) | **English**

![License](https://img.shields.io/badge/license-MIT-263146?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24-43853d?style=flat-square)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6?style=flat-square)
![Status](https://img.shields.io/badge/status-development-f0a441?style=flat-square)

Assign each session its task once. Let the plugin handle discovery, message delivery, and file coordination.

</div>

---

## Overview

When several AI sessions work on one project, they need to know who is doing what and avoid overwriting each other's edits with stale content. This plugin adds project-scoped session discovery, durable messaging, and coordinated file writes to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

You create independent sessions and assign tasks in Harness as usual. Participating sessions can communicate directly, and the plugin merges nonoverlapping edits when it can prove that both changes are preserved. Overlapping or ambiguous conflicts are returned to the sessions for an explicit decision.

This is an installable **Cordis / dsh plugin bundle**. Version `0.1.0-dev.0` is a development candidate; full release acceptance is still incomplete.

> This README also records progress in the local development candidate. Related source changes have not all been pushed. Builds from the current GitHub snapshot may not yet include those features.

**Navigation:** [Highlights](#highlights) · [Compatibility](#compatibility-and-validation) · [Installation](#installation) · [Usage](#usage) · [Configuration](#configuration) · [Limitations](#current-limitations) · [Development](#development-and-verification) · [Documentation](#documentation)

## Highlights

- **Automatic project discovery:** Find participating sessions, their current status, and concise task summaries to identify related work.
- **Durable messaging:** Coordination messages have local persistent records and delivery receipts. Users do not need to relay messages between sessions.
- **File reservations:** Ordinary managed writes acquire file claims automatically, wait for temporary contention within a fixed bound, and release implicit claims when the operation settles.
- **Preserve both edits:** Stale edits merge automatically only when a complete three-way comparison proves that the other writer's changes survive. Overlaps and ambiguity never trigger a blind overwrite.
- **Continue the original task:** Running tasks can wait for messages and continue a bounded number of times at a turn boundary. Messages do not restart completed or cancelled tasks.
- **Queryable operation outcomes:** An uncertain write keeps its original operation ID so its result can be queried before any further action.
- **Local coordination service:** Coordination state, messages, and session history stay on the machine. IPC uses Windows named pipes or Unix-domain sockets.
- **Reviewed plugin coexistence:** Includes adapters for specific Sidebar, Hello, and Acceptance Workbench versions, plus a guarded native plugin management entry point.

## Compatibility and validation

| Item | Current scope |
| --- | --- |
| Node.js | `>=24.0.0` |
| Default source target | DeepSeek Harness `0.2.1-rc.2`, with exact SDK dependencies |
| Windows Desktop compatibility build | `0.2.0-rc.2`, using a separately adapted package with its own dependency pins |
| Plugin version | `0.1.0-dev.0`, development candidate |
| Primary validation platform | Native Windows x64 / NTFS; earlier development checks also ran on Linux |
| Release acceptance | Selected scenarios verified; the full acceptance matrix still has open items |

**Recorded validation includes:** native Windows component tests, two independent Harness processes coordinating over a real named pipe, installed-archive Web startup and asset checks, and local Desktop `0.2.0-rc.2` tests with real models covering discovery, messaging, file coordination, selected plugin coexistence, and native plugin management.

These are finite scenarios, not certification of arbitrary host versions, plugins, or every crash-recovery path. Packages for `0.2.0-rc.2` and `0.2.1-rc.2` are not interchangeable; changing a version string does not establish compatibility. See the [Windows retest](docs/windows-local-retest.md), [plugin coexistence](docs/plugin-coexistence.md), and [plugin management restoration](docs/plugin-management-restoration.md) records.

## Installation

### 1. Build from source

Run these commands in a dedicated development directory. In Windows PowerShell, use `npm.cmd` if needed.

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

The current archive name is `nerofirstgit-dsh-collaboration-0.1.0-dev.0.tgz`. Because `--ignore-scripts` skips packaging lifecycle scripts, complete the explicit build above first. Check that the archive contains compiled files, bundle configuration, documentation, and licenses, without runtime keys, databases, or test workspaces.

The repository declares `private: true`. Use a local archive built from trusted source; these instructions do not install a registry package.

### 2. Install into an isolated headless test profile

This PowerShell example targets the source default, **DSH `0.2.1-rc.2`**. Run it from the repository directory above and adjust the test paths as needed.

```powershell
$archive = (Resolve-Path './nerofirstgit-dsh-collaboration-0.1.0-dev.0.tgz').Path
$env:DSH_HOME = 'C:\dsh-collaboration-test\home'
dsh --version
# Confirm 0.2.1-rc.2 before continuing
dsh plugin --profile headless add $archive --ignore-scripts
```

The host needs the pnpm environment required by its official plugin command. The bundle registers through `dsh.bundle.patch`. Inspect the final configuration after installation, then cold-start the selected profile. Do not manually register duplicate bundle entries.

### 3. Configure Web / Desktop

GUI use requires a generated overlay applied to the official `web` or `desktop` profile. **Installing the default headless bundle alone does not enable the GUI.**

After building, inspect the offline configuration tool:

```sh
node lib/gui-configure.js --help
```

The tool reads an official `--dump-config` output after the bundle is installed. It requires explicit `--surface`, `--home`, `--profile-dir`, and `--data-dir` values; `--host-version` defaults to `0.2.1-rc.2`. It creates a new configuration file without launching the application or modifying an existing profile. See [installation](docs/installation.md) and [GUI configuration](docs/gui-candidate.md) for the detailed procedure.

Those documents retain earlier checkpoints, including statements about validation that was pending at the time. This README and subsequent topic records describe the current supported scope. Existing Desktop `0.2.0-rc.2` installations require their matching compatibility build and overlay.

## Usage

After installing a supported configuration:

1. Create two or more participating Harness sessions in the same project, sharing one local coordinator directory.
2. Give each session its task, such as asking A to update a document's installation section and B to update its usage section.
3. Sessions use tools to discover peers, publish task summaries, and send coordination messages. Ordinary managed writes handle file claims automatically.
4. If content is stale, the plugin attempts a safe merge. When that is not possible, sessions receive conflict information, continue coordinating, and explain unresolved decisions to the user when necessary.

The model must support tools and use them correctly. The plugin supplies coordination capabilities; model behavior can differ between tasks.

The plugin registers these principal tools for models. Users generally do not need to call them manually:

| Tool | Purpose |
| --- | --- |
| `session_list_sessions` | Discover sessions in the same workspace or project |
| `session_update_task_summary` | Publish a concise summary of the current task |
| `session_send_message` | Send a durable coordination message |
| `session_poll_events` | Query visible events |
| `session_wait_for_coordination` | Wait for messages within the current running task |
| `session_collaboration_status` | Inspect the active configuration, capabilities, and limits |
| `claim_files` / `release_files` | Explicitly reserve or release files |
| `apply_file_change` | Submit managed create, replace, patch, delete, or no-overwrite rename operations |

## Configuration

Configure `session-collaboration` in a trusted profile overlay. This example uses Windows paths; keep the overlay outside the project directory:

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

| Setting | Meaning |
| --- | --- |
| `workspace_root` | Headless workspace root; GUI sessions use their validated session workspace |
| `data_dir` | Shared local coordinator directory, outside every participating project |
| `communication_policy` | New configurations default to `same_project_enabled`; `explicit_only` requires explicit authorization |
| `heartbeat_ms` / `offline_ms` | Heartbeat and offline intervals; the offline threshold must exceed the heartbeat interval |
| `lease_ttl_ms` / `auto_renew` | File claim lifetime and automatic renewal |

Shared coordinator settings must match across participants; `workspace_root` is local to each host. Existing domains do not silently adopt new communication defaults. Stop participants, back up state, and explicitly migrate the policy when upgrading. With `explicit_only`, a missing approval integration results in `PERMISSION_REQUIRED`.

Inspect the final composed configuration before startup:

```powershell
dsh --profile headless --patch 'C:\dsh-collaboration-test\collaboration.local.yml' --dump-config
```

The output may contain local settings; review and redact it before sharing. GUI inspection must also include its dedicated overlay. A configuration dump alone does not establish runtime readiness.

## Current limitations

- Collaboration covers **enabled dsh sessions that pass runtime checks**. It does not prevent writes by external editors or other programs.
- Sessions can access authorized task summaries and coordination messages. Discovery does not grant access to arbitrary private conversations, and peer messages cannot substitute for human authorization.
- Only reviewed host compositions are supported. Shell, MCP, Git writes, and other unadapted execution paths may be disabled or refused.
- Coexistence validation covers Better Sidebar `0.25.0-coop.1`, Hello `0.1.0-coop.1`, and Acceptance Workbench `0.15.0-coop.1`. It does not establish compatibility for their original packages or other versions.
- Restoring native plugin management does not enable arbitrary npm / Git plugins. New plugins still require adaptation and admission checks. Installation may require a cold restart; hot reload is not certified.
- File operations do not support overwrite renames, cross-filesystem moves, directory moves, binary writes, or staged imports of external-tool results.
- Windows directory fsync, whole-machine power-loss durability, network shares, and cross-user collaboration are not certified. Uncertain writes may require recovery.
- Coordinated session history uses separate persistence. Existing sessions are not imported automatically, and uninstalling does not migrate history back to stock JSONL. Stop participants and back up configuration and complete state before upgrades or removal. Do not delete election databases, keys, or operation records to bypass checks.

## Development and verification

```sh
npm run typecheck
npm run test:components
npm run build
```

Run independent-process integration tests separately:

```sh
npm run test:integration
```

Integration tests use real processes and local IPC. Run them in isolation after confirming that no other coordinator occupies the account-level election. Fixtures use local fake models; Desktop tests with real models are recorded separately. Component checks, build success, and full release acceptance cover different scopes.

## Documentation

| Document | Contents |
| --- | --- |
| [Automatic collaboration](docs/automatic-collaboration.md) | Messaging, waiting, automatic merging, and existing-domain migration |
| [Installation and upgrades](docs/installation.md) | Local packaging, isolated installation, disabling, and rollback |
| [GUI configuration](docs/gui-candidate.md) | Web / Desktop overlays and runtime checks |
| [Windows local retest](docs/windows-local-retest.md) | Native component, two-process, and installed Web test records |
| [Plugin coexistence](docs/plugin-coexistence.md) | Supported adapter packages and remaining work |
| [Plugin management restoration](docs/plugin-management-restoration.md) | Native installation, admission checks, and restart boundaries |
| [Architecture](docs/architecture.md) · [Messaging](docs/messaging.md) · [File writes](docs/writer.md) | Design and implementation details |
| [Scope revision](docs/scope-revision.md) · [Acceptance matrix](docs/acceptance-matrix.md) | Requirements and full acceptance checklist |

## Feedback and contributions

Report issues through [GitHub Issues](https://github.com/Nerofirstgit/dsh-collaboration-plugin/issues) or submit a pull request. Include host and plugin versions, your operating system, reproduction steps, and logs with credentials and private conversation content removed. For changes involving hosts, file writes, or third-party plugins, state the platforms and features actually tested.

## License

[MIT](LICENSE) · Copyright © 2026 Nerofirstgit
