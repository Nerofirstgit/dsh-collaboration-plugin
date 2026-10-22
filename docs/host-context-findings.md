# Context persistence findings

Pinned host: `687f282e8625c6b8d11ff58211a90524be2e4317` (`0.2.1-rc.2`).

## Why a generic event listener is insufficient

`Session.append()` (`packages/core/session/src/index.ts:761–826`) commits memory synchronously, then broadcasts `session/event`; observer errors are contained. Listening to that event cannot atomically veto an append or certify disk persistence. `agent.inject()` (`packages/core/agent/src/runtime-types.ts:233–241`) does not wake an idle driver, but cancellation/disposal may discard pending context. It is not a delivery acknowledgment.

The shipped checkpoint policy demonstrates awaited `ctx.sessions.flush(session)` before the actual model stream and top-level tool execution (`packages/session/session-checkpoint-policy/src/index.ts:29–35,63–77`). This bundle installs those barriers in `src/host/runtime.ts` instead and disables the extra checkpoint-policy wrapper: no later asynchronous dispatch wrapper may open a gap after the root plugin's final synchronous tool-definition check. A coordinator-backed persistence provider rejects stale ownership or failed durable admission before downstream side effects, without patching the loop.

## Canonical-store design

Replace—not supplement—the JSONL provider in the protected profile. The coordinator SQLite database stores actual host SessionHeader and contiguous SessionEvent rows. Its `session_append` transaction validates a private handle/incarnation/execution epoch, CASes the expected event count, appends the complete batch, validates each coordination relay against its batch and authorization, and inserts the dedup/admission ledger. A relay event itself contains the stable delivery identity and exact content digest; it cannot be marked delivered from an arbitrary record ID. Retries preserve append ID and request fingerprint. No alternative synthetic conversation is maintained.

`SessionPersistence.create/open('write')` occur before the agent is published (`packages/core/agent-loop/src/index.ts:715–722,875–899`), so the provider obtains the private coordinator identity before `agent/created`. Resume reads the same canonical events; the host then appends its standard interrupted-turn closers through that handle. A provider must implement the entire service and handle lifecycle, including live routing, drain-on-close, readonly refusal, cancellation, and storage errors—not only `append`.

## Source vocabulary and compatibility

Use a standard `user/message` event, with `MessageSourceMap` augmented by `kind: 'session-coordination'`, `form: 'relay'`, sender/workspace/message/part/digest/delivery/batch identifiers, and an explicit text label that this is coordination data, not human authorization. Opaque runtime tokens must never appear in that source or in model tools.

Do not invent a required external SessionEventMap event: `packages/core/session/src/known-event-types.ts:9–20` and `packages/session/session-persistence/src/storage-contract.ts:69–82` refuse unknown required event types. Unknown `ignorable` plugin records are log-only and cannot enter the surface (`packages/core/session/src/surface.ts:301–313`). A custom pure projection does not turn an unknown ignorable event into a new model-visible surface type. Standard user/message attribution is merge-extensible (`packages/llm/llm/src/message.ts:103–115`).

## Existing ownership support

JSONL already uses kernel-backed cross-process ownership: `packages/session/session-persistence-jsonl/src/lease.ts:1–27,70–115`. A live paused writer retains the lock; no expiry permits a rival. The collaboration coordinator must preserve that strength for its singleton writer and additionally supply incarnation/execution CAS. Replacing JSONL must not regress to timeout-only session ownership. Separate coordinator data-directory domains cannot be allowed to protect the same physical workspace independently.

## Compression and revocation

The host retains an append-only event log and changes the active surface through replacements; compaction's maintenance API serializes with its local driver. Unresolved references must be rebuilt from persistent coordination state, not a model-written summary. Every model boundary reconciles active surface lineage with admitted deliveries; an older checkpoint must be repaired or paused explicitly.

Authorization and context rows in the same coordinator transaction provide a real revocation boundary: an append either commits before revocation or is refused afterward. Revocation must wait for/reconcile accepted in-flight evidence; it must never infer absence merely from a missing client ACK. The provider rejects stale-incarnation appends even when a paused host's in-memory log has advanced. Such in-memory advance must not reach model/tool dispatch after a failed checkpoint.

## Private RPC vocabulary proposed for implementation

- `session_create({header, inherited_event_count, open_request_id, workspace_root?})`
- `session_open({id, access, open_request_id, expected_previous_incarnation?})`
- create/open return `{handle_id, header, inherited_event_count, identity?, event_count}`; readonly handles have no write identity.
- `session_read({handle_id, offset, length?}) -> {events}`
- `session_append({handle_id, expected_seq, events, append_id}) -> {event_count}`
- `session_flush({handle_id})`, `session_close({handle_id})`
- `session_stat({id}) -> null | {header, event_count, revision}`
- `session_list({}) -> {sessions: [{header, event_count, revision}]}`

`RuntimeIdentity` is private: session/incarnation/execution/coordinator epoch plus runtime bearer and coordinator domain. Model parameters cannot choose any of these. Wire boundaries parse unknown JSON; host same-process types are not replaced with untyped parallel interfaces.

## Tool-outcome recovery: supported path and hard boundary

The actual pinned loop runs `interruptedTurnClosers()` after the write handle's first read and before publishing the Agent (`packages/core/agent-loop/src/index.ts:888–899`). A recorded `tool/call` with no durable result becomes a synthetic `tool/result` with `error.code = TOOL_OUTCOME_UNKNOWN` (`packages/core/session/src/repair.ts:161–192`). Blindly allowing the next model request could invent a new logical call and duplicate an effect.

`src/host/recovery.ts` therefore runs **inside provider `open('write')`, before the handle is returned to the loop**. It asks the coordinator for the original prepared-operation outcome, verifies its original canonical call sequence/turn/step/call ID and that the tail turn remains open, and appends an ordinary standard `tool/result` with the original canonical Result/request ID. This append uses the same durable handle and retry-stable append ID. The stock host then closes the interrupted turn normally; it does not synthesize an unknown result for the recovered call. No tool body is re-executed. Unknown effects stay unknown, and the pre-step gate blocks a new model request.

**Important limitation:** `packages/core/session/src/surface.ts:455–485` (`assertToolResultRewrite`) permits tool-result surface replacements to change **only message content**. It forbids changing the message ID, `isError`, error metadata, call identity, turn or step. Thus a previously persisted synthetic unknown cannot truthfully be changed into a clean success through this API. An attempted full replacement was rejected by a real-AgentLoop regression; that implementation was removed. If the effect becomes known only after such a synthetic error already exists, this version remains fail-closed with `OUTCOME_UNKNOWN`. It does not rewrite history, mutate the upstream validator, replay the body, or claim recovery completed. A future authorized host change could add a narrowly validated recovery transition, or the product owner could explicitly choose a separately attributed recovery-notice semantics; neither is silently assumed here.

Verification: real in-process upstream AgentLoop tests cover ordinary admission before model dispatch, persistence-failure gating, unknown-outcome gating, and known-result pre-resume restoration. These use a controlled keyless adapter and fake transport, not real API requests. Production Unix-socket and two-real-process acceptance remain separate requirements; cloud Unix-socket bind is currently unavailable, and no alternate transport was substituted to evade that boundary.

An ordinary persisted transport diagnostic is likewise not proof that an effect failed. `OUTCOME_UNKNOWN`, `COORDINATOR_UNAVAILABLE`, and `RESOURCE_RECOVERING` results retain the original operation mapping. The root-loop regression commits one message, loses its response, persists the uncertainty result, and verifies **one message, one send dispatch, no second model request**. When such a diagnostic already exists, the same content-only replacement limitation requires a safe hold rather than a fabricated clean success.

## Enabled-only scope and closed composition

The user's revised scope excludes disabled/unloaded plugins and human/manual external processes. Within participating enabled sessions, this implementation supports only the pinned minimal headless composition, not arbitrary same-process plugin code. `src/host/profile.ts` checks the real Loader tree, exact configured module identities, resolved package manifest names/versions, no nested groups or scoped interception, actual protected filesystem and canonical persistence instances, native tool mode, non-writing session query configuration, and explicit readiness barriers. Unknown enabled rows, dynamic configuration/plugin management, shell/MCP tools, timeout/spill/pruner/checkpoint wrappers, and unreviewed providers are refused. This is admission to an audited composition, **not** an OS sandbox or cryptographic package-integrity attestation.

The official `dsh --profile headless --patch ./cordis.patch.yml --dump-config` composes exactly 20 audited enabled rows with no warnings. `agent-loop` cannot activate before both canonical persistence and `collaborationReady`; the headless runner also waits for readiness. The root plugin publishes readiness only after installing its adapters and verifying composition, then repeats verification before model/tool boundaries. An awaited operation preparation followed by a scoped same-name tool substitution is rejected by the final synchronous definition check. A changed profile blocks a subsequent real model request.

Component evidence uses real upstream AgentLoop, tools, providers, SQLite coordinator and installed manifest inspection. Positive managed create/read/edit/replace testing uses an explicitly detached exact Loader inventory; it does **not** activate every listed profile entry and must not be represented as production profile boot or two-process acceptance. The normal no-loader composition helper remains write-denied.

Live `approval/asked` events publish authoritative `waiting` state through the ordered runtime RPC queue, releasing server claims; concurrent pending approval IDs keep that state until all are decided. Only an actually running Agent returns to `running`. Local claim renewal is separate from this authoritative lifecycle transition.
