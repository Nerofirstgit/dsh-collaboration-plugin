# dsh-collaboration-plugin

DeepSeek Harness collaboration plugin. **Development in progress, not a completed P0 release.** Engineering runs only in the cloud workspace. The user-created private repository is `Nerofirstgit/dsh-collaboration-plugin`. The user has authorized WIP delivery to `main`; only the parent task publishes immutable snapshots. That authorization is not evidence a publication has completed, and WIP source is not a production release or deployment.

Target host: DeepSeek Harness `0.2.1-rc.2`, official source commit `687f282e8625c6b8d11ff58211a90524be2e4317`. The deliverable is an installable Cordis/dsh bundle, not a standalone agent application or a ChatGPT plugin.

Scope: P0 independent-session discovery, durable messaging, and managed shared-file writes. Later phases are extension points only. The user removed the guarantee after disabling the plugin; while enabled, only a pinned, audited minimal headless composition can be protected. Arbitrary same-process plugins and external writers are not sandboxed by another plugin. See the [revised scope](docs/scope-revision.md) and [source evidence](docs/host-write-boundary.md). No host source patch has been applied.

Managed writes activate only after the actual loader inventory, exact package identities and concrete protected providers validate. Constructed real-host component tests exercise that path; production startup is not yet certified. Component successes do not certify all in-scope mandatory requirements: production Unix sockets and two real Harness processes remain blocked/unrun in this cloud sandbox.

## Current implementation and limits

- The feature-absent baseline exercises real stock host read/write/edit tools and JSONL close/reopen without collaboration. CLI configuration composition returns to the original profile when the whole bundle overlay is omitted. This is not a full profile boot or live package-uninstall test. See [R01 evidence](docs/disabled-baseline-evidence.md).
- Focused writer tests inject short writes, `ENOSPC`, `EIO` and `EROFS` at selected write/flush calls. They check abort, recovery and retained unknown outcomes, not actual disk exhaustion, read-only mounts or power loss.
- Ordinary same-filesystem, no-overwrite file rename is now implemented on Linux with `renameat2(RENAME_NOREPLACE)`. It requires both current leases, a source read/version receipt and an explicitly absent destination. Focused component, registered host-tool and process-kill tests pass; production two-host validation remains open. Recovery commits only with a durable syscall-success witness plus matching parent identities, destination inode/hash and absent source. A move-shaped state without that witness leaves both paths in `needs_recovery`.
- Destination overwrite, cross-filesystem moves, directory moves and staged external-tool imports are unsupported. Rename has no copy/delete fallback. Repairing an already-persisted unknown host tool result remains a fail-closed hold, not automatic recovery.

These implementation limits are separate from blocked production socket tests and unrun live-profile, two-process and platform validation. No complete in-scope mandatory acceptance case is signed off.

## Development checks

```sh
npm ci --ignore-scripts
npm run test:components
npm run typecheck
npm run build
```

Current supported verification platform: Linux, Node 24. The bundled private coordinator is not a user-facing application launcher. Harness applications must still launch through `dsh` profiles.

See [development handoff](docs/HANDOFF.md), [installation](docs/installation.md), [verification log](docs/verification-log.md), [65-case matrix](docs/acceptance-matrix.md), [plan](docs/PLAN.md), [real host integration map](docs/host-integration-map.md), and the complete technical [requirements](docs/REQUIREMENTS.zh.md).
