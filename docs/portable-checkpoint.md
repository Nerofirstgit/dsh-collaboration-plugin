# Portable Node correction checkpoint — Windows use is not yet accepted

> Historical incremental checkpoint. Later implemented resource identity, GUI production wiring and exact remaining gates are described in [gui-candidate.md](gui-candidate.md). Earlier “not implemented” statements below describe that frozen step, not the latest source.

## Authority and scope

On 2026-10-22 the user confirmed native Windows, cross-platform runtime APIs first, and collaboration **among participating enabled DeepSeek Harness (dsh) sessions**. Preventing unrelated programs from editing files is excluded. dsh tools, shell, MCP, jobs and subagents are not external-program exceptions: their project mutations still require mediation or explicit denial. Disabling the plugin is outside the collaboration guarantee.

This source checkpoint supersedes the old Linux-only implementation descriptions below. It is not the already published `fe7aad054e223163edb8a11b77826497db1c6819` snapshot, a Windows-compatible release, or a change to the pinned host. No remote action is performed by these source changes.

## Implemented in this checkpoint

- `src/platform/election.ts` holds a **separate SQLite database's `BEGIN IMMEDIATE` transaction** for the coordinator lifetime. Bootstrap, global election and application journal are separate connections/databases. A pause never permits timed takeover. Process exit releases SQLite ownership. Application prepared-intent commits remain real commits, not savepoints under the election transaction.
- `src/instance-lock.ts` acquires the fixed OS-account election before the configured domain election; production namespace cannot be split by HOME, DSH_HOME or TMPDIR. The test-only namespace argument is not profile/RPC configuration. Shutdown retains ownership until accepted operations, session cleanup and Store close finish.
- `src/platform/ipc.ts` selects the existing Node `net` framing over Unix sockets or a Windows named pipe. Windows pipe lifecycle does not call file unlink/chmod/lstat. No TCP or file-spool substitute was introduced. **No listener was run in this cloud checkpoint.** Native Windows pipe startup/authentication behavior still needs execution evidence.
- Bootstrap serializes initial config/key creation with another short SQLite transaction. Three independent filesystem-only starter processes converge on one config/key in the component test. Existing config mismatches fail closed.
- Managed writer and ordinary no-overwrite rename use Node filesystem APIs instead of `/proc` descriptor paths, Linux-only open flags or `koffi`. The writer retains intents, leases, read receipts, hashes, unknown outcomes and recovery. The absent-target check is an exclusion contract among serialized participants, **not** atomic prevention of an unrelated program's rename.
- Direct plugin dependencies on `koffi` and `@deepseek-ai/node-addon-system` are removed. Official host peers may still bring their own native/transitive dependencies; this does not claim the whole host is pure JavaScript.
- A default `process.cwd()` no longer binds every GUI-created session to the host profile directory. Each trusted `SessionHeader.cwd` can establish its own project. An explicitly configured single-workspace root remains restrictive.
- Runtime status exposes the cooperating scope, current writer capabilities, unimplemented GUI integration and incomplete Windows acceptance. An existing status-output bug (`profile: undefined` failed the host's lossless JSON validation) was corrected to `null` and tested through the real tool pipeline.
- The [GUI adapter plan](windows-host-adapter-plan.md) and config-only topology tests preserve the normal Web/Desktop goal without pretending the current closed headless inventory already admits it.

## Deliberate current gates

**Windows new claims, mutations, recovery and artifact cleanup still fail closed pending filesystem-aware resource equivalence.** Path spelling normalization alone cannot keep case/short-name aliases from splitting resource ownership. Existing completed outcomes remain queryable; an empty discovery-only state can be initialized. This is an intermediate checkpoint, not the final Windows implementation.

The current concrete host profile is still the audited headless composition. Normal Desktop/Web service composition, scoped collaboration preset and readiness integration are the next host adapter work. Do not install the current package into a real Windows profile or replace this gate with raw write/shell fallback.

Windows directory flush has no portable guarantee through the Node API used here. Capabilities declare file flush and process-crash recovery, **not certified power-loss durability**, Windows ACL isolation, arbitrary external-edit prevention or uniform filesystem behavior. Native Windows tests remain required, even where mocked platform selectors pass on Linux.

## Upgrade and evidence rules

Stop **all old-version collaboration coordinators and participating sessions** before migration. The old Linux flock namespace and the new SQLite election protocol do not interoperate; mixed-version rolling upgrades are unsupported. Preserve canonical history, journal, keys and recovery artifacts. Never unlink/replace an election SQLite database or its journal files while an owner may exist. Do not run a parallel test domain against production files.

Safe local source checks (no coordinator listener):

```sh
npm run typecheck
npm run build
npm run test:components
```

The component command explicitly excludes `tests/server.test.ts` and `tests/integration/two-host-processes.test.ts`. Their cloud execution restriction is an environment limitation, not an observed Windows product failure. Actual native Windows two-Harness runs and the user's target Desktop/Web surface must be accepted separately.

Initial combined run: 318/320 passed. Both failures were stale test setup assumptions: the reserved election namespace is no longer `/tmp`, and ancestor-symlink state now rejects before `InstanceLock.acquire` succeeds. Assertions were updated to exercise the fixed OS-account namespace through isolated test injection and to retain the original identity rejection in addition to the earlier bootstrap rejection. The initial log is preserved outside the source deliverable. Do not erase a failure or count only selected green tests as full acceptance.

The checkpoint's final full count and command outcome are recorded in [verification-log.md](verification-log.md). Historical Linux baseline evidence remains below and must not be relabeled as Windows acceptance. No complete 65-case signoff is claimed.
