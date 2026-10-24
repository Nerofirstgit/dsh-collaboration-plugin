# Automatic same-project collaboration

> Dated implementation checkpoints and test results below are historical. For the current published scope and compatibility limits, start with the [README](../README_EN.md).

The owner assigns each participating session its task once. Sessions discover peers, publish a short task summary, communicate about overlapping work, and continue the original task without a person relaying messages or tool instructions.

## Execution contract

- New compositions default to `same_project_enabled`. Project identity remains the boundary; this does not authorize another project, arbitrary execution tools, or unrelated work requested by a peer. `explicit_only` remains available.
- A fixed host policy explains coordination before each model turn. Peer messages retain their existing non-human attribution and canonical delivery receipts.
- Normal managed writes acquire all required claims atomically. Temporary contention is handled with bounded, cancellable waiting. Implicit claims are released after a settled write; explicit reservations retain their explicit lifecycle.
- A stale edit can be rebased only when a fresh read and strict unique patch prove that another writer's change is preserved. Ambiguous/overlapping changes remain visible to the model for coordination; they are never replaced blindly.
- Unknown mutation outcomes retain their original operation identity and hold/recovery rules. No automatic retry may invent a new identity to conceal an uncertain prior result.
- Sessions can wait for coordination within the original running task, releasing file reservations while waiting. Newly queued authorized messages at the turn-ending boundary can extend that same turn a bounded number of times. Completed, failed, cancelled and approval-blocked tasks are not restarted by peer messages.
- Peers do not send acknowledgment-only replies or repeat unchanged announcements. Exhausted waits, irreconcilable task goals and uncertain effects are reported with concrete evidence instead of asking the owner to relay messages.

## Existing-domain migration

Changing a default does not silently change a live domain. Installation into the existing Desktop must stop its participants, back up the configuration, explicitly change only the communication policy in the persisted domain and profile, and retain the original database, runtime key, operation ledger and election state. Existing manual revocations are not bypassed by creating a new grant ID.

## Acceptance seams

1. Real Coordinator RPC: default project authorization, recipient-only pending delivery hints, actual canonical delivery, revocation and project separation.
2. Real AgentLoop/tool pipeline: occupied files, cancellation, safe stale-edit merge, overlapping changes, lost mutation replies, bounded continuation and zero extra model requests without new mail.
3. Both reviewed SDK versions: component regression and type checks.
4. Existing installed Windows Desktop: create two sessions in one ordinary test workspace, submit each natural task once, observe discovery/messages and final shared bytes. Preserve logs and report whether real model requests occurred; scripted fixture results alone do not certify model-driven collaboration.

Validation results are recorded in the local Windows installation report after execution.
