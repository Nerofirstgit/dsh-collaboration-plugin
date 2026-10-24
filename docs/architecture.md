# Architecture and trust boundaries

> Dated implementation checkpoints and test results below are historical. For the current published scope and compatibility limits, start with the [README](../README_EN.md).

> **2026-10-22 correction in progress:** native Windows and portable Node APIs are the target; only cooperating enabled dsh sessions are in scope. The current implementation and remaining Windows/GUI gates are in portable-checkpoint.md (internal reference, not distributed). Linux-specific descriptions and old test counts below are historical, not claims about the correction.

## Real host plugin, one private authority

```text
Pinned dsh headless profile A          Pinned dsh headless profile B
  Host AgentLoop + model/tools          Host AgentLoop + model/tools
  CoordinationSessionPersistence        CoordinationSessionPersistence
  awaited runtime hooks                 awaited runtime hooks
  managed read/write/edit adapters       managed read/write/edit adapters
                \                        /
                 authenticated Unix RPC
                          |
           one kernel-locked coordinator process
           identities + canonical host event store
           messaging/permissions + trusted writer
                          |
             SQLite transactions + private outbox
                          |
          descriptor-relative ordinary-file publication
```

There is no second agent loop in the daemon and no public standalone application entrypoint. `package.json` exports the Cordis plugin and replacement filesystem provider; `cordis.patch.yml` installs them into the real pinned host composition. `daemon-entry` is private bootstrap machinery only.

The supported composition is closed and version-pinned. The profile checker audits loader entries, service providers, package versions, tool mode, query configuration and readiness dependencies. Unknown active plugins/scoped overrides are refused. Tool-result pruning is disabled because rewriting a displayed read after its receipt was minted could falsely retain whole-file authority. Same-process installed code is trusted host code; another JavaScript plugin cannot sandbox arbitrary direct `node:fs` calls or startup effects. See [scope revision](scope-revision.md) and source integration map (internal reference, not distributed).

## Module responsibilities

| Module | Authority and invariant |
|---|---|
| `host/profile.ts`, bundle patch | Supported enabled composition and exact provider/version checks; no model/tool before readiness. |
| `plugin.ts`, `host/runtime.ts` | Original tool names, trusted invocation identity, lifecycle updates, pre-model intake and stable tool-call mapping. No model-controlled sender/owner fields. |
| `host/persistence.ts`, `host-store.ts` | Real canonical Harness headers/events, exclusive write owner, append ID deduplication, context revision CAS and pending-result restoration. |
| `bootstrap.ts`, `instance-lock.ts`, `server.ts` | Private owned filesystem state, one OS-held service lock, authenticated bounded Unix RPC. A paused owner is not replaced by heartbeat guesses. |
| `client.ts` | Each socket generation owns connection promise, input buffer and pending requests. Late old events cannot clear newer work; sent requests with lost outcomes are not replayed automatically. |
| `store.ts`, `identity.ts` | SQLite WAL/FULL sync, synchronous transactions/savepoints, physical project/workspace identity and session incarnation/execution CAS. |
| `messaging.ts` | Immutable accepted messages/parts, scoped grants and revocation barriers, transactional outbox, actual event-backed receipts, snapshots/cursors and independent mailbox progress. |
| `writer.ts` | Lease/fence/version/read-token enforcement at the actual file operation, immutable mutation intent, descriptor-relative publication and per-resource recovery evidence. |
| `host/filesystem.ts` | Preserves host read/watch APIs but rejects every direct `writeText`/`editText`, even per-call danger-full-access. Managed tool writes take the coordinator route. |

## Identity and admission

A logical session ID is not an executor credential. Runtime authority also binds incarnation, execution epoch, coordinator epoch/domain and a private token. Recovery acquires the logical owner by CAS; old executors cannot heartbeat, schedule, renew, write or admit context as the new owner. Physical canonical roots prevent lexical aliases from creating independent write domains. Git common-directory identity joins worktrees into a project, while non-overlapping ordinary source files remain workspace-specific resources.

`context_revision` is the actual canonical host event count. The runtime lets earlier pre-step/compaction work finish, flushes the current durable context, and fetches a batch bound to that revision. The real loop then appends ordinary attributed relay events. The provider persists the exact events and validates/inserts each delivery receipt in the **same transaction** before updating the host count. Any unexpected flush/CAS change rejects the batch rather than relaxing its expected revision.

All parts must have unique exact canonical evidence before a message is delivered. Partial admission never skips FIFO holes. Delivered is not acknowledged; acknowledged is not resolved; idle is not completed; offline is not a successful finish. Durable unresolved references survive notification pruning, and missing canonical lineage stops execution for repair.

## Effect recovery before model continuation

Tool invocation maps to a stable operation ID before the effect. A new model request must not invent a new ID to replay an unknown original call. Resume reconciles known writer/message results into actual host tool results where the host event grammar permits it. Otherwise it pauses with an actionable unknown-outcome diagnostic.

Message recovery uses the exact same strict argument parser and immutable fingerprint as sending, through the read-only `originalSendOutcome` helper. It does not call `send` during recovery. Reusing a key with changed recipient/body, null-only normalization tricks, or extra invalid fields cannot fabricate success from a different accepted message. Only deterministic request failures become known aborted results; storage faults/uncertain historical state remain unknown.

## Storage facts and retention

- Canonical host sessions/events/appends are stored alongside execution-owner records; not in a fake plugin-only context string.
- Accepted message, recipient sequence, parts, idempotency fingerprint and queued outbox event commit together.
- Delivery evidence is unique by receiver/message/part and stable delivery ID; a network ACK alone is never authoritative.
- Grants retain scope/generation. A one-message grant binds sender/recipient/key, whereas explicitly configured project grants are persistent.
- Snapshot pages materialize one immutable state image plus event high watermark `H` in one transaction. Signed cursors bind caller, stream and filter; expired retention requires resync.
- Notification cleanup cannot remove unpublished outbox entries, accepted mailbox data, deduplication records or unresolved receipts. Archival of accepted history needs a separate explicit policy.
- Private credentials/configuration are created only after descriptor-based directory validation. Existing unsafe ownership/mode/aliases or mismatched domain settings cause refusal, not repair by overwriting.

## File mutation linearization and unknown outcomes

A task lease is not permission to perform a raw write. The coordinator's writer checks the live runtime, resource lease, monotonic deadline, persistent fence, read receipt and expected raw-byte hash under a short per-resource execution lock. It preserves the same raw snapshot for content/version/range/token; an incomplete display cannot authorize replacement.

SQLite cannot atomically commit with arbitrary filesystem publication. The writer therefore persists immutable intent and evidence, flushes staged data, performs a supported descriptor-relative publication, flushes the directory, then records the terminal result/event. A crash between those steps triggers evidence-based reconciliation. If ownership/effect cannot be proved, the resource freezes rather than being guessed successful or blindly replayed. Other independently safe resources may progress.

Same-hash bytes are not sufficient attribution: inode/artifact evidence distinguishes an intended publication from an external writer with identical content. No-op is explicit. Released or expired leases never reset fencing counters; in-flight execution must settle before a new writer can take over. The implementation does not claim to intercept arbitrary unmanaged processes after validation, nor universal power-loss durability.

## Failure handling and supported limits

The production transport remains a private Unix socket. Fake sockets and loopback clients are test seams only; they do not replace the daemon transport. A request not dispatched due to connection failure is `COORDINATOR_UNAVAILABLE`; one whose bytes may have been sent but response was lost is `OUTCOME_UNKNOWN`. There is no mutation auto-replay.

Production election holds two kernel flocks in the writer process: a fixed Linux per-OS-user guard at `/tmp/dsh-collaboration-instance-UID` and the configured state-directory lock. Thus two accidental `data_dir` values cannot elect concurrent writers in the same user/mount namespace. Neither `TMPDIR`, `HOME` nor `XDG_DATA_HOME` changes the fixed election namespace. Workspace registration refuses overlap with this reserved control directory as well as with private state. A paused old owner is not replaced; no PID/mtime takeover or alternate IPC is used. Cross-user or separately mounted container namespaces are not certified participants in one protected workspace.

Persisting an `OUTCOME_UNKNOWN`, `COORDINATOR_UNAVAILABLE` or `RESOURCE_RECOVERING` tool diagnostic does not settle its original mapping. The next model boundary stays blocked until the original effect can be reconciled; the model cannot silently invent a new operation ID after a lost response. Already-persisted uncertainty cannot be relabeled as clean success by the pinned host's content-only rewrite seam.

Linux local ordinary UTF-8 files are the initial supported writer subset, including same-filesystem no-overwrite rename through one native `renameat2(RENAME_NOREPLACE)` call under both source/destination guards. Overwrite rename, cross-volume move, directory mutation, user symlinks/hardlinks, repository internals, arbitrary shell/MCP/plugin side effects, staged external-tool import, and cross-file transactions are refused or unsupported. Rename without durable syscall-success evidence remains frozen rather than attributed from a move-shaped state alone. Non-Linux and network-filesystem guarantees are unverified. Disabled/unloaded protection is outside the revised user scope; enabled-profile checks remain mandatory.

The [acceptance matrix](acceptance-matrix.md) distinguishes in-process host evidence, real SIGKILL subprocesses, simulated write/fsync syscall faults, blocked Unix transport/two-host acceptance, and unrun real storage/platform scenarios. Do not infer those guarantees from this architecture diagram.
