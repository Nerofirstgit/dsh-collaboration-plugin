# Development handoff — not a P0 acceptance certificate

## What is delivered

An installable Cordis/dsh bundle for the pinned DeepSeek Harness `0.2.1-rc.2`, upstream commit `687f282e8625c6b8d11ff58211a90524be2e4317`. The root plugin integrates the actual host session provider, AgentLoop lifecycle, model admission and tools. Its private coordinator owns SQLite identities, canonical events, messages and managed file publication; it is not another assistant application.

Source, tests, installation guidance and all 65 original acceptance IDs are retained. P1–P3 remain extension points. Upstream source is unchanged. The user's explicit scope revision removes disabled/unloaded protection only; enabled-mode gates remain mandatory.

Engineering and artifacts are in the cloud workspace. The local git branch named `main` is not evidence of remote GitHub state. Only the parent task publishes allowlisted immutable WIP snapshots to private `Nerofirstgit/dsh-collaboration-plugin`. The user has now authorized WIP delivery to `main`; the publisher retains repository history and records the exact commit and outcome. This does not assert that delivery has completed. A source checkpoint or successful tarball build is not a production release, deployment or public package publication.

## Reproduce safe development evidence

From the source checkout, with the pinned dependency lockfile:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run test:components
npm pack
```

`prepack` compiles the installable entrypoints. Inspect the tarball list before sharing; it must not contain runtime keys, SQLite files, recovery artifacts, logs, dependencies or the upstream checkout. Development tests used Node 24.19.0 on cloud Linux. In addition to earlier extracted-archive imports, a fresh isolated offline npm installation of the pinned dependencies and actual archive now passes compiled-export and native no-overwrite rename smoke checks. Lifecycle scripts were disabled; the archive was not source-linked. This is not a host profile mount or an official `dsh plugin add` acceptance run. See the reproducible command and exact scope in the verification log.

The 2026-10-21 15:36 UTC checkpoint passed **294/294 component tests**, with no failures or skips, and source typecheck passed. It includes 24 rename component/process-crash tests, three registered host-tool rename cases, three disabled-baseline cases and 40 storage-fault cases. Earlier 224-test and build evidence remains in the [verification log](verification-log.md). No two-real-Harness-process pass is claimed.

## Current additions and implementation limits

- R01 now has a real stock `AgentLoop` baseline with official read/write/edit tools and JSONL create/close/reopen. No collaboration bundle is mounted. CLI config composition returns to the stock profile when the complete overlay is omitted, while partial `enabled:false` rejects before bootstrap. This is not a full-profile boot or live package uninstall. It does not migrate existing collaboration SQLite sessions to JSONL. See [the scoped evidence](disabled-baseline-evidence.md).
- The focused storage-fault tests inject short writes, partial-write `ENOSPC`, and `EIO`/`EROFS` at staging, directory and cleanup flushes. Prepublication failures retain terminal aborts; uncertain publication blocks affected operations until recovery. Cleanup-only failure preserves a committed result. These are controlled in-process errors, not actual disk exhaustion, remounting or power-loss tests.
- Same-filesystem ordinary file rename is now implemented with the Linux `renameat2(RENAME_NOREPLACE)` primitive, both current leases and source read/version receipt. The destination must explicitly be absent. Focused component, registered host-tool and SIGKILL cases pass at the checkpoint above; source-inode and both-directory flush-error cases also pass. A separate bounded source/ordinary-functionality review ran 75 existing targeted cases and typecheck on the frozen production files, finding no confirmed functional defect; see [the exact review scope](reviews/5e13bd3-ordinary-rename.md). It is not a security or full acceptance review.
- Rename recovery needs a persisted syscall-success witness, unchanged parent identities, matching destination inode/hash and absent source before committing. If the syscall may have succeeded but its witness was not persisted, a move-shaped namespace is insufficient: both paths stay `needs_recovery`. Do not replay the move with a new ID.
- Destination overwrite is unsupported because no conditional target-replacement primitive is implemented. Cross-filesystem moves and directory moves are rejected, with no copy/delete fallback. Staged external-tool execution/import is also unsupported. Those are implementation limits, not consequences of blocked sockets.
- A known original effect can be repaired before the stock host records interruption. Once an unknown result is persisted, the supported host API cannot safely relabel its error metadata. The plugin holds model execution; automatic repair of that state is not implemented.

These additions describe the active source tree. They do not imply that an earlier immutable publication snapshot contains them.

## Blocking gates and exact next evidence

1. **Enabled-profile activation proof:** the [bounded independent correction/source review](reviews/70eeee4.md) found all four remaining core findings fixed and no pinned Loader topology/startup dependency mismatch (55 core + 22 profile tests, typecheck pass). This is not a live boot or full protection certificate. Configured unknown same-process plugins are refused; arbitrary installed JavaScript is not sandboxed. Do not broaden the supported profile without evidence.
2. **Original Unix transport:** `tests/server.test.ts` is blocked in this sandbox by `listen EPERM`; one prior narrow retry failed before execution in sandbox setup. Do not retry the denied setup, change security settings, or introduce a substitute production transport to make tests green.
3. **Two actual applications:** the preserved `tests/integration/two-host-processes.test.ts` starts two pinned CLI processes and uses a keyless local HTTP fixture only for the model endpoint. The coordinator still uses its original Unix socket. This fixture is syntax-checked but unrun. Report a supported, authorized **cloud** environment option before running it; never move the work to the user's computer.
4. **Remaining mandatory evidence:** close the individual [matrix](acceptance-matrix.md) rows with deterministic process barriers, exact durable rows/final bytes, and real observed outcomes. No complete in-scope mandatory case is currently signed off. Process-kill and simulated syscall-error evidence are not actual disk exhaustion, hardware fsync failure, power-loss or non-Linux portability proof. Unsupported operations and recovery holds above remain separate from this missing validation.

No real model endpoint, new API key, unrelated project secret, host patch, deployment or security-setting change is needed for the component checks. Obtain separate authorization for such actions rather than inferring it from permission to develop the plugin.

## Operational safety during further development

- Keep all participants on the same private state directory and exact supported profile. State and the fixed per-user kernel-instance control directory must be outside protected workspaces.
- Stop rather than weaken `UNMEDIATED_WRITE_DENIED`, invalid metadata/schema, stale ownership, missing lineage, or recovery barriers. No raw filesystem/shell fallback is provided.
- An unknown tool result holds **every** model seam, including auxiliary compaction. Query/reconcile its original operation; never invent a new mutation or send key to replay an uncertain effect.
- Already-persisted unknown results cannot safely be relabeled through the pinned host's content-only rewrite. This development implementation retains an explicit hold rather than fabricating clean success.
- Preserve the coordinator database, canonical session history, user files and recovery artifacts across upgrade/removal. Do not reset counters, unlink a live instance lock or overwrite a live database with a snapshot.
- Installation/upgrade/disable steps and intentional unsupported operations are described in [installation](installation.md), [capability parity](capability-parity.md) and [architecture](architecture.md).
