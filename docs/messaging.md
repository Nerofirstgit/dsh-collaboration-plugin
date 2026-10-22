# Persistent messaging

## Implemented contract

`src/messaging.ts` runs inside the trusted coordinator. The real Harness persistence adapter stores canonical host events and the collaboration delivery ledger in **the same SQLite transaction**. `delivered` means every stable part has committed, verified `user/message` evidence; it does not mean the model read, acknowledged, or resolved the message. A network response, fetch, local batch claim, or model-generated ACK is not delivery evidence.

`send` atomically commits immutable text, its sender-scoped idempotency fingerprint, receiver sequence, stable Unicode-safe fragments, and event/outbox. The fingerprint includes the recipient, body, related paths, and reply reference. A retry returns the original message; different logical content under the same sender/key is rejected. Different senders may use the same key. Sequence allocation and the outbox share the writer transaction. Ordinary coordination messages never wake an idle host agent.

The public operations are send, status, body pagination, explicit acknowledge/resolve, notification polling, and coordination snapshots. Internal `originalSendOutcome` shares the strict send parser/fingerprint and recovers only an already accepted request; it never enqueues a message, and invalid/null/extra-field normalization cannot turn a different tool call into success. Fetch/admission and grant/revoke are trusted runtime/control operations, not model-exposed tools. All operations revalidate the runtime identity; the model cannot supply a replacement sender, project, incarnation, or execution owner.

## Permission and audit boundary

`explicit_only` creates no authority by discovery. Trusted control may create a project, participant-pair, or **one-message** grant. An allowed-once grant requires the exact sender, recipient, and sender-scoped idempotency key; it cannot authorize the next message. The host approval bridge must retain the approved request unchanged and must never expose `grant` to model JSON. Existing persistent grants migrate with `message_key = NULL`, preserving rather than silently broadening their existing scope. Reusing a grant ID with a different key or scope is rejected.

Messages capture the authorizing grant and generation. Body access, fresh context admission, and handling operations require that authority to remain active. Only participants can inspect message metadata; a third same-project session cannot gain access using a message ID, cursor, or event stream. Terminal status remains participant-visible audit metadata after revocation, without restoring body permission. Acknowledgement is explicit and does not imply resolution; resolution requires an explicit result.

## Actual host admission

`fetchBatch` binds a batch to receiver, incarnation, execution/coordinator epochs, exact host `context_revision`, part IDs, and content digests. It returns bounded nonhuman relays, not fabricated human instructions. The adapter uses standard host `user/message` events with `source.kind = session-coordination`, `source.form = relay`, sender/workspace attribution, stable delivery ID, batch ID, part metadata, and expected revision.

The provider inserts those canonical events, then invokes `admitParts` in its still-open SQLite transaction, then advances the host event count. Admission verifies the exact stored event, text, digest, source, batch, current authority, and FIFO position. A fabricated record ID or arbitrary receipt is insufficient. Any failure rolls back both canonical events and ledger. Parent `HostStore` preserves append IDs across response loss. The active-context lineage check also validates already-delivered receipts; missing/tampered canonical evidence pauses execution with `CONTEXT_CONFLICT` and a repair requirement instead of silently trusting an old delivery watermark.

See [the host integration map](host-integration-map.md) and [context findings](host-context-findings.md) for the pinned pre-step/compaction/persistence ordering. The integration must fail closed if another plugin inserts an unexpected intermediate flush; it must not accept any newer revision merely to make a batch fit.

## FIFO, revocation, and recovery

Only the earliest unfinished mailbox slot is admitted. Partial admission advances actual parts only, so later slots cannot bypass a missing part. Delivery and handling state are separate. Partial terminal messages retain admitted-part facts and an explicit incomplete-message notice; remaining parts are not silently considered delivered.

Revocation is durable `active → revoking → revoked`. Beginning the barrier fences pending batches and further admission. Finishing it uses the same authoritative database to classify all pre-barrier receipts: complete messages remain delivered; incomplete messages become rejected with a reason and retained partial facts. Completing a rejection advances the mailbox slot so still-authorized later messages can proceed. Grant expiry enters the same barrier. `recover()` finishes persisted barriers before normal coordinator service; fetching also invokes reconciliation. Historical audit reconciliation never grants new body insertion or access.

There is no delayed receipt ACK window to reconcile across independent databases: a canonical append and its receipt either both commit or neither commits. Response loss after commit is handled by durable IDs. The subprocess tests verify selected process-kill windows; they are not power-loss tests or two-real-Harness-process acceptance.

## Bounded context and tokenizer applicability

Default limits are an 8 KiB accepted UTF-8 body, 10 MiB pending mailbox, 512-byte stable fragments, and a 2000-token injection ceiling. Scalar-aware splitting rejects malformed UTF-16 and never divides a UTF-8 scalar. Fragment boundaries are fixed at acceptance; changing the model or budget cannot silently rechunk an accepted delivery ID.

For an explicitly supported **UTF-8-byte BPE tokenizer whose token count is at most its input byte count**, complete rendered text is charged at one token per UTF-8 byte, plus 64 tokens reserved per relay frame. Sender/source labels and incomplete-message notices are inside the charged text. The caller must also budget its bounded unresolved-reference index and other envelope text separately. This is a conservative bound under that tokenizer/framing contract, **not a universal tokenizer theorem**, not host `chars/4` estimation, and not a claim that 8 KiB fits 2000 tokens. Unknown tokenization or framing must not be labeled supported without a proven bound or exact counter. No paid/live model tokenizer validation has run.

If the first stable part cannot fit the current budget, `DELIVERY_BUDGET_UNSATISFIABLE` explicitly stops admission without marking it delivered. Body pagination charges the actual escaped JSON body, signed continuation cursor, standard `success` envelope with up to 64 operation-ID bytes (the pinned host uses UUIDs), and 64 framing tokens. It selects a scalar-safe prefix that fits that complete result; an unsatisfiable budget fails explicitly instead of returning an empty successful page. Larger/different host wrappers require their own revised bound. Fixed unsupported budgets require operator/model-budget correction; the implementation does not claim automatic starvation freedom under a permanently unusable model configuration.

Unresolved references are rebuilt from durable state, including acknowledged-but-unresolved and partial-terminal messages. The runtime reserves bounded index/footer space and marks omitted entries; the snapshot and read tools expose durable continuation rather than pretending a clipped index is complete. Full compaction/restore concurrency remains an integration acceptance obligation.

## Snapshots, cursors, and retention

Snapshot content and event high watermark `H` are captured in one transaction. All immutable pages retain the same snapshot ID, `H`, and caller/scope. HMAC-authenticated cursors bind caller, project/workspace filter, stream, and position. Cross-caller, cross-filter, and cross-stream replay fails. Expired snapshots or a position below the event retention floor return `RESYNC_REQUIRED`; callers obtain a fresh snapshot then poll after its `H`.

Polling is independent of mailbox progress and never consumes delivery. The messaging engine itself is synchronous; the RPC server owns bounded cancellable long-poll waiting. Snapshot capacity is explicitly capped rather than silently truncated. File-activity summaries use only current-epoch, unexpired, current-incarnation leases plus recovery freezes.

Notification cleanup advances only through a contiguous published prefix. It does not delete accepted messages, stable fragments, deduplication records, delivery evidence, or unpublished outbox entries. Accepted-message and handled-history archival remain a future explicit retention policy, not an implicit destructive cleanup.

## Verification and open scope

At 2026-10-21 09:38 UTC, the focused messaging/client/bootstrap/config run passed **43/43**, including **32 messaging tests**; `npm run typecheck` passed. Tests cover keyed approval, migration, idempotency, transaction rollback, grant expiry/revoke, FIFO/partial delivery, actual canonical-event validation, lineage loss, caller-bound cursors, snapshots, retention, Unicode, byte budgets, and two real child-process SIGKILL windows. Those children exercise storage modules, **not two running Harness instances**.

The 09:24 broader checkpoint was 120/122: two review transport fixtures had not yet implemented `recover_tool_operations`. After fixes, the fresh `npm run test:components` checkpoint at 09:40 passed **173/173**, including client-generation, bootstrap-private-state and recovery-fingerprint regressions. Production Unix-socket server tests are blocked by this cloud sandbox's `listen EPERM`; an authorized narrow retry failed before execution at sandbox setup. No TCP/in-process transport is being substituted as proof of production transport. See [all 65 acceptance cases](acceptance-matrix.md), which distinguishes component evidence, blocked acceptance, unrun coverage, and unsupported boundaries.

P1–P3 are extension points only: task/result messages and scheduling; spawning/delegating agents or worktrees; richer group conversations, UI, and workflow automation. None is implemented or implicitly authorized by a coordination grant. At 09:26 UTC the user removed the guarantee after disabling the plugin. While enabled, protection against unmediated shell/MCP/process paths still requires a pinned audited supported profile: no unknown installed plugins, no dynamic host loading, and no tool-result pruner. Same-process installed plugins are trusted host code, not sandboxable by another plugin. The revised enabled-only contract may be feasible without a host patch; it still needs composition enforcement and real bypass tests. [Host write boundaries](host-write-boundary.md) records the original wider requirement and source evidence; a messaging ledger alone is not enforcement.
