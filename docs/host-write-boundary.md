# Host write-path compatibility reference

Source: `deepseek-ai/deepseek-harness`, commit `687f282e8625c6b8d11ff58211a90524be2e4317` (`0.2.1-rc.2`). All paths and line numbers below refer to this exact checkout, read without modification. This is source inspection, not a passing integration/security test.

## Decision — updated after user scope clarification

The user has removed the requirement that protection continue after the plugin is disabled/unloaded. Under that revised scope, an unchanged-host plugin is feasible for a **cold-start, pinned, audited headless composition** while enabled. See [the scope revision and compatibility matrix](scope-revision.md) for the exact supported contract, startup barrier, definition-recheck and prehook caveats. No upstream patch is authorized or required merely to implement that narrower contract.

The original, broader audit conclusion remains true: an ordinary additive policy plugin cannot establish immutable protection across plugin removal, arbitrary installed Host code, independent MCP startup, existing writable children or differently configured participants. The current plugin must not claim these excluded capabilities. A restricted bundle can reuse real providers and monotonic tool guards to mediate its audited model write paths; that is distinct from an OS-wide sandbox.

The evidence and alternatives below were collected against the original requirements. Persistent-after-unload portions of options B/C are now optional future work, **not a current user-approval blocker**. Enabled-mode integration and failure tests are still required; source inspection alone is not acceptance.

## Existing extension points that can be reused

| Entry | Evidence | Useful guarantee and limitation |
|---|---|---|
| Tool denial | `packages/core/tools/src/index.ts:724–732`, `1134–1149`, `1527–1538`: `ToolGuard`, `ToolRuntime.guard`, `prepareExecution` | Monotonic synchronous deny runs after extensible pre-execute policy. Other listeners cannot turn its denial into allow. Its disposer is an ordinary scoped effect and disappears on unload. |
| Async execution mediation | `packages/core/tools/src/index.ts:1609–1616`: `dispatchScheduledExecution` | `tools/execute` can perform authoritative asynchronous checks and dispatch the managed operation itself rather than call the old body. It does not intercept arbitrary service calls or Node filesystem APIs. |
| Filesystem provider | `packages/fs/fs/src/index.ts:266–293`: `FileSystem.writeText`, `editText` | Replace `ctx.fs` through profile composition. Current signatures permit optional guards and carry no caller incarnation, mutation ID, fencing token, or persistent read receipt. A trusted adapter must supply them, never model-controlled identity. |
| Process sandbox | `packages/sandbox/sandbox/src/index.ts`: `SandboxProvider.confine`, `ConfinedArgv.enforcement` | Kernel-backed wrapping is available; only `enforcement: full` is sufficient for an absolute promised file-effect boundary. The consumer must actually call it. Unknown/unconfined commands can instead be denied. |
| Provider/profile composition | `docs/architecture.md:5–33`, capability-seam/extension sections | All services are plugins and profile patches can replace them. This also means an ordinary installed plugin is not an immutable mandatory control. |

A tool-name allowlist alone is insufficient. `ToolRuntime.dispatchToolBody` resolves the name against the current agent scope at `packages/core/tools/src/index.ts:1586–1589`; scoped/dynamic definitions may differ from the registration initially reviewed. Use trusted registration identity and direct managed dispatch, or reject it. The actual writer must still check every credential and precondition.

## Write-path inventory

| Path family | Real execution point | Required protected-profile treatment |
|---|---|---|
| Model `write` / `edit` and alternative editor | `packages/fs/tool-fs/src/write.ts`, `edit.ts`; `packages/fs/tool-str-replace-editor/src/index.ts`; provider `packages/fs/fs-local/src/index.ts:202–290` | Replace the provider and adapt the existing tool names. Do not retain an unconditional fallback. |
| Reads feeding write authorization | `packages/fs/tool-fs/src/read.ts:137–163` resolves/stat-checks first, reads afterward, then records the earlier version | A replacement must read full raw bytes once under the writer's short resource lock, compute SHA-256 from those same bytes, then derive the displayed window and read receipt. Current output schema has no version/read token (`read.ts:85–105`). |
| Atomic local file publication | `packages/fs/fs-local/src/fsio.ts:588–650`: `writeFileAtomic` | Existing atomic replace is useful reference, not the requested transaction/recovery protocol. It lacks persistent mutation/outbox state and resource recovery fences. |
| Shell, scripts, formatter, installs, Git | `packages/shell/bash-sandbox/src/index.ts:85–103`, `179–188`; local executor uses subprocess service | Deny all shell calls initially, or enforce genuinely read-only execution. `workspace-write` explicitly allows bypassing the writer; `danger-full-access` delegates directly. No command-text heuristic is safe. |
| Persistent model terminals | `packages/terminal/terminal-bash/src/index.ts:101–109`, `202–209` | Deny/disable, or enforce read-only confinement and drain pre-existing sessions. `danger-full-access` bypasses wrapping. |
| Browser/user terminal | `packages/api/terminal-controller/src/index.ts:151–159`, `313–325`: `TerminalController.create` / `spawn` | Explicitly outside Agent sandbox/approval restrictions. It directly invokes `subprocess.spawnTerminal`. A tool-only interceptor does not cover this API. Either disable the controller in protected profile or classify user terminal as unmanaged external editing, visibly outside guarantee. |
| LSP server | `packages/lsp/lsp-stdio/src/index.ts:126–157`: `apply` constructs providers with `ctx.subprocess.spawn` | No sandbox call at this launch point. Disable arbitrary LSP providers or replace process substrate with an enforcing implementation; a supposedly read-only query does not establish a process write boundary. |
| MCP stdio server | `packages/mcp/mcp-client/src/transport.ts:15–39`: `createTransport` | SDK owns spawn, deliberately outside `ctx.subprocess`. Disable until an approved transport wraps and supervises the actual process, including startup behavior. Denying an MCP tool after server startup does not undo startup writes. |
| MCP HTTP / tools | `packages/mcp/mcp-client/src/transport.ts:40–44`; `tools.ts:113–150`: `syncTools` bridges `client.callTool` | Unknown external tool effects must be denied, not guessed from MCP annotations. Remote servers with independent credentials are not made safe by a local filesystem lease. |
| Dynamic host packages | `packages/extensions/cordis-host-runner/src/sandbox.ts:2–7`, `101–116`: `createSandbox`; service in `src/index.ts:140–161` | Disable dynamic Host execution while protected. `node:vm` explicitly is not containment; host helper functions remain an escape route. Only blocking future calls is insufficient if a previous package installed timers/listeners. |
| Third-party installed host plugins | `packages/boot/plugin-manager/src/tools.ts:103–109`; `SAFETY.md:7–15` | Installed Host code runs outside workspace sandbox. It is trusted host code, not an untrusted confined worker. Review/freeze composition or move code to a genuinely restricted process. |
| Profile/plugin changes | `packages/boot/plugin-manager/src/index.ts:486–501`: `setPluginEnabled`; `packages/boot/config-editor/src/index.ts:87–153`: `edit` | Tool, remote UI and config reload paths can alter protection. Disable them in a restricted profile; a durable mandatory host/OS policy is required if removing the collaboration plugin must still leave every participant read-only. |
| Worktree/repository shared state | `packages/experimental/worktree/src/index.ts:126–140`; directory allocator `src/directory.ts` | P2 is out of scope. Deny these APIs/tools and all Git mutation commands until a separate common-dir resource coordinator exists. |
| Runtime dependencies/installers | `packages/skill/tool-workspace-dependencies/src/index.ts:170–174`, `242+`; plugin manager package operations | Runtime installation writes application storage and may execute package scripts. Keep outside protected project, disable model-triggered installers while protection is active, and never forward writer/coordinator credentials to arbitrary child code. |
| Document conversion and host storage | `packages/document/office-to-pdf/src/index.ts`; persistence/attachments/spill/storage provider groups | Some raw Node writes are legitimate application-private state, not project mutation. Audit configuration roots for physical overlap; do not claim a `ctx.fs` replacement intercepts them. |

This inventory is an audit of shipped families, not a claim that all future plugins are covered. Unknown host plugins must fail activation or be isolated in the protected profile; allowing arbitrary code and then enumerating its known methods is not enforcement.

## Concrete incompatibilities with existing filesystem behavior

1. `LocalFileSystem` uses a process-local `Map<string, Promise<unknown>>` for mutation locks (`packages/fs/fs-local/src/index.ts:101–104`, `117–127`). Separate host processes do not share it.
2. `versionOf` is a concatenation of device, inode, size, mtime and ctime, not a content SHA-256 (`packages/fs/fs-local/src/fsio.ts:74–76`).
3. `writeText` explicitly allows an unconditional write when the expectation is absent (`packages/fs/fs-local/src/index.ts:214–224`); `editText` does likewise (`270–275`).
4. The observation policy is process-local `WeakMap` state and is discarded on unload (`packages/fs/fs-observation-policy/src/index.ts:18–28`, `56–58`, `106–129`). Its own module documentation states removal restores bare unconditional mutation (`2–6`).
5. `fs/write-intent` and `fs/edit-intent` are first-answer waterfall slots, not mandatory composed policy (`packages/fs/fs/src/index.ts:49–67`).
6. `SandboxedFileSystem` explicitly accepts ancestor symlink TOCTOU and says it is not a kernel security boundary (`packages/fs/fs-sandbox/src/index.ts:11–18`). The requested trusted writer must use safe directory-descriptor-relative operations and reject unsupported aliases; merely repeating `realpath()` is not the promised protection.
7. `SandboxPolicyService.resolve` allows explicit mode over session override over deployment default (`packages/sandbox/sandbox-policy/src/index.ts:155–170`). There is no workspace-domain collaboration fence in that resolution.

## Historical decision options (persistent-after-unload scope superseded)

### A. Restricted plugin bundle, unchanged host (narrower deliverable)

Ship a real Cordis bundle that replaces `ctx.fs`, attaches trusted lifecycle/message hooks and monotonic tool denial, disables arbitrary shell, MCP, dynamic Host code, LSP, worktree, terminal, plugin-management and configuration editing, and refuses unsupported compositions. Managed writes all go to the daemon. Unload removes tools/provider or disposes agents rather than delegating to the old provider.

This can be useful and honestly testable, but does not prove the complete requirement after another profile, an external config edit, or plugin removal restores the host's old writable services. Those scenarios must remain explicitly unsupported unless separate OS enforcement is supplied. A stopped/disconnected plugin must never label its workspace protected merely because the daemon is still running.

### B. Plugin plus host enforcement additions (only if the broader guarantee is requested later)

Keep coordination, storage, tools and writer in the plugin; add a durable host-level protected-workspace requirement checked independently of plugin enablement. Candidate changes, requiring user approval before editing upstream:

- In boot/profile activation and reload, consult protected workspace state and require an enforcing collaboration capability. Missing/disabled provider leaves relevant sessions read-only or refuses startup, never silently loads writable defaults.
- In sandbox policy and tool dispatch, apply a non-widenable workspace protection decision after normal per-session approvals; cancellation/close waits for in-flight writer results.
- In process launches, make confinement mandatory for protected participants; cover MCP's independent SDK transport and browser terminals, or refuse these services before they spawn. Reject `partial` enforcement for a promised full policy.
- In plugin manager/config editor, require coordinated workspace exit before removing protection or enabling unknown Host code. A local tool approval alone cannot revoke the protection of other sessions/processes.
- Expose trusted invocation identity/read-snapshot/mutation metadata through the filesystem adapter path rather than accepting them from model JSON.

The minimal code diff cannot be honestly specified as one universal hook: all bypassing launch/config paths above must either call the new mandatory policy or be disabled before activation. Tests must demonstrate the denied bypass, including unload/reload and already-running children.

### C. Plugin plus external OS execution isolation

Run the participating host/worker process in a workspace-read-only environment, with the daemon as the sole workspace-writable process and a narrow authenticated RPC endpoint. Drop coordinator database/writer credentials from arbitrary code and child environments. Plugin removal then cannot restore kernel-denied writes. This avoids an upstream source fork but adds installation/launch/permission requirements and platform support decisions; it is not achieved by naming a JavaScript object a sandbox. User authorization is needed before changing real machine security configuration.

## Verification still required

For either complete route: launch two real pinned `dsh` processes; prove tools, MCP startup/calls, dynamic Host activation, browser terminals and subprocess descendants cannot bypass the writer; disable one participant's collaboration while the other remains protected; suspend the old coordinator while starting another; repeat with reload and failures. Run directory alias/parent-replacement barriers against the writer. Report Linux tests separately from macOS/Windows and process-kill recovery separately from power-loss durability.
