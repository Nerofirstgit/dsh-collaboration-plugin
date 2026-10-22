# Capability parity and deliberate differences

> **2026-10-22 correction in progress:** native Windows and portable Node APIs are the target; only cooperating enabled dsh sessions are in scope. The current implementation and remaining Windows/GUI gates are in [portable-checkpoint.md](portable-checkpoint.md). Linux-specific descriptions and old test counts below are historical, not claims about the correction.

This project ports the requested P0 collaboration semantics into **DeepSeek Harness**, not the internal implementation or UI of another assistant. The real host owns agent loops, models, tool execution and session events. The private daemon is a plugin service, not a separate assistant application.

The latest user scope limits protection to the plugin **enabled in its supported audited profile**. Disabled/unloaded behavior is not guaranteed. Unknown same-process plugins are trusted host code outside the supported composition, not magically sandboxed workers. See [scope revision](scope-revision.md).

| Capability | Implemented surface | Evidence / limitation |
|---|---|---|
| Discover independent sessions | `session_list_sessions`, `session_get_session_status`; project/workspace identity, heartbeat/presence and task summaries | Component-tested. Two actual host processes still blocked/unrun. No access to arbitrary private conversation history. |
| Durable coordination messages | `session_send_message`, `session_get_message_status`, `session_read_message`, `session_mark_message_handled` | SQLite mailbox, immutable sender-key deduplication, active/revoking/revoked grants, separate delivered/ACK/resolved facts. Does not start tasks or wake idle agents. |
| Real host context delivery | Awaited pre-step/model/persistence hooks; standard nonhuman `user/message` events and atomic receipt ledger | Actual pinned AgentLoop tested in-process with keyless recording model. No fabricated human role/permission. Two-host transport acceptance pending. |
| Bounded large-message delivery | Stable scalar-safe fragments, conditional byte-BPE upper bound, exact body-result JSON/cursor budget | Unknown tokenizer/framing is not certified. Incompatible budget stops explicitly rather than silently dropping/rechunking. |
| Resync and unresolved matters | `session_poll_events`, `session_get_coordination_snapshot`, durable refs and canonical lineage checks | Stable caller-bound snapshot/H, signed cursors, independent mailbox. Dedicated full compaction/concurrent checkpoint acceptance remains incomplete. |
| Managed ordinary file changes | Existing `read` / `write` / `edit` names plus `claim_files`, `release_files`, `apply_file_change`, `get_mutation_status` | Trusted writer checks identity, leases, fencing, same-snapshot SHA-256/read receipts and strict patches. Linux component and SIGKILL evidence; enabled-profile integration still needs full acceptance. |
| File operations supported | Create absent ordinary UTF-8 file, replace after complete read, exact byte-range patch, delete, same-filesystem no-overwrite rename | Parent directories must exist. Rename requires two current claims and native `RENAME_NOREPLACE`. No overwrite rename, cross-volume move, fuzzy patch, directory mutation or cross-file transaction. |
| File recovery and retries | Immutable mutation records, staged/namespace evidence, per-resource recovery freeze, stable terminal event IDs | Real subprocess SIGKILL and simulated actual write/fsync error tests. A rename without a durable syscall-success witness remains frozen. Not a power-loss, real disk-full or portable-filesystem guarantee. |
| Private coordinator | Authenticated Unix socket, SQLite, kernel-held singleton, generation-isolated client requests | Client races tested with fake socket objects only. Actual socket and two-daemon acceptance blocked by cloud `listen EPERM`. |
| Human authorization | Default deny; trusted configured project policy or scoped one-message approval | A relayed message cannot authorize new tools/tasks/history. Minimal headless profile may lack an interactive approval answerer and then must deny. |
| Enabled-mode bypass refusal | Audited profile inventory, replacement `ctx.fs`, exact tool-definition checks and readiness dependencies | Unknown plugins/process launch families disabled or unsupported; no all-arbitrary-code sandbox claim. Full enabled-profile adversarial verification pending. |
| Feature-disabled behavior | No collaboration protection promised; complete bundle deselection restores stock config | Original R02 removed by user; separate R01 stock-tool/JSONL reopen and CLI overlay-removal component tests pass. Actual package uninstall/full stock boot remain unrun; no storage migration is implied. |

## P1–P3 remain extension points

These are **not implemented** and must not be inferred from a communication grant or a schema placeholder:

- P1: delegated task/result protocols, automatic scheduling, waits/cancellation between agents, task ownership and result aggregation.
- P2: starting/forking subagents, worktree allocation/merge/orchestration, repository-wide Git mutations. Worktree identity discovery is only P0 identity—not orchestration.
- P3: richer group conversations, shared planning/UI, workflow automation and other expanded coordination products.

No remote team service, cross-machine coordinator, browser dashboard, ChatGPT plugin, arbitrary shell sandbox/staged importer, or paid model integration was substituted for the requested host plugin.

## Verification is not binary parity

[All 65 required cases](acceptance-matrix.md) are individually recorded, including the removed R02 scope. A case prefix in a test name means the test contributes evidence, not that the whole requirement passes. Build/typecheck/package checks prove different things from actual host startup. Component and process-kill tests do not close the remaining two-Harness-process or platform acceptance gates.
