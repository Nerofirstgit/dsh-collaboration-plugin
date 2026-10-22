# Independent bounded correction review — 70eeee4

## Conclusion

**The four outstanding findings from the 21c68d6 review are corrected in the reviewed snapshot.** The seven earlier regression cases also continue to pass. No additional confirmed blocker was found in this bounded correction review.

This conclusion is not approval of full P0 or evidence that the installed enabled profile has actually booted. Socket transport, two-real-Harness-process acceptance, and the end-to-end demo remain outside the verified evidence.

Frozen commit: `70eeee4a622d68dd8b9e5f3c9ab4babd113688bf`.
Review was executed from a separate frozen cloud archive, not the active implementation tree.
Reference source: `687f282e8625c6b8d11ff58211a90524be2e4317`; host packages `0.2.1-rc.2`; cloud Linux, Node v24.19.0.

## Correction evidence

The saved `review-adjacent.test.ts` and `review-recovery-fingerprint.test.ts` from the prior frozen review were copied **byte-for-byte**, with matching SHA-256 values, and run unchanged:

| Prior finding | Current result |
|---|---|
| Conflicting message key incorrectly recovered as success for an earlier recipient/content | Pass: canonical reopen no longer invents success for the rejected request. |
| Failed durable close abandoned bookkeeping while leaving credentials valid | Pass: failed revocation retains retryable ownership; successful retry revokes the credential. Additional committed regression confirms disconnect storage failure denies the old incarnation and retains its ownership barrier. |
| Pending open wedged after a committed open lost its connection | Pass: the definitive stale CAS is reconciled without taking over a connected live owner. |
| Definitive `SESSION_NOT_FOUND` poisoned later create | Pass: nonacceptance no longer remains an unresolved pending operation. |

Source inspection agrees with those results: `HostStore.close()` removes maps only after durable revocation; `Identities.close()` transacts state/outbox and revocation; disconnect failure installs the in-memory denial barrier; open retry distinguishes definitive failure from an uncertain outcome and retains the live-owner refusal.

## Additional requested defensive checks

- `src/host/runtime.ts:173–185` now checks tool recovery at the universal `llm/stream` boundary, after the canonical flush and before calling the downstream stream. The auxiliary-compaction regression passes; the hold is no longer limited to ordinary pre-step requests.
- `src/host-store.ts:94–100` keeps `TOOL_OUTCOME_UNKNOWN`, `OUTCOME_UNKNOWN`, `COORDINATOR_UNAVAILABLE`, and `RESOURCE_RECOVERING` results pending rather than treating their diagnostics as proof the original effect failed. All four focused bookkeeping regressions pass.
- `src/host-store.ts:33–40` publishes handle/writer maps only after the create transaction commits. The injected COMMIT-failure regression passes and permits a clean retry without a phantom handle.
- `src/store.ts:19–31` rejects the tested malformed/missing domain metadata, invalid epoch, unsupported schema, and an unrelated SQLite database rather than recreating authority. The orderly-reopen case advances the epoch while retaining the domain. These checks do not establish a general corruption-repair or power-loss guarantee.

## Profile/Loader compatibility: source findings, not a live-boot claim

No source-level startup-order mismatch was identified in the inspected ordinary pinned configuration:

1. The real app bootstrap creates one root entry with id `include`, name `cordis:include`, under `loader.root` (`upstream/packages/boot/app-boot/src/index.ts:743–787`). The Include constructor creates its subtree, and `Loader.entries()` traverses it. This matches the topology expected by `checkActiveProfile()`.
2. The Include applies the same patch-list semantics used by `--dump-config` (`upstream/vendor/include/src/index.ts`); the shipped patch composes into the exact 20 configured active entries accepted by the inventory check. The existing dump-config test passes without activating plugin bodies, a model, or transport.
3. Loader merges entry-level injection into plugin dependencies (`upstream/vendor/loader/src/index.ts:129–135`). Thus `collaborationReady`/`sessionPersistence` are real startup dependencies, not merely diagnostic metadata.
4. The collaboration entry installs its persistence/runtime/tools, verifies inventory, and only then provides `collaborationReady` (`src/plugin.ts:51–55,111–121`). Its declared dependencies do not require `agentLoop`/`collaborationReady`, so the inspected dependency graph does not introduce a startup cycle.
5. The headless runner's pinned implementation additionally awaits Loader settlement before creating an Agent (`upstream/packages/bundle/headless/src/index.ts:310–318`). An empty declarative agent list plus the configured readiness dependencies is consistent with this sequence.
6. Package identity lookup uses the actual PluginPackages resolution service, and the read-only filesystem subclass inherits a concrete LocalFileSystem configuration/provider. The existing detached real-Loader/package-manifest checks pass. They intentionally do not activate the whole configured tree.
7. `session-query-sqlite` documents `openAt: never` as disabling index opening while retaining exact inherited reads, matching the patch's non-writing index configuration.

Actual installed-profile boot remains **unrun**. None of the topology/dump-config evidence establishes daemon connectivity, active provider completion, startup behavior with real launch credentials, or full enabled-mode protection across two processes. No socket retry or alternative transport was attempted.

## Commands and independent results

All commands below ran in the isolated archive:

```sh
node --import tsx/esm --test \
  review-adjacent.test.ts review-recovery-fingerprint.test.ts \
  tests/review-core-regressions.test.ts \
  tests/host/persistence.test.ts tests/host/runtime.test.ts \
  tests/host/coordinator-loop.test.ts tests/host-store.test.ts tests/store.test.ts
# 55 passed / 0 failed — review-targeted.log

node --import tsx/esm --test tests/host/profile.test.ts
# 22 passed / 0 failed — review-profile.log

npm run typecheck
# exit 0 — review-typecheck.log
```

Saved probe hashes, identical to the prior archive:

- `review-adjacent.test.ts`: `637183d57c9247751292c5bd7df673029a4ac4e366371fbf2a7c786f2ff2b6d7`
- `review-recovery-fingerprint.test.ts`: `799fc9f8958dbe3c86419cd3440f0d20a25fcc36ba80d8bd191a065833ed8faa`

No production edits, user-computer access, new API, socket/transport substitution, or blocked writer-review operation occurred. The wider writer/platform/security scope was not reopened. Author-reported full build/224-test results were not substituted for this independent focused evidence; build was not rerun here.
