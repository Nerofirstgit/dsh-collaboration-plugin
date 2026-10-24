# Mandatory acceptance matrix — 65 cases

> Dated implementation checkpoints and test results below are historical. For the current published scope and compatibility limits, start with the [README](../README_EN.md).

> Latest portable/GUI component changes: [candidate contract](gui-candidate.md). Windows native execution, actual packed GUI boot and two-process transport remain unaccepted. Historical Linux-only/external-actor entries below must be evaluated under the explicit [scope revision](scope-revision.md); neither larger component counts nor simulations mark all 65 complete.

**No complete in-scope mandatory acceptance case is signed off by this matrix.** The requirement calls for at least two real Harness processes, deterministic concurrency barriers and failure injection. Component tests, real `AgentLoop` objects inside one Node process, and short-lived storage/writer subprocesses provide useful evidence but do not replace that run.

Target: official DeepSeek Harness commit `687f282e8625c6b8d11ff58211a90524be2e4317` (`0.2.1-rc.2`), cloud Linux, Node 24.19.0. No live/paid model API or user-machine execution was used. Scenario IDs and meanings come from the supplied requirements (internal reference, not distributed).

## Evidence and blockers

- **C**: component evidence passed at the checkpoint below. It covers only the described assertion, not the whole requirement ID.
- **H**: the real pinned host `AgentLoop`, event types, provider, and keyless recording model adapter were exercised **in process**, using a loopback coordinator transport. Not two host processes and not production transport validation.
- **K**: real child-process `SIGKILL` and persisted recovery evidence. This demonstrates process-crash behavior, not kernel panic, power loss, or arbitrary storage failure.
- **B1**: production Unix-socket startup is blocked in this execution sandbox (`listen EPERM`). A narrow authorized retry failed before launch at sandbox setup. No alternate transport is substituted as acceptance evidence. Two-real-Harness-process and daemon transport/singleton acceptance remain blocked/unrun.
- **B2**: the implemented closed enabled-mode profile still needs production activation and end-to-end enforcement proof. At 09:26 UTC the user explicitly removed the guarantee after disabling the plugin; original R02 is therefore no longer an acceptance obligation. This does **not** waive enforcement while enabled. Unknown installed plugins are unsupported trusted host code, not code another JavaScript plugin can sandbox. Dynamic host loading and tool-result pruning must be disabled; process launch paths must be disabled or truly confined. A closed 20-entry enabled-only profile is now implemented with real-loader/provider/package checks and in-process positive/denial tests, without a host patch. A bounded independent source/correction review passed (55 core + 22 inventory/dump-config tests), with no pinned topology/dependency mismatch found. Actual production activation and complete enabled-profile enforcement are not signed off. Original host source inventory and options (internal reference, not distributed) explains the wider guarantee that triggered the earlier decision request.
- **U**: no implementation or dedicated acceptance proof for the stated subcase. An explicit safe refusal may be implemented without the unsupported operation becoming supported.

Verified checkpoint, 2026-10-21 09:24 UTC:

```sh
node --test --experimental-strip-types tests/messaging.test.ts  # 30 pass at 09:24; 31 pass at 09:30
npm run typecheck                                           # pass
npm run test:components                                     # 120 pass, 2 fail, 122 total
```

The two broader failures were `review-core-regressions.test.ts` non-Git subdirectory resume and lost-open-response recovery: their loopback transport threw `recover_tool_operations` after the provider added that RPC. This is a real red checkpoint, not silently excluded evidence. Later corrections/runs belong in the verification log. Earlier `npm test` (09:18 UTC; before new host cases) was 94/96, with both production server cases blocked by B1. Counts are checkpoint-specific because development is concurrent. At 09:30 UTC messaging passed 31/31 after a red/green full-envelope body-budget fix. At 09:38 the messaging/client/bootstrap/config slice passed 43/43 (32 messaging tests) and typecheck passed. At 09:40 `npm run test:components` passed **173/173**, superseding the earlier two missing-fixture-RPC failures without erasing that red checkpoint. Production socket tests remain excluded/blocked; this is not a transport pass. At 10:01 the component suite passed **220/220**, with typecheck passing, including runtime claims, active-profile inventory, actual root managed-tool flow, corrupt metadata and pre-COMMIT failure regressions. At 10:08 the suite passed **224/224** after actual compaction/reopen, reserved control-directory and auxiliary model-boundary regressions. No full mandatory case is promoted by that count.

At 15:33 UTC, `npm run test:components` passed **286/286**, with no failures or skips, and source typecheck passed. This checkpoint includes 22 rename component/process-crash cases, three registered host-tool rename cases, three R01 baseline cases and 34 simulated storage-fault cases. At 15:36 UTC the broader suite passed **294/294** after six rename source/parent flush-error cases and two ordinary-directory refusal cases; typecheck passed. No row is promoted to full acceptance. The publisher records which immutable commit contains each addition. A later bounded ordinary rename review (internal reference, not distributed) independently ran 75 existing focused cases and source typecheck on frozen `5e13bd3`, with no confirmed functional defect; this is not a security review or full acceptance signoff.

The socket restriction explains B1, not every open row. Unsupported overwrite rename and staged imports are implementation limits. Already-persisted unknown tool results and rename's syscall-to-witness gap can require a persistent recovery hold. Live profile activation, failure-injection coverage and platform testing are separate validation obligations.

Evidence shorthand links to executable source:

| Label | Tests and scope |
|---|---|
| ID | [identity.test.ts](../tests/identity.test.ts): physical roots, Git worktrees, owner CAS, listing scope |
| MSG | [messaging.test.ts](../tests/messaging.test.ts): messages, grants, snapshots, ledger; two storage SIGKILL cases |
| HS | [host-store.test.ts](../tests/host-store.test.ts): canonical handles, append CAS, rollback |
| CO | [coordinator.test.ts](../tests/coordinator.test.ts): dispatch and canonical append integration |
| HP | [host/persistence.test.ts](../tests/host/persistence.test.ts): actual persistence provider, mocked transport failures |
| HR | [host/runtime.test.ts](../tests/host/runtime.test.ts): actual loop, relay attribution, tool recovery |
| HL | [host/coordinator-loop.test.ts](../tests/host/coordinator-loop.test.ts): actual loop + SQLite + loopback coordinator |
| HC | [host/compaction.test.ts](../tests/host/compaction.test.ts): actual BasicCompactionEngine/TokenMeter, durable unresolved reference reconstruction and canonical close/reopen; no process crash |
| HF | [host/filesystem.test.ts](../tests/host/filesystem.test.ts): replacement `ctx.fs` refuses direct mutation |
| WR | [writer.test.ts](../tests/writer.test.ts), [writer-worker.ts](../tests/writer-worker.ts): Linux writer and recovery barriers |
| WF | [writer-storage-faults.test.ts](../tests/writer-storage-faults.test.ts): process-local simulated short writes, `ENOSPC`, and pre/postpublication `EIO`/`EROFS` flush errors; no real disk exhaustion or read-only mount |
| RN | [writer-rename.test.ts](../tests/writer-rename.test.ts), [writer-rename-worker.ts](../tests/writer-rename-worker.ts): no-overwrite rename, both-path fencing, SIGKILL and witness-based recovery; [host/plugin.test.ts](../tests/host/plugin.test.ts) covers registered host tools in process |
| RB | [host/disabled-baseline.test.ts](../tests/host/disabled-baseline.test.ts): actual stock loop/tools/JSONL without collaboration, config-only CLI overlay removal, and explicit partial-toggle refusal; limits (internal reference, not distributed) |
| SV | [server.test.ts](../tests/server.test.ts): **blocked**, not passing production RPC/singleton evidence |
| CT | [client.test.ts](../tests/client.test.ts), [bootstrap.test.ts](../tests/bootstrap.test.ts), [config.test.ts](../tests/config.test.ts): fake-socket generation races, safe private-state preparation and configuration separation; no production transport |
| RF | [review-recovery-fingerprint.test.ts](../tests/review-recovery-fingerprint.test.ts): actual provider reopen rejects changed recipient/body, null fields and extra fields under an existing message key |

## Discovery and execution identity — 7

| ID | Required scenario | Verified narrower evidence | Full-case status / remaining proof |
|---|---|---|---|
| D01 | Same-project, same-directory A/B discovery | C: ID `same workspace discovery excludes other projects` shares physical workspace identity. | Partial; B1: two real host registrations/discovery. |
| D02 | Two worktrees share project, not source-file locks | C: ID creates real Git worktrees and checks common-dir project versus distinct workspaces. WR resource leases are workspace-scoped. | Partial; B1: two host writers. Repository mutation/common-dir operations are denied, not implemented as P2 coordination. |
| D03 | Cross-project C cannot communicate or leak activity | C: ID listing/status isolation; MSG send/body/status/ACK and private event filtering. | Partial; B1: cross-project live transport and all host surfaces. |
| D04 | Case/link aliases cannot create a second write domain | C: ID real symlink root canonicalization; WR denies symlink/hardlink file paths. | Partial; B1. Case-insensitive filesystem, Windows junction and macOS behavior U; Linux-only claims. |
| D05 | Crash/offline/recover gives a new incarnation | C: ID controlled-clock offline detection, owner CAS and stale heartbeat rejection; offline does not imply completion. | Partial; B1: real host death/reconnect and full lifecycle. |
| D06 | Root/subdirectory/overlapping roots cannot split locks | C: ID selected-root canonicalization and `WORKSPACE_OVERLAP`. | Partial; B1. Non-Git resume regression initially red because of missing test transport RPC; corrected and green in the 09:40 component run. |
| D07 | Two processes recover one session; old executor fenced | C: ID CAS, HS exclusive write handles/read-only observers, WR stale renew/release/write denial, MSG stale batch admission denial. | Partial; B1: genuinely simultaneous real host recovery and scheduling fence. |

## Messaging and context — 23

| ID | Required scenario | Verified narrower evidence | Full-case status / remaining proof |
|---|---|---|---|
| M01 | Running B receives durable attributed message at next boundary | C/H: CO exact host event+receipt transaction; HR/HL actual loop observes nonhuman relay before model call. | Partial; B1: real two-process transport and scheduling. |
| M02 | Idle B queues without automatic turn, receives after resuming | C/H: MSG preserves idle state; HL asserts no request before explicit followup, then receives once. | Partial; B1: live idle host resume. |
| M03 | Same key deduplicates; changed content conflicts | C: MSG immutable sender-scoped fingerprint includes recipient/content. | Partial; B1: same retry through production RPC/restart. |
| M04 | Delivery crash/restart has no lost/duplicate canonical append | C/K: MSG outer rollback and SIGKILL after canonical event+receipt commit; HP stable append ID after lost response. | Partial; B1: actual host process kill at fetch/append/reply boundaries. |
| M05 | Compaction/restoration retains unresolved matters and cursors | C/H: HC actually compacts away the relay/index, omits its ID from the summary, and rebuilds the acknowledged unresolved reference from SQLite at the next model boundary. | Partial; B1; U: concurrent compaction/checkpoint-switch crash acceptance. |
| M06 | Budget/flood/duplicate event handling stays bounded and fair | C/H: MSG mailbox/part limits and notification independence; HL multi-boundary Unicode draining under total configured budget. | Partial; B1; U: sustained flood/fairness stress and permanently incompatible budget resolution. No claim of progress with no available boundaries. |
| M07 | Unauthorized messaging blocked; relay cannot grant authority | C: MSG default deny, keyed one-message grants, scoped migration; HR source remains nonhuman. | Partial; B1: host human approval bridge and denial UI end-to-end. No model grant tool exists. |
| M08 | Notification queries do not consume automatic delivery; resync works | C: MSG separate poll/mailbox progress and retention-floor `RESYNC_REQUIRED`. | Partial; B1: concurrent production long-poll and host intake. |
| M09 | Same-project outsider cannot read A/B private events | C: MSG participant filtering, body/status denial and cursor binding. | Partial; B1: authenticated transport and host result surfaces. |
| M10 | Old batch holder cannot commit after receiver takeover | C: MSG stale incarnation/revision/fabricated record rejection; actual canonical evidence required. | Partial; B1: paused B1 and recovered B2 in real processes. |
| M11 | Partial batch ACKs only actual parts and preserves FIFO holes | C: MSG exact partial receipts/out-of-order rollback; HS canonical CAS. | Partial; B1: host persistence interruption mid-batch and recovery. |
| M12 | Snapshot/pagination and H cover concurrently committed changes | C: MSG immutable multi-page snapshot/H plus a later inserted event; sequence allocation shares SQLite writer transaction. | Partial; B1; U: deterministic two-process commit-order stress. Sequential insertion is not that proof. |
| M13 | Pruning notifications preserves mailbox and deduplication | C: MSG deletes published event prefix, then delivers old mailbox/reuses original send key. | Partial; B1: offline actual receiver recovery; mutation retention cross-check needed. |
| M14 | Large token count, crash/model change, stable bounded fragments | C/H: MSG scalar-safe UTF-8 parts, unchanged IDs on smaller budget, full read-result JSON/cursor/envelope budget; HL drains 7000-byte Unicode through multiple real loop boundaries within configured 2000 bound. | Partial; B1. Actual model/tokenizer switch U; bound applies only to explicitly supported UTF-8-byte BPE plus proven framing. Unknown tokenizer is not certified. |
| M15 | ACK-not-resolved survives compaction/admission race and kill | C/H: MSG explicit monotonic ACK/resolution; HC actual compaction and canonical reopen preserve acknowledged unresolved references and exact projection, without relay duplication. | Partial; B1; U: compaction concurrency/SIGKILL acceptance. |
| M16 | Commit-before-notify and publish-before-mark crash deduplicate | C/K: MSG SIGKILL after send commit retains one message/outbox; unpublished outbox stops pruning. Stable event IDs exist. | Partial; B1; U: actual publisher kill after external publication before mark and duplicated delivery notification. |
| M17 | Sender scope, restart retry, changed-recipient conflict | C/K: MSG A/C same key independence, changed recipient conflict, persisted send retry after SIGKILL. | Partial; B1: authentic session recovery through production provider. |
| M18 | Revocation competes safely with fetch/admission | C/H: MSG persisted barrier, expiry, restart and partial facts; HL revokes between actual pre-step fetch and append and proves no model request or relay row. | Partial; B1: simultaneous real callers/control plane race. |
| M19 | Mailbox full or storage failure never silently drops accepted data | C: MSG byte ceilings and SQLite abort trigger roll back all send rows; old body/dedup survives. | Partial; B1; U: real ENOSPC/storage fault environment. A trigger is not disk-full durability proof. |
| M20 | Changing caller cannot reuse body/ACK/cursor/snapshot authority | C: MSG private operations, body cursors, snapshot pages; ID listing filter/caller binding. | Partial; B1: wire authentication and all surfaced tool handles. |
| M21 | Partial terminal slot permits later authorized traffic | C: MSG revoke/expiry closes slot with admitted facts; later separately authorized message progresses. | Partial; B1: live partial delivery then revoke and resume. |
| M22 | All parts committed before response; revoke then restore | C/K: MSG SIGKILL after host event+ledger commit, then revoke: remains delivered, no reappend or new body authority. | Partial; B1: actual receiver process event persistence/recovery. Atomic same-store ledger removes a separate receipt-ACK gap. |
| M23 | Old checkpoint cannot silently lose already-confirmed content | C: MSG removed canonical evidence causes `CONTEXT_CONFLICT`/repair pause even for delivered messages; canonical store is authoritative. | Partial; B1; U: actual older host checkpoint/compaction lineage restoration acceptance. |

## Managed shared-file writes — 23

| ID | Required scenario | Verified narrower evidence | Full-case status / remaining proof |
|---|---|---|---|
| F01 | Conflicting same-file claims yield exactly one lease | C: WR exclusive claim/`FILE_BUSY` and group atomicity. | Partial; B1: simultaneous real host calls. |
| F02 | Old read h1 cannot overwrite A's h2 after acquiring new lease | C: WR stale expected version rejected and h2 preserved. | Partial; B1: two actual host tool sequences. |
| F03 | Reread h2 and strict patch preserves both intentions | C: WR read receipt + strict patch yields h3 containing both test edits. | Partial; B1: real tool continuation and human-facing conflict result. |
| F04 | Expired holder cannot write after a new fencing token exists | C: WR controlled monotonic expiry and stale-fence denial. | Partial; B1: paused/resumed host executor. |
| F05 | Lost write response retry returns original mutation result | C: WR retry after lease release/later changes returns committed result without another effect. | Partial; B1: production response-loss injection. |
| F06 | Exposed create/delete/rename paths are mediated or refused | C: WR create-null precondition and delete; RN ordinary same-filesystem no-overwrite rename preserves bytes/inode, validates both leases/read receipt, and runs through the actual registered host tool in process. | Partial; B1/B2: all live host entry points. Overwrite, cross-filesystem and directory moves remain unsupported; no copy/delete fallback. |
| F07 | Traversal/link aliases cannot bypass protection | C: WR traversal, symlink, hardlink, directory and Git-internal rejection on Linux. | Partial; B1/B2. Junction, cross-platform alias and hostile filesystem matrix U. |
| F08 | Shell/script/formatter cannot bypass the writer | C: HF direct `ctx.fs` refusal including danger-full-access request; CO unknown method denies. | **B2 / unverified enabled-profile boundary**. These tests alone do not constrain shell children, MCP startup, browser terminals or installed host code. Unknown profiles/plugins are outside the supported composition; no sandbox claim is made for trusted same-process code. |
| F09 | Truncated read cannot authorize whole-file replace | C: WR raw-byte receipt completeness, strict partial-range patch, window boundaries and Unicode byte caps. | Partial; B1: real legacy read-tool output and approved managed tool routing. |
| F10 | Independent files progress without a model-round global lock | C: WR deterministic internal publication barrier permits another resource to complete. | Partial; B1: two real host processes/model rounds. SQLite commit serialization is short, not a claimed model-round lock. |
| F11 | One conflicting path causes all-or-none group claim | C: WR group failure leaves no partial new leases. | Partial; B1: concurrent production claim requests. |
| F12 | Crash at every durable write stage yields recoverable/frozen state | C/K: WR replace/create/delete SIGKILL matrix; RN rename SIGKILL at eight boundaries, including both sides of the durable publication witness. | Partial; B1: actual host operation lifecycle. Remaining storage-error/platform validation and power-loss durability are separate, uncompleted obligations. |
| F13 | Coordinator disconnect pauses writes with no raw fallback | C: CO unknown method refuses; HF direct write/edit refuses; HR no model dispatch after failed canonical flush. | Partial; B1: real socket loss. **B2** for all enabled-profile inherited providers/tools and process launch paths. Plugin-disabled protection was removed by the user. |
| F14 | External change rejects stale write and is not falsely attributed | C: WR stale hash, target-swap and external same-hash/different-inode tests; conflict details say `external/unknown`. | Partial; B1; U: all notification surfaces. No claim to block arbitrary unmanaged writes after validation. |
| F15 | Content/version/read token come from the same raw snapshot | C: WR same raw-byte receipt, BOM/CRLF/no-op preservation. | Partial; B1; U: adversarial two-writer read-time barrier in actual host. POSIX rwx mode preservation also passed in the 09:40 component run. |
| F16 | Ancestor/parent replacement cannot redirect child writes | C: WR parent, mutation artifact and target-swap publication barriers refuse; directory operations denied. | Partial; B1/B2; Linux descriptor-relative path evidence only, no cross-platform promise. |
| F17 | Staged tool uses pre-execution baseline for conflict detection | **U**: staged external tool execution/import is not implemented. | Unsupported operation, not a passing case. P0 route is denying such tools, whose complete enforcement is B2. |
| F18 | Partial multi-file staged import retries only unresolved effects | **U**: staged multi-file import is not exposed. Individual mutation idempotency exists but is not import evidence. | Unsupported operation; implement and test only if staged execution is later approved. |
| F19 | Ambiguous publication blocks new read tokens/writes until recovery | C: WR corrupted/symlink artifacts and unknown-outcome refusal; WF postpublication flush failures freeze reads, claims, renewals and mutations while independent files progress. C/K: RN missing witness or changed destination freezes both paths after recovery. | Partial; B1: separate actual receiver attempts while recovery is paused. Rename syscall-to-witness ambiguity remains a recovery hold, not an inferred success. |
| F20 | Old fencing tokens never regain validity across release/restart | C/K: WR persistent increasing fence, stale incarnation and restarted recovery cases. | Partial; B1: old live executor surviving coordinator transitions. |
| F21 | UTC jumps and in-flight expiry/cancel cannot transfer early | C: WR controlled clocks, in-flight expiry/release and lifecycle release barriers. | Partial; B1: real cancellation/process lifecycle and wall-clock adjustment. |
| F22 | Rename target collision/missing precondition/cross-volume refused | C: RN source/destination leases, source read/version receipt and explicit `expected_target_version: null`; existing and publication-time racing targets remain intact. Missing fields and overwrite requests are refused. | Partial; directory rejection has dedicated source/target cases. Cross-filesystem rejection is implemented but has no actual cross-mount fixture here. Destination overwrite lacks a conditional replacement primitive and is unsupported. Live host entry-point proof remains B1/B2. |
| F23 | Incremental X/Y cross-claims never deadlock under renewal | C: WR nonblocking conflicting claims return without acquiring second resource. | Partial; B1: real tool retry/release policy; no automatic infinite renewal policy is claimed. |

## Lifecycle and recovery — 10

| ID | Required scenario | Verified narrower evidence | Full-case status / remaining proof |
|---|---|---|---|
| L01 | Complete/cancel/fail/crash update state and release/reclaim safely | C: ID states/presence, WR lifecycle/in-flight barrier and HP close retry. | Partial; B1: complete real host lifecycle matrix. Offline remains distinct from completion. |
| L02 | Two daemon starters produce one coordination domain | SV exists but could not start due to B1. Direct native-flock component evidence refuses two configured directories for one OS user; workspace registration excludes the fixed control namespace. Production uses kernel-held guards, not a stale-file advisory convention. | **Blocked B1**, no passing simultaneous daemon/process acceptance. |
| L03 | Paused old daemon/helper cannot coexist with a new writer | Source design uses OS-held singleton and coordinator epochs. No dedicated paused-live-helper acceptance executed. | **Blocked B1 / U**. Do not substitute PID/mtime checks or kill-free lease theft for this proof. |
| L04 | Paused recovery fences same resource but not unrelated safe files | C: WR frozen resource and independent-resource barrier tests are separate component evidence. | Partial; B1; U: paused recovery with simultaneous same/unrelated actual callers. |
| L05 | Repeated recovery kills and repeated outbox publication deduplicate | C/K: WR and RN recovery killed twice before commit; each yields one logical terminal mutation event. | Partial; B1; U: production publisher repeated delivery/mark crash loop. |
| L06 | Storage failures around prepare/flush/publish/commit never promise unsafe success | C/K: WR SIGKILL boundary matrix. C: WF short-write completion, partial-write `ENOSPC` abort, prepublication `EIO`/`EROFS` abort, persistent postpublication flush-error freeze, restart/recovery and cleanup-only failure retain the appropriate result. | Partial; unrun: actual disk-full, read-only filesystem, hardware fsync failure, power-loss and platform matrix. These syscall errors are simulated in-process; they are not physical storage-failure proof. |
| L07 | Original mutation retry survives restart/stale lease/later content | C/K: WR original result after release/later write, removed old parent, committed-stage process kill. | Partial; B1: real tool result transport loss and host/coordinator restart combination. |
| L08 | No-op/missing target/same external hash cannot fabricate ownership | C: WR explicit no-op, external same-hash different-inode and corrupt evidence. C/K: RN external move-shaped state, witness-gap SIGKILL and postpublication external edit are not falsely attributed as committed rename. | Partial; B1: actual API calls and remaining external interleavings. Rename recovery requires a durable syscall-success witness, unchanged parent identities, matching destination inode/hash and absent source. |
| L09 | Persisted effect/unknown tool result recovered before model replay | C/H: HS append idempotency; HP lost reply; HR actual loop holds every model seam on unknown outcomes and restores a known result before stock interruption repair. RF provider-reopen tests enforce the original send fingerprint. | Partial; B1: real crash after effect/before tool result and restart. Implementation limit: an already-persisted unknown result cannot be safely relabeled through the pinned host's content-only rewrite; the plugin retains a hold rather than fabricating clean success. |
| L10 | Aborted prepared mutation ID remains terminal on retry | C/K: WR prepared fault and SIGKILL return the original abort. C: WF prepublication simulated storage failure remains aborted across reopen and cannot replay under the same ID. | Partial; B1: same request from a resumed real host. New logical work requires a new ID. |

## Regression and protection transitions — 2

| ID | Required scenario | Verified narrower evidence | Full-case status / remaining proof |
|---|---|---|---|
| R01 | Feature-disabled single-session host retains existing behavior | C: RB actual stock AgentLoop read/write/edit and JSONL create/close/reopen without collaboration; complete overlay omission restores identical stock CLI configuration; partial `enabled:false` rejects before bootstrap. | Partial. Full stock-profile boot, live package uninstall and the upstream full regression suite are unrun. The fixture uses stock LocalFileSystem; config composition separately checks original fs-sandbox selection. No collaboration-to-JSONL session migration is claimed. |
| R02 | Original: disabling one participant must not restore bypass writes | **Scope changed by the user at 09:26 UTC:** plugin-disabled protection is no longer required. Original R02 is retained here for traceability, not falsely marked passing. | **Removed from current required scope.** Enabled-mode protection remains mandatory under B2: pinned audited profile, no unknown plugins, no dynamic loading, tool-result pruning disabled, and real bypass tests. |

## Explicit platform and release limits

- Current evidence uses Linux local filesystems, process-crash tests and simulated syscall failures. macOS, Windows, junction/case-insensitive variants, NFS/network filesystems, and actual power failure are unverified; the Linux descriptor-relative writer is not a portable promise.
- No paid model endpoint or tokenizer certification. The byte-based bound is conditional, not the host's approximate characters/4 heuristic.
- Enabled-mode shell/MCP/process/plugin-composition enforcement is an essential P0 verification task, not a P1 enhancement. The user removed disabled-mode enforcement, not enabled-mode checks. No full enabled-profile security claim is made while B2 remains.
- P1 task scheduling/results, P2 spawned agents/worktrees, and P3 richer group/UI/workflow features remain extension points only. Worktree identity recognition in D02 does not implement worktree orchestration.
- A publish/install success, test-name prefix, code path, or component pass cannot close a row above. Record real commands, environment, deterministic barrier, observed result and limitations before changing a full-case status.
