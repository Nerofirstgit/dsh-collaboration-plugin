# Managed writer: contract and evidence

This module is part of the plugin's coordinator, not an alternative standalone product. `Writer` must only be constructed by the process holding the coordinator's OS instance lock. Hosts call its authenticated RPC adapter; no caller receives a database handle or filesystem write authority. The plugin's `ProtectedFileSystem` retains host-internal read/watch APIs but rejects **all** `writeText` and `editText` calls, even a per-call `danger-full-access` request. The replacement established `read`/`write`/`edit` tools call the coordinator instead.

## Supported scope

- Linux with `/proc/self/fd`, `O_NOFOLLOW`, atomic same-filesystem publication and ordinary-file hard-link publication. Ordinary rename additionally requires libc/kernel/filesystem support for `renameat2(RENAME_NOREPLACE)`.
- Single-link ordinary UTF-8 files, without NUL, bounded by `max_read_bytes` (default 8 MiB). Existing parent directories must already exist.
- Create with an explicit absent precondition, replace, one strict byte-position patch, delete, and ordinary same-filesystem no-overwrite rename. Directory operations, symlink/hardlink user resources, `.git` internals, recovery artifacts, overwrite rename, cross-volume move, recursive operations and arbitrary batches are denied. New files use mode `0600`; replacement retains the admitted POSIX rwx mode regardless of daemon umask. ACL/xattr/security-label and special ownership preservation are not promised for replacement; ordinary rename moves the existing inode rather than rebuilding it.
- Raw SHA-256 versions include BOM, CRLF and all other original bytes. Text is not newline-normalized. Encoding outside this supported subset fails explicitly.
- No claim of cross-file transactional consistency, arbitrary external-process confinement, non-Linux support, or power-loss testing. See [the revised enabled-only scope](scope-revision.md) and [host boundary audit](host-write-boundary.md) for participant and composition limits.

## API

`claimFiles`, `releaseFiles`, `renewClaims`, `readFile`, `applyFileChange`, `mutationStatus`, `reconcile`, `releaseSession` and startup `recoverAll` are synchronous short operations inside the daemon. A transport may await them. Do not wrap them in asynchronous SQLite transactions.

`readFile` accepts exactly one of:

```ts
{ path, range?: { start, end }, max_bytes? } // zero-based raw-byte half-open range
{ path, line_range: { offset, limit }, max_bytes? } // one-based original line window
```

The output adds `byte_range`, `total_lines` and `offset` to the required content/version/read-token/truncated/activity fields. A line window preserves original newlines. A display byte cap backs off to a Unicode scalar boundary; explicit invalid UTF-8 byte ranges fail rather than fabricate replacement characters. A giant line capped mid-line requires byte-range continuation, not simply `offset + 1`.

The hash, selected display bytes, byte boundaries and signed receipt derive from the **same bounded stable full-file snapshot** under the resource execution lock. A full-file replacement requires that the receipt covers all bytes. A strict patch carries `{start, old_text, new_text}`: exact old bytes and the entire replaced range must fit the admitted window. Adapters must not apply another invisible truncation after receiving this result and then retain its broader receipt.

## Lease and execution boundary

- Logical lease ownership binds session, incarnation, execution epoch, coordinator epoch and a persistent per-resource increasing fencing token.
- TTL is checked with the current process's monotonic clock. UTC expiry is presentation only. Restart changes coordinator epoch; old clock samples cannot revive a lease.
- Multi-file claims are atomic, sorted and nonblocking. On conflict, no partial leases are created. Claims for unrelated files are not held behind another task's long-lived lease.
- Request-ID retries return the original claim result with its current `active` indication; they do not renew or create a new lease. A new intention uses a new request ID.
- The internal resource lock covers identity/lease/version checks through filesystem action and terminal result/freeze. Claim, release, renewal, session release and recovery use the same lock keys. Expiry after the admitted start boundary does not transfer in-flight execution authority.
- Ordinary reads ignore long-lived task leases but refuse unresolved resources; they never mint receipts for intermediate/unknown state.

## Filesystem protocol

The writer opens and pins the root and each existing parent using directory descriptors and `O_NOFOLLOW`. Operations address these descriptors through `/proc/self/fd` or the fixed descriptor-relative rename primitive, never a model-supplied shell command. Parent identities, target type/link count, and artifact directory identities are revalidated at the publication barrier. Directory namespace operations are not offered. Nonparticipating processes capable of moving whole parent directories are outside the confinement guarantee; descriptor pinning is not advertised as an immutable OS workspace boundary.

1. Authenticate the current runtime and check a previous mutation before reopening its old path. Committed retry returns the original result even after lease expiry, later edits, or removal of the original parent directory. Aborted retry returns the original reason and cannot execute again.
2. Under the resource lock, validate recovery state, lease/fence, current raw-byte version and receipt. Compute the intended result.
3. Persist immutable request, fingerprint, old/new existence and byte versions, old inode metadata, unique artifact ID and `prepared` state. In the same transaction, freeze the resource for recovery.
4. Create a private artifact directory, pin it and persist its identity. Exclusively create/write/fsync the new inode where applicable. Fsync artifact and target-parent directories, then persist staged-inode evidence.
5. Recheck the original target and path/artifact identities. Create uses a no-clobber hard link from the owned staged inode; replace uses atomic rename; delete renames the owned target into the private artifact. No copy/delete fallback exists. Flush both affected directories.
6. In one SQLite transaction, record the terminal result and its stable logical event/outbox entry, then clear the resource recovery fence. A true byte no-op skips publication and emits `file.noop`, not a fabricated `file.changed`.
7. Startup and explicit reconciliation also clean validated terminal artifacts, without replaying any publication or changing the current target; this repairs the transient second hard link left by a committed create killed before cleanup. Only remove known artifact entries whose inode identities match the intent, using a pinned artifact descriptor. No recursive cleanup or deletion of unidentified files. Unknown residue is retained for review.

A pre-publication failure can be `aborted` because the writer knows it did not execute an atomic target action. Once an atomic action may have begun, an exception becomes `OUTCOME_UNKNOWN`; the resource remains frozen. A failure after durable commit instructs the caller to query/retry the original ID, never generate a new mutation.

### Ordinary no-overwrite rename

`applyFileChange` accepts `operation: 'rename'` plus `target_path`, explicit `expected_target_version: null`, and a current target lease/fencing token in addition to the source credentials, expected version and read receipt. The registered `rename` tool accepts source/destination paths and the explicit absent-target precondition; its adapter obtains both leases in one atomic claim group and supplies the credentials and stable mutation ID itself.

Both file-entry keys are locked in sorted order through admission, publication and terminal state. Both recovery guards freeze in the same intent transaction. The writer validates the old source inode/hash, absent destination, both pinned parents and the same filesystem, then fsyncs the source inode. It persists source/target existence and namespace evidence before calling one fixed native function in the coordinator process. The direct dependency `koffi@3.1.1` (already present in the pinned host dependency graph) binds libc `renameat2` with `RENAME_NOREPLACE`; it launches no helper or shell. The kernel refuses an existing destination even if it appeared after the last userspace check. See the [Linux rename API](https://man7.org/linux/man-pages/man2/rename.2.html).

There is no fallback to overwrite, copy/delete, or a second syscall. Missing libc/kernel/filesystem support and cross-filesystem moves are explicitly refused. Overwrite rename is deliberately unsupported: this primitive enforces absence, not an expected target hash/inode conditional replacement, so checking a target version then calling ordinary overwrite-rename would not provide the promised condition against an external target change.

After syscall success, a durable success witness is saved, both affected parent directories are fsynced, and one terminal result/event transaction clears both guards. The result reports source `previous_version`, source `new_version: null`, `destination_path`, and `destination_version`. Terminal retries return that original result even after later edits.

The pre-existing source inode is **not unique proof that this writer moved it**. Recovery therefore commits only when the durable syscall-success witness exists, the source is absent, and the destination has the intended raw hash and original inode under the recorded parent identities. If killed between syscall success and that durable witness, the move-shaped state remains `needs_recovery` for both names; it is not replayed or guessed successful. An unchanged stable original source without a success witness permits abort. Other discrepancies remain frozen, while unrelated paths continue. `mutationStatus` includes both affected paths and the recovery reason. This is a deliberate availability limitation of conservative recovery, not a claim of filesystem/SQLite atomicity.

## Recovery

Recovery uses the same per-resource lock and validates persisted evidence against the immutable request/fingerprint. It never executes the original file action again:

- Unchanged old bytes plus old stable inode metadata and sufficient unconsumed staging evidence: abort.
- New raw bytes on the exact staged inode, or absent deleted target **plus the owned removed inode with the original bytes**: commit and publish the stable terminal event once.
- Different inode with the same hash, missing/aliased artifact evidence, changed removed bytes, inconsistent durable records, parent substitutions or otherwise ambiguous state: `needs_recovery` and freeze.

A terminal mutation emits exactly one stable event ID based on workspace/session/mutation ID; outbox delivery may repeat physically. A new authenticated incarnation may query the original logical session's mutation, but receives no authority from the old runtime's lease or receipt. No accepted operation records are garbage-collected here, so no retry silently becomes a new operation after a time window.

`reconcile` rechecks evidence; it is not an unsafe “unlock” command. Ambiguous resources have no automatic override. Manual resolution requires a future explicit audited operator workflow that preserves evidence and stops the affected writers; deleting rows or resetting a guard is not a supported recovery path.

## Reproducible verification

```sh
node --import tsx/esm --test tests/writer.test.ts tests/writer-rename.test.ts tests/writer-storage-faults.test.ts tests/host/filesystem.test.ts tests/host/plugin.test.ts
npm run typecheck
```

The original writer handoff had **68 writer tests and one provider test passing**. The original suite includes 27 genuine child-process `SIGKILL` cases (create/replace/delete at nine durable boundaries, including durable commit before artifact cleanup), recovery killed twice before commit, deterministic publication/release/expiry barriers, alias/artifact substitution, identical-hash foreign inode, corrupted evidence, exact partial-read receipts, Unicode byte caps, BOM/CRLF and POSIX rwx mode preservation. The added rename suite covers eight process-loss boundaries, repeated recovery interruption, both-path fencing, target collision, stale destination authority, terminal retry and conservative ambiguous-state handling; actual registered host tools also exercise rename success/conflict/read requirements in process.

`tests/writer-storage-faults.test.ts` injects errors into actual `node:fs` write/fsync calls selected by fixture-owned descriptors: short writes, partial `ENOSPC`, and `EIO`/`EROFS` at data/directory flushes. It verifies pre-publication abort, post-publication freeze, failed reconciliation while the fault persists, restart recovery, original idempotent results, stable events/outbox, and conservative cleanup. These are simulated syscall errors, not a filled disk, remounted read-only filesystem, SQLite VFS fault campaign or storage-hardware test. Check the [verification log](verification-log.md) for checkpoint-specific results.

These process-kill tests are not two real `dsh` host sessions and are not a power-cut/storage-hardware durability test. Host acceptance, profile activation/unload behavior, coordinator singleton suspension and complete shell/MCP/plugin confinement are separate integration obligations. Plugin-disabled protection is no longer required after the user’s scope revision; arbitrary enabled Host plugins still need a separate enforcing boundary before they can be supported.

## Host lease lifecycle adapter

`src/host/claims.ts` exports `ClaimManager` and `mountClaimManager`. The mount connects actual `agent/status`, `turn/end`, `approval/asked`, `approval/decided` and disposal events. It renews only current-identity claims belonging to a running task, at `min(heartbeat_ms, TTL/3)` using a monotonic clock. Custom claim TTLs carry into renewal. `auto_renew: false` disables scheduling entirely. Idle, approval-waiting, terminal and disposed tasks lose the local renewable claim set; changing back to running does not revive an old task's claims.

Tool adapters call `record(identity, claims, {ttlMs, explicit:true})` after an explicit successful `claim_files`; implicit write-tool acquisition uses `explicit:false`. On `FILE_BUSY`, call `conflict(session_id)`: this pauses automatic renewal until a new explicit successful claim/replan, rather than sustaining an incremental X/Y deadlock. Use `get(session_id,path)` instead of an independent stale lease cache. After successful explicit release, call `forget(session_id,lease_ids)`.

The manager verifies its identity callback before and after each awaited RPC, batches at most 100 lease IDs, never overlaps a renewal tick, and discards late replies after lifecycle changes. Failed renewal pauses and reports the reason; it does not loop indefinitely or acquire fresh authority. `close()` stops timers and drains any pending call. The existing authoritative runtime lifecycle still releases server leases; local forgetting is not itself a claim that the server release succeeded.

`tests/host/claims.test.ts` has 14 passing controlled-clock/lifecycle tests. These verify scheduling, disabled configuration, state changes, human approval, stale incarnation, partial release, conflicting incremental claims, late replies and connection failure without using a real model API.
