# Bounded ordinary rename review

## Result

No confirmed functional defect was found in the reviewed ordinary no-overwrite rename contract. The three requested existing test files passed **75/75**, with zero failures, cancellations or skips. Source typecheck passed.

This is a bounded source-consistency and functional review, not a security review, live-profile certificate or full P0 acceptance decision. The reviewer did not author the rename production code. The reviewer previously worked on host integration and documentation, so this is not an independently implemented second system.

## Frozen source and execution scope

- Reviewed commit: `5e13bd3fc54def3191485cfca3c69c6f418b4f02`.
- Isolated archive: `/workspace/scratch/3016f5e02977/review-rename-functional-5e13bd3`.
- Environment: cloud Linux, Node `v24.19.0`, 2026-10-21, approximately 15:45–15:47 UTC.
- Archive created with `git archive` from that commit. Its `node_modules` is a link to the existing pinned dependency installation. No dependency install, package build or network operation was performed.
- Production focus: `src/native-rename.ts`, `Writer.applyRename`, `Writer.recoverRename`, their existing guard/lease/result helpers, and rename registration/argument mapping in `src/plugin.ts`.
- No source or existing test was modified. No new inputs or probes were added. Only the requested existing tests and source typecheck were run. No socket, bootstrap, live model endpoint or alternate transport was exercised.

The archive's reviewed production files match the commit blobs:

| File | SHA-256 |
|---|---|
| `src/native-rename.ts` | `13582c4dfe5444acf264b491ae865220b4d204b3d3ded5a7ad6b53e4faf356a6` |
| `src/writer.ts` | `353aa21349e01be56bfb8329a3c63a0669d55a77b1f6444eabff3a2255b516f7` |
| `src/plugin.ts` | `f6c5e0c7fc01d822fdc5a5b51a0b3cd045e2a4c967a55fb802695d5353e63d73` |

## Contract checks

| Contract | Source and observed evidence |
|---|---|
| One same-filesystem ordinary file moves without overwriting the destination | `src/native-rename.ts:6–11` calls Linux libc `renameat2` with `RENAME_NOREPLACE`, with no helper or copy/delete fallback. `src/writer.ts:895–902` checks source version, absent destination, filesystem identity and source read receipt before creating the intent. Existing tests preserve bytes and inode, reject an existing target, and retain a target created at the existing publication barrier. |
| Both paths need current leases and stay unavailable during unresolved work | `src/writer.ts:666–674` checks runtime, epoch, expiry and fencing token. `applyRename` checks both leases and both guards at `890–894`; the intent and both recovering states commit together at `903–908`. Existing tests deny both-path access at the prepared boundary, reject a stale destination fence, and permit independent-file progress. |
| Inputs and retries preserve the original logical operation | `src/writer.ts:706–760` requires the source version, destination fields and explicit `expected_target_version: null`. Non-null target versions are refused. The canonical fingerprint includes both paths. An existing committed mutation returns its original result before requiring fresh leases; aborted or unresolved mutations cannot execute again. Existing cases cover missing fields, overwrite refusal, changed-destination fingerprint conflict and original-result retry after release/later edits. |
| Report failure or uncertainty rather than invent success | `src/writer.ts:920–946` distinguishes recognized no-action syscall failures from potentially completed actions. A lost reply after commit does not change the committed result. `950–977` writes terminal event/result and clears both guards in one transaction, or freezes both paths when the outcome is unresolved. Existing simulated source-file flush failures occur before intent; source/destination-directory flush failures after the move leave both paths frozen until recovery succeeds. |
| Recovery requires the durable witness and exact namespace evidence | `src/writer.ts:930–936` persists the syscall-success witness after the native call and before directory flush/terminal commit. `1112–1125` requires unchanged parent identities, absent source, matching destination hash and original inode before recovering success. An unchanged original source without the witness can abort. A move-shaped state without the witness remains `needs_recovery`. Existing SIGKILL cases cover eight boundaries, including the witness gap, and repeated recovery kills produce one terminal event. The existing changed-destination case remains frozen. |
| The host's rename tool supplies runtime-owned credentials | `src/plugin.ts:106–125` obtains one grouped claim for the source and destination, maps each returned lease to its path, records both claims and supplies the stable runtime operation ID. The convenience `rename` tool requires a prior source read. Existing real in-process host tests exercise success, destination conflict and refusal before claiming when the read is missing. They do not use a live coordinator transport. |

The documented limits in `docs/architecture.md:81`, `docs/capability-parity.md:15–16` and `docs/installation.md:33` agree with this reviewed contract. Destination overwrite, cross-filesystem moves and directory moves are unsupported. The syscall-to-witness interval is an explicit persistent-recovery case, not an automatic-success promise.

## Commands and results

Run from the isolated archive:

```sh
node --import tsx/esm --test tests/writer-rename.test.ts tests/writer-storage-faults.test.ts tests/host/plugin.test.ts
# exit 0; tests 75; pass 75; fail 0; cancelled 0; skipped 0; todo 0

npm run typecheck
# exit 0; tsc -p tsconfig.json --noEmit
```

Unedited output is retained in `focused-tests.log` and `typecheck.log` beside this report. Typecheck emitted only the existing npm `http-proxy` environment-configuration warning. It checks the source files included by `tsconfig.json`; it is not a separate static typecheck of every test.

## Limits and open validation

- The tests use actual local filesystem operations and actual writer subprocess SIGKILL. The flush/storage errors are process-local simulations, not real disk exhaustion, read-only mounts, power failure or hardware fault certification.
- Host tool evidence uses actual pinned host objects in one process with the existing component coordinator seam. Production Unix transport, live installed-profile startup, two real Harness applications and package installation remain unrun here.
- The selected tests exercise directory refusal, but do not demonstrate cross-mount behavior or a libc/filesystem without `RENAME_NOREPLACE`. Those refusal branches are source-reviewed only. Non-Linux and network-filesystem behavior is not certified.
- A syscall that may have succeeded before its durable witness can leave both paths frozen indefinitely pending an authorized resolution. This is the documented conservative behavior, not a liveness guarantee.
- No alias/substitution probes, new adversarial cases, wider concurrency investigation or renewed blocked review operation were attempted. Passing this bounded review must not be described as a security assessment or closure of all mandatory acceptance cases.
