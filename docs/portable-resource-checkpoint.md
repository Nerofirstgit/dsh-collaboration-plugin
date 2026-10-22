# Portable resource identity / writer checkpoint

> Historical incremental checkpoint. Later implemented resource identity, GUI production wiring and exact remaining gates are described in [gui-candidate.md](gui-candidate.md). Earlier “not implemented” statements below describe that frozen step, not the latest source.

2026-10-22. This is implementation for cooperating, enabled DeepSeek Harness (dsh) sessions, not prevention of unrelated programs' changes. Native Windows acceptance is still pending; the shipped active profile remains minimal headless. Desktop/Web wiring is a separate unfinished slice.

## Changes

- Canonical Windows workspace and resource identities use actual directory component spelling and a unique per-parent object match for existing case/short-name aliases. Never lowercase a path and assume equivalence; preserve case-sensitive siblings. Reject ambiguous IDs, incomplete enumeration, unsupported roots and internal links. File IDs are resolution evidence, not permanent logical path keys.
- New Windows workspaces stamp `canonical-components-v1`. Existing unmarked Windows identities/history require explicit offline migration: no silent rehash, deletion, or new parallel write domain. Linux identity hashes retain their original spelling semantics.
- Enforce explicit workspace roots even when Git reports a different top-level directory. Canonicalize coordinator state paths before deriving endpoint identity.
- Windows missing-name leases reserve only the canonical parent namespace, because future case/8.3 aliases cannot be predicted safely. Different existing files remain independently claimable. Creation of distinct absent siblings by different sessions is conservatively serialized until the reservation is released or the created entry becomes present. Delete/rename-source also reserve the soon-missing namespace.
- Durable prepared intents retain namespace freezes through lease expiry/restart. Preparation is a real committed transaction, not a savepoint inside a filesystem-action transaction. The separate lifetime election database continues to exclude other participating writers.
- Persist original lexical claim/mutation inputs so identical idempotent retries can recover a known outcome without resolving a now-removed parent.
- Windows rename-source flush opens with read/write access because libuv uses `FlushFileBuffers`; no skip-fsync fallback. Directory fsync and whole-machine power-loss durability are not claimed on Windows.
- Windows mutations now require the identity-scheme marker instead of being unconditionally disabled. Status labels them `implementation-candidate`, with native Windows acceptance pending. This is not certification of the Windows filesystem/runtime.

## Verification and limits

The writer-specific run passed **164/164**, including original process-kill/recovery cases, portable policy tests, and the actual resource resolver test file. Windows path behavior is tested with injected filesystem fixtures; conservative namespace behavior runs with real SQLite/files on Linux. These are not native Windows tests.

A genuine integration failure found during this slice was a TypeScript constructor parameter property accepted by tsx/typecheck but unsupported by native Node strip-only crash workers. It was replaced with explicit field assignment; a native-import regression now covers this source execution path. Initial failure logs are retained outside the deliverable source tree.

Follow-up correction: `claim_files` now persists `path_mappings` containing each distinct original `requested_path`, canonical `path`, and `lease_id`. The root rename adapter joins this authoritative mapping rather than inferring paths lexically or relying on array order. Identical raw path-set retries retain mappings even after a parent is removed; changed alias spelling under an existing mapped request ID is `IDEMPOTENCY_CONFLICT`. Legacy cached results without mappings are not invented or upgraded: rename fails with original-mutation reconciliation guidance. The input validator also now separates path grammar from filesystem-aware containment, permitting a proven existing Windows root/8.3 alias to reach the resolver. No raw-write fallback is allowed.

The correction passed 175 writer/resource tests plus 22 host claim-mapping/plugin tests on Linux. Windows-looking path fixtures remain simulations, not native Windows acceptance.

No socket listener was run for this checkpoint. Original socket tests remain pending in a supported, separately authorized environment; the cloud bind restriction is not evidence of a product defect. The 65-case matrix and real Windows two-Harness/GUI/install gates are not complete.
