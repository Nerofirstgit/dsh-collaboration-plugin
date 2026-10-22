# Verification log

## Core slice, 2026-10-21 09:09 UTC

Environment: cloud Linux, Node v24.19.0. Official host packages `0.2.1-rc.2` installed; no API keys/model endpoint used. Targeted command:

```
node --import tsx/esm --test tests/identity.test.ts tests/host-store.test.ts tests/host/persistence.test.ts
```

Result: **13 passed, 0 failed**. These are core/provider component tests, not the required two-real-Harness-process acceptance run and not a claim that every requirement ID in a test name is fully satisfied.

Development failures preserved here: native Node strip-only mode refused parameter properties; changed source test loader to the host-compatible tsx ESM loader. Two new host-store tests omitted the write handle's private identity, correctly failed with STALE_INSTANCE, then were corrected to authenticate their reads. A typecheck during concurrent development found incomplete runtime/writer type narrowing; full-project typecheck had not yet passed at this slice.

The first messaging and writer tests intentionally ran red against absent/scaffold implementations (test-driven development). Their results will be recorded separately once the implementations are complete. No Windows/macOS or power-loss test has run.

## Reviewed core corrections and component integration, 09:28 UTC

Independent review of `699b1138` found seven genuine defects despite the original 13 green tests: physical data-directory alias overlap; explicit pending append incorrectly draining a newer live buffer; non-Git project-root loss on resume; seeded session create/cursor handling; lost close response retry; closed credentials still authenticating; and lost open response leaking an inaccessible writer handle. All seven have code fixes and permanent tests in `tests/review-core-regressions.test.ts`. Their desired-behavior probes originally failed in the independent frozen review.

The real root plugin test then caught that the host forbids a global `tools.restrict`: it must be installed on each newly created agent context. Corrected that integration, retaining the independent global monotonic definition-identity guard. Added an explicit agent-loop dependency on sessionPersistence so asynchronous coordinator connection cannot race ordinary loop startup. Profile composition validation remains separate.

`npm run test:components`: **128 passed, 0 failed, 0 skipped**. Includes actual upstream AgentLoop/tool pipeline with a keyless model fixture, real SQLite canonical event/ledger commits, and child-process SIGKILL writer/message recovery. These are not the required two simultaneously running real Harness applications.

Production Unix transport test attempted with its original socket: **BLOCKED** by cloud `listen EPERM`. One narrowly scoped retry failed in the execution wrapper before running the command (`bwrap` could not create its configured read-only sessions path). No denied path was read, no policy was changed, and no alternate production transport was introduced. `tests/server.test.ts` and the planned actual two-Harness-process test must run unchanged in a supported Linux environment. Do not infer singleton transport/two-application acceptance from the in-process tests.

User scope revision at 09:26 UTC: plugin-disabled/unloaded collaboration protection is no longer required (original R02 superseded). Enabled-mode protection remains required. No host source modification is authorized or applied. The active-profile enforcement assessment is being revised; managed model writes remain denied until that integration is established.

## Second review corrections, 09:40 UTC

Independent re-review confirmed the original seven fixes, then found four adjacent defects: durable close failure dropping ownership before revocation; pending-open retry after disconnect retaining stale CAS; definitive missing-session poisoning future create; and recovered send-message success incorrectly using an older conflicting idempotency key. These now have retained regression tests and corrections. Close/revoke is atomic; storage failure on disconnect denies old incarnation in memory while retaining the ownership barrier. Message outcome recovery uses the exact shared immutable request parser, including null/extra-field rejection, and never enqueues/replays a send.

The separate writer review found two genuine defects after its original green suite: a staged new leaf was not fully revalidated before publication, and a durable create commit before cleanup could leave a hardlink artifact that startup ignored. Corrections validate staged identity/type/link/hash/metadata and clean only proven owned terminal artifacts. New real SIGKILL tests cover the previously missed commit-before-cleanup window for create, replace and delete. Previously saved reviewer evidence was reused for defensive regressions; no blocked review operation was retried.

Client-generation and bootstrap-path checks added 11 focused cases without binding any socket: fake socket objects are a unit-test seam only, never an alternate production transport. Per-process display/workspace settings no longer contaminate the shared coordinator configuration. A bounded runtime claim manager has controlled-clock tests; root wiring remains work in progress at this checkpoint.

`npm run typecheck`, `npm run build`: **pass**. `npm run test:components`: **173 passed, 0 failed, 0 skipped**. A production two-real-CLI-process test using the unchanged Unix coordinator and a local keyless Messages-API endpoint has been preserved in `tests/integration/two-host-processes.test.ts`; only syntax was checked. It is **UNRUN/BLOCKED**, not a passed acceptance scenario. The full 65-case matrix remains open. The minimal profile dump composes 21 allowed rows; active real-loader validation and managed-write activation are still being completed.

## Enabled-profile development slice, 10:01 UTC

`npm run typecheck`: **pass**. `npm run test:components`: **220 passed, 0 failed, 0 skipped**. Production socket tests remain excluded for the previously established environment blocker; no bind retry or alternate coordinator transport was made. The two-real-host fixture is still syntax-checked only, and all complete in-scope mandatory acceptance cases remain unsigned.

The plugin now verifies a closed **20-entry** headless profile using the real loader topology, exact module/package identities and versions, concrete filesystem/persistence providers, required startup injections, and safety-relevant configuration. The checkpoint-policy wrapper was removed from the audited composition because its asynchronous dispatch would weaken the final synchronous tool gate. Profile checks run before readiness, model boundaries and final tool execution. A detached real-loader inventory plus actual root/AgentLoop/service assembly exercises successful managed create/read/edit/replace and rejection paths in-process; this is **not** a production profile boot or an independent enforcement certification. Arbitrary same-process plugins remain unsupported trusted code, not sandboxed code. No host patch was applied.

Runtime-owned claim renewal is wired into real lifecycle events, including overlapping human approvals. The authoritative coordinator is consulted for every implicit claim; a cached expired lease is never revived. The real root-tool test verifies that a committed send followed by a lost response leaves the original operation pending and blocks a second model request rather than replaying it. Unknown diagnostics already persisted in the canonical log are conservatively held if the host cannot safely rewrite their metadata.

Added a fixed per-Linux-user/mount-namespace kernel instance guard in addition to the configured data-directory guard, preventing two live writers merely by choosing different state directories. A direct native-flock component test passes; this is not two-daemon transport acceptance. Store initialization now rejects missing/corrupt domain credentials, unsafe epochs, unsupported schema versions and unrecognized existing databases without recreating authority.

Additional red/green evidence: the new root fixture initially referred to a nonexistent `leases` table; corrected to the real `writer_leases` schema before its positive checks passed. A deliberate pre-COMMIT failure exposed an in-memory handle for a rolled-back create (`1 !== 0`); handle publication was moved after durable commit, and the retained regression now passes. Tiny context budgets (1, 64, 200) now fail before model dispatch when mandatory framing cannot fit.

Packaging invokes compilation through `prepack`. The tarball was inspected for expected compiled entrypoints and absence of databases, keys, upstream checkout or dependencies; compiled exports were imported from an extracted archive using the already pinned development dependencies. This is **not** a clean dependency installation, plugin mount, model request, Unix transport test, or production startup proof. The parent task is the sole publisher of private WIP development-branch snapshots; the cloud git repository and tarball are not themselves a verified remote release.


## Compaction and final boundary corrections, 10:08 UTC

`npm run typecheck`: **pass**. `npm run test:components`: **224 passed, 0 failed, 0 skipped**. Two new tests mount the actual pinned BasicCompactionEngine, TokenMeter and default summarizer with a local recording model adapter. The summary deliberately omits an acknowledged unresolved message ID; after compaction and again after canonical close/reopen, the next model request rebuilds the durable reference, preserves exact compacted surface/projection and does not duplicate relay/ledger evidence. These are in-process functional regressions, not process-crash or production activation acceptance.

Two bounded defensive regressions ran red before corrections: registering a broad `/tmp` workspace with state elsewhere did not exclude the fixed instance-control directory; and an auxiliary compaction-purpose model call bypassed the unknown-original-tool pre-step hold. Registration now excludes the reserved control namespace, and the universal `llm/stream` seam checks original outcomes after its durable flush. No lock pathname was modified in the overlap regression, no second daemon was started, and no transport restriction was retried.


## Independent frozen correction/source review, 10:14 UTC

A separate reviewer checked frozen `70eeee4a622d68dd8b9e5f3c9ab4babd113688bf` in an isolated archive. The four saved prior-revision probes were copied byte-for-byte and pass unchanged; the original seven remain green. Independent focused results: **55 core/correction tests + 22 profile inventory/dump-config tests pass**, and typecheck passes. Source inspection found no pinned Loader topology or startup dependency mismatch in the ordinary supported composition. See the [full bounded report](reviews/70eeee4.md).

This review did not rerun the author's full 224-test suite/build, activate the installed profile, bind a socket, repeat a blocked writer-review operation, or perform wider platform testing. No new confirmed blocker was found within its requested scope; this is not full P0 approval. Production boot, two-real-host acceptance and all remaining matrix gates remain open.

## Safe non-bind gap closure, 15:36 UTC

The socket restriction is not a reason to leave unrelated implementation and verification gaps untouched. This slice adds three explicitly scoped improvements without changing transport, host source, security settings or the immutable earlier publication snapshot:

- **R01:** three tests execute actual stock read/write/edit tools and JSONL create/close/reopen without collaboration, compare official CLI stock configuration before/after omitting the complete overlay, and verify partial `enabled:false` refuses before bootstrap. This is in-process stock behavior plus config-only CLI execution, not a full profile boot, package uninstall or persistence migration.
- **Storage faults:** 40 tests inject short/partial writes, `ENOSPC`, and `EIO`/`EROFS` into actual `node:fs` write/fsync calls for fixture-owned descriptors. They assert abort before publication, freeze after uncertain publication, no false success while flushes still fail, restart recovery, one terminal event/outbox and conservative cleanup. Rename cases cover its source inode and each affected parent. These are simulated syscall errors, not actual disk exhaustion, remounts, SQLite VFS failures, hardware/power-loss tests or a replacement for the denied transport run.
- **Ordinary rename:** 24 dedicated tests and three actual registered-tool tests cover a same-filesystem no-overwrite implementation, both path claims/fences, source receipt, explicit absent destination, existing/racing target conflict, directory refusal, original terminal retries, eight genuine SIGKILL boundaries and repeated recovery interruption. The original positive rename test initially failed against the previous blanket refusal; the existing incomplete-request assertion was updated to the new required-argument contract rather than deleting the refusal check. The writer now calls one fixed `renameat2(RENAME_NOREPLACE)` function through pinned `koffi@3.1.1` inside the coordinator. This dependency was already in the pinned host tree; it is now declared directly, and offline lockfile reconciliation passed. No helper, shell, alternate transport or copy/delete fallback exists.

Rename recovery is deliberately conservative: without a durable syscall-success witness, a source-absent/destination-present shape cannot distinguish this writer's action from an external move. Both paths remain `needs_recovery`. With that witness, source absence, original destination inode/hash and recorded parent identities permit flush and terminal commit exactly once. Destination-overwrite rename remains unsupported because the chosen primitive does not provide expected-target conditional replacement. Cross-filesystem refusal is implemented, but a real cross-mount fixture has not run.

Commands/results:

```sh
npm run typecheck                       # PASS
npm run test:components                 # 294 PASS, 0 fail, 0 skipped
node --import tsx/esm --test tests/writer-storage-faults.test.ts # 40 PASS
node --import tsx/esm --test tests/writer-rename.test.ts         # 24 PASS
```

Separate strict test-file typechecks passed for the new rename/host-tool and storage-fault suites. A preceding broader checkpoint passed 286 tests, then 292 after rename flush-error cases, then 294 after source/target directory refusal cases. No assertion failure was hidden by counting the production server tests as skipped; those tests were not run, per the existing restriction. `npm run build` and `npm pack` passed for this slice before final documentation refresh; the final archive is inspected again at packaging handoff.

The user's later authorization permits private WIP delivery to `main`; the parent is the sole publisher and verifies remote state independently. Neither a main-branch checkpoint nor these additional tests certify full P0 acceptance. Remaining actual-profile activation, original transport and two-real-Harness-process scenarios are still unrun/blocked; already-persisted unknown-result repair and unsupported operations remain explicit implementation limits rather than being mislabeled socket blockers.

A subsequent strict combined test-file check (including the disabled baseline) found missing declarations for the host's transitive `js-yaml` package (`TS7016`); the production source check had correctly passed because it excludes tests. The baseline now loads that existing package through a narrow test-only typed adapter returning `unknown`. No runtime parser was replaced and no new dependency was fetched. The combined test-file typecheck and baseline tests were rerun after this correction.

## Fresh offline archive installation, 15:42 UTC

The `5e13bd3` source archive (168,800 bytes, SHA-256 `7bad55ed12ec4bfbdd07d43f14d7d663dc5c7e1ae88eabc38b635eefa9e34ff1`) was installed into a new empty, task-owned npm fixture. Its copied development manifest/lockfile renamed the fixture root to avoid installing itself; development lifecycle/packaging fields were omitted from that fixture manifest, while the pinned dependency graph was retained. `npm ci --offline --ignore-scripts --no-audit --no-fund` installed 622 pinned packages from the task's existing cache; `npm install --offline --ignore-scripts --no-audit --no-fund /absolute/archive.tgz` installed the actual archive as one additional dependency. No source-link or reuse of an existing node_modules directory, network request, new package version or package lifecycle execution was used for that installation.

The retained smoke check resolves the installed package's exported plugin/filesystem entrypoints and imports compiled JavaScript, then exercises compiled native no-overwrite rename on its own disposable ordinary files. A destination collision preserves both files. The installed archive contains `lib/native-rename.js` and no databases, keys, logs, dependencies or upstream checkout.

```sh
node tests/installed-package-smoke.mjs .tmp/offline-install-5e13bd3
# compiled_exports PASS; compiled_native_rename PASS; existing_target retained
# host_mount NOT RUN
```

This closes the fresh dependency/archive packaging gap for the cached pinned Linux environment only. It does not execute the official host plugin-management command, activate a profile, contact a model, or bind any socket. Later documentation/test-only commits do not change the production modules tested by this archive; final packaging metadata is supplied separately for each immutable snapshot.


## Retained bounded rename review and resumed handoff, 20:32 UTC

The independent reviewer completed the previously requested ordinary-functionality/source review at approximately 15:45–15:47 UTC. The saved isolated report and unedited command outputs were inspected on resumption, not inferred from an agent status message: **75 existing focused tests passed, source typecheck passed, no confirmed functional defect was found within that scope**. Reviewed production blobs were frozen at `5e13bd3`; later `2ee32ad`, `17e23c1` and `b60c140` change tests/documentation only. Their `src`, package manifest and dependency-lock diff against the reviewed commit is empty. The [retained report](reviews/5e13bd3-ordinary-rename.md) states its exact scope, hashes, commands and remaining limits.

The saved final author-run component output still records **294 passed, 0 failed, 0 skipped**. These results are the earlier completed runs, not a claim that long suites were rerun after the tool-wait interruption. No remote publication outcome is inferred from local files or a canceled tool wait. The parent publisher separately reconciles GitHub state. No transport retry, new probe or security-setting change occurred during this reconstruction.
