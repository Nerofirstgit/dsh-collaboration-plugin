# Revised protection scope: enabled, audited headless participants

The user clarified during development that **disabling/unloading the plugin need not preserve collaboration or protection**. That supersedes the original document's requirement that a disabled participant remain read-only while another participant remains protected. No upstream patch has been authorized or applied. Existing durable history and unresolved-operation evidence must still be retained; disabling is not an instruction to delete records or invent terminal outcomes.

This change makes a useful unchanged-host plugin feasible. It does **not** authorize a claim that an ordinary JavaScript plugin confines every installed Host package or arbitrary external process.

## Supported target composition

The supported target is a **cold-start, pinned, audited headless profile** built from official `dsh-base` + `dsh-headless` at `0.2.1-rc.2`, with the collaboration bundle applied and its required safety restrictions intact. Every model-facing write while enabled must either go through the coordinated writer or return an explicit denial.

The minimal enabled-mode composition requires:

1. Replace the real `ctx.fs` service with `ProtectedFileSystem`; all direct provider mutations fail. Replace established `read`/`write`/`edit` tool definitions, rather than leaving writable originals beside new collaboration names.
2. Apply a global monotonic `tools.guard`, verify registration **object identity** (not only tool name), and restrict each participating scope to the audited collaboration/read/write definitions. Reserved `run_code` and all shell/MCP/dynamic-plugin alternatives are denied. A session approval cannot override a monotonic denial.
3. Disable bash/model plugin-manager/HMR entrypoints. Use the pinned headless bundle, which mounts no HTTP/Web/browser Host/controller layer. Do not treat an existing browser profile plus this patch as equivalent to the audited headless composition.
4. Finish provider, runtime hooks and tool guards **before** any Agent starts. Publish a `collaborationReady` capability only after installation and make the headless runner depend on it (or implement an equivalent explicit startup barrier). A source-row order is not a readiness barrier.
5. The coordinator is the sole managed writer, with singleton ownership, authenticated incarnation/epoch credentials, leases, exact byte versions, read receipts, mutation intents and recovery. Coordinator failure never invokes the old local write path.
6. Do not invisibly truncate a managed `read` after its receipt is minted. The existing spill policy exempts the established `read` name; the separate tool-result pruner does not. Disable that pruner for this profile or invalidate/restrict receipts when it rewrites observations. Context rewrites must not retain a broader unread observation as if it were displayed intact.
7. Begin with fresh participant processes. Do not mark already-running shell/MCP/terminal children or earlier sessions protected merely because the plugin was enabled later.

This list is an implementation/acceptance contract. A source review is not a substitute for the enabled-profile integration tests below.

## Exact host evidence and ordering caveats

All line references are to upstream commit `687f282e8625c6b8d11ff58211a90524be2e4317`.

- `packages/core/tools/src/index.ts:724–732,1134–1149`: global guards are monotonic; they return only deny-or-unchanged and cannot force an allow.
- `packages/core/tools/src/index.ts:1501–1538`: `tools/pre-execute` and any approval finish **before** the global guard is evaluated. A custom pre-execute listener can already have side effects by the time a denied tool receives its error. The guard therefore does not confine arbitrary prehooks.
- `packages/core/tools/src/index.ts:1609–1616`: allowed calls then enter an asynchronous `tools/execute` waterfall. `dispatchToolBody` re-resolves the definition at lines 1586–1589. A guard that checked an earlier definition does not alone prove the definition used after asynchronous wrappers is identical.
- Cordis `src/events.ts:234–244,252–258` (installed pinned `4.0.5`): waterfall listeners run outermost-first in registration order; `prepend` moves a listener outward. A final owned-definition check must occur after the runtime's awaited identity/flush/operation-mapping work, without another asynchronous gap before the actual body lookup. Registering an ordinary checker earlier is insufficient against a later await-and-shadow wrapper.
- `packages/bundle/base/cordis.patch.yml:11–13`: row order has no load semantics; activation is service-availability driven. `packages/bundle/headless/src/index.ts:40` depends on agents/sessions/defaultModel, not collaboration. `packages/core/agent-loop/src/index.ts:716` has an optional persistence lookup. An asynchronous coordinator connection before guard setup needs an explicit startup gate.
- `packages/bundle/headless/cordis.patch.yml:1–7`: headless mounts no Host, HTTP server, Web runtime or browser plugin. That exclusion matters; browser terminals otherwise launch outside the Agent policy.
- `packages/spill/spill-policy/src/index.ts:133–139`: established `read` results are explicitly exempt from spill truncation.
- `packages/compaction/compaction-tool-result-pruner/src/index.ts:136–181`: all oversized current tool-result messages can be rewritten, without a `read` exemption. `packages/compaction/compaction-basic/src/index.ts:292–325` invokes pruning during overflow/pressure compaction. A cached full receipt must not silently authorize a replacement after only the pruned result was supplied to the model.

A final synchronous checker installed after the known runtime wrapper handles a definition shadow introduced while that wrapper awaits RPC. It does not make arbitrary subsequently installed Host wrappers safe: an unknown later listener may itself mutate files or delay and replace the tool. Such a composition is unsupported, not “protected because the name was on an allowlist.”

## Compatibility matrix

| Composition/path | Enabled-mode treatment | What is not claimed |
|---|---|---|
| Audited replacement `read`/`write`/`edit` | Read receipts and all writes through coordinator | No raw fallback when disconnected |
| Direct `ctx.fs.writeText` / `editText` | Always denied by replacement provider | Does not intercept `node:fs` imported by arbitrary Host code |
| Ordinary model bash/Pwsh, Git, formatter/install scripts | Disabled or denied before tool body | No command-string heuristic; no arbitrary shell staging in P0 |
| Reserved PTC `run_code` / workflow / subagent alternatives | Denied unless separately audited and integrated | Do not infer safe writes from tool filtering or a read-only label |
| Newly registered unknown tool or scoped same-name shadow | Definition-identity guard/late check denies | Unknown registration/prehook/startup code itself is not confined |
| Added MCP stdio/HTTP server | Unsupported composition; do not start it as protected | Tool-call denial cannot undo MCP process startup effects |
| Arbitrary plugin `apply`, timers, `tools/pre-execute`, direct Node APIs | Unsupported composition | Same-process plugins are trusted Host code, not sandboxed workers |
| Browser/API terminals, LSP launchers, custom editor interfaces | Not in supported headless profile | Read-only `ctx.fs` does not automatically confine their subprocesses |
| Existing writable child/session from before activation | Restart/drain/isolate before participating, otherwise explicitly outside scope | No retroactive protection |
| Human editor, manual external process, differently configured host | Outside participant guarantee; conflicts may be detected by byte checks | No universal filesystem security boundary |
| Plugin disabled/unloaded | No collaboration/protection promise, per revised user requirement | Not counted as an R02 failure under the revised scope |

## Required enabled-profile evidence

- Two real pinned headless processes discover each other and execute coordinated changes through the original tool names.
- Delay coordinator startup and prove no model/tool runs before the collaboration readiness barrier.
- Try bash, `run_code`, unknown tools and same-name scoped tool shadows, including a shadow introduced while durable tool mapping awaits; no unmediated body runs.
- Call direct provider mutation methods with `danger-full-access`; both are denied.
- Disconnect or stop the coordinator; writes fail closed and no local fallback runs.
- Force a read display cap, compaction/pruning and replay; no incomplete observation can authorize a whole-file overwrite.
- Do not claim arbitrary MCP/plugin **startup or prehook** confinement from a tool-denial test. Those rows are unsupported composition cases unless a separate enforcing process boundary is later implemented.

The historical audit in [host-write-boundary.md](host-write-boundary.md) remains useful source evidence. Its mandatory persistence-after-unload requirement is superseded by this explicit scope revision, not silently treated as implemented.
