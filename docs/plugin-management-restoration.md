# Native plugin management restoration

> Dated implementation checkpoints and test results below are historical. For the current published scope and compatibility limits, start with the [README](../README_EN.md).

## Requirement
Restore the original Desktop plugin page and Add Plugin dialog without replacing the native package manager. Keep the existing Desktop version, sessions and collaboration state. Verify a newly installed plugin and two automatically coordinating sessions in the same real profile.

## Architecture and lifecycle
The native PluginManager retains its RPC methods, inspection, pnpm invocation, cancellation and package lock. An instance-owned guard validates the complete target composition inside the native transaction and restores configuration bytes on admission failure. The current native cold-restart lifecycle reports `restart-required`; a successful install must not pretend the new backend is already active.

The pinned host baseline remains separate from optional reviewed adapters and data-only managed tool bundles. The latter use an exported collaboration provider, strictly validated declarative templates and the real Tools registry; their package patches never load arbitrary package code. Unsupported executable providers receive an actionable compatibility error before a broken enabled composition is committed.

## Technical boundaries
Public HTTP carriers wait for the actual manager guard. A target validator reads official composed profile patches and installed metadata without importing new plugin code. State roots cannot relocate. Active tasks are not cancelled for an installation. The running profile fingerprint stays pinned until a normal cold restart.

## Validation and tasks
1. RED/GREEN native manager lock, rollback, cancellation and ownership tests.
2. Restore native UI entries; test target admission and declarative plugin tools.
3. Build and regress both exact SDK versions; independent code/security review.
4. Prepare revision 6, back up and install after normal Desktop exit.
5. Use the actual Add Plugin dialog, restart, run the new tool and automatic A/B file collaboration; verify persistence and leave Desktop visible.

## Acceptance limits
Hot reload and arbitrary unadapted executable plugins are distinct compatibility work; no claim of universal executable-plugin isolation or hot reload follows from restoring the native management UI. These limits must remain visible in delivery evidence.
