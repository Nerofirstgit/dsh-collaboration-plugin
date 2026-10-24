# Plugin coexistence release requirement

> Dated implementation checkpoints and test results below are historical. For the current published scope and compatibility limits, start with the [README](../README_EN.md).

## Implemented local scope, 2026-10-23

Revision5 supports the exact cooperative backend packages Better Sidebar 0.25.0-coop.1, Hello 0.1.0-coop.1 and Acceptance Workbench 0.15.0-coop.1, preserving original clients. All three are now enabled on the user's existing Desktop 0.2.0-rc.2. Real-model two-session discovery/message delivery/file collaboration, matching successful Hello/Workbench results, actual Sidebar editor save and Workbench panel display passed. Both SDK component suites: 711 total,708 pass,0 fail,3 existing skips.

The adapters enforce concrete fiber/tool identities, session-root containment, coordinator-mediated UTF-8 CRUD and immutable Workbench definition publication. Sidebar read generations and post-commit content matching prevent stale UI drafts from inheriting unseen peer revisions. Private evidence stays in reserved host state. See source extension-admission.ts, extension-files.ts, sidebar-adapter.ts, workbench-adapter.ts, extensions.ts and reproducible scripts/prepare-extension-adapters.mjs.

This is scoped coexistence, not full release acceptance: Git mutations/most Git routes, binary uploads/media/HTML/archive, recursive directory changes, Sidebar sidechat/external execution, Workbench browser capture/check/screenshot tools and raw PNG baseline changes remain explicitly unavailable. No direct-write fallback is enabled. Hot reload and arbitrary versions are not certified. The original audit and full release gates below remain historical context and open requirements where outside this supported scope. Current local report: Windows第三方插件共存测试记录.md at workspace root (outside the source checkout).

Recorded from the user's requirement on 2026-10-22: the released collaboration plugin must coexist with other plugins. Temporarily disabling extensions for a baseline installation test is not release acceptance.

## Current behavior and evidence

The development GUI candidate admits a fixed set of plugin identities and collaboration-owned tools. An unknown enabled plugin is rejected before startup. This is an admission limitation, not evidence of an ABI clash or a reproduced failure in that plugin.

Read-only inspection of the user's installed extensions found:

| Extension | Observed capability | Required compatibility boundary |
| --- | --- | --- |
| dsh-hello-plugin | Registers a greeting tool; no file/session writes found | Admit reviewed extension tools independently of UI/service inventory; continue checking the live tool identity |
| dsh-better-sidebar 0.25.0 | UI plus direct filesystem writes, uploads, rename/delete/create and Git mutations through its own HTTP API | Preserve display/browsing; mediate mutations through revision/lease/commit handling, including HTTP requests outside model tool dispatch |
| dsh-acceptance-workbench 0.15.0 | Writes project .dsh-acceptance definitions and private evidence; registers tools and execution hooks | Declare state locations, distinguish project/shared state, mediate project writes, and specify hook ordering and extension tool admission |

The actual Desktop profile lists all three dependencies, but only Better Sidebar is currently in its bundle stack. Installed and enabled must be reported separately.

The Better Sidebar implementation uses direct Node writeFile and rename in its fs.write method. Its optional mtime precheck does not make the subsequent write a coordinated transaction. Merely adding its name to the GUI allowlist would leave a path that can overwrite a concurrent committed edit without a collaboration revision or ledger entry. No destructive concurrent overwrite was performed during this audit.

## Required design properties

1. Separate compatibility admission for UI/display, tools, session hooks, private state, and workspace mutations. A plugin name or self-declared capability alone must not grant a write exception.
2. Retain safe display functions when a particular mutation path lacks an adapter; explain which function is unavailable and why.
3. Use explicit live adapters for filesystem/HTTP/Git mutation paths. A successful operation must have the same revision, lease and durable outcome rules as collaboration-owned operations.
4. Preserve the host's tool identity checks and readiness ordering while allowing reviewed extension tools. Do not expose raw shell/filesystem execution as a workaround.
5. Define precedence for tool/session hooks and identify concrete conflicting providers before disabling an entire plugin.
6. Keep compatibility decisions inspectable and reversible. Do not silently uninstall, reset configuration, or claim protection for unmediated writes.

## Release gates

- All three extensions can remain installed; enabled/disabled state is explicit.
- Greeting and UI display tools continue to work with collaboration enabled.
- Sidebar save versus another session's edit cannot silently lose the committed edit; stale requests are rejected or explicitly reconciled.
- Upload/rename/delete/create and Git operations are covered by their actual routes, not only model-dispatched tool tests.
- Workbench definition updates and evidence writes obey the declared state and concurrency rules.
- Hook ordering, plugin reload, startup, shutdown and rollback are tested in the combined configuration.
- Unsupported versions/capabilities produce a specific compatibility diagnosis. A fixed inventory refusal must not be described as a demonstrated crash or ABI conflict.

These are open release requirements, not claims that the current candidate implements extension compatibility.
