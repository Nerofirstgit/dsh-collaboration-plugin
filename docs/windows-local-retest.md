# Native Windows local retest — 2026-10-22

> Dated implementation checkpoints and test results below are historical. For the current published scope and compatibility limits, start with the [README](../README_EN.md).

Environment: native Windows x64, NTFS, Node 24.9.0 / SQLite 3.50.4, DeepSeek Harness 0.2.1-rc.2, Cordis 4.0.5. All projects, profiles and coordinator state were disposable. The ordinary Desktop installation (0.2.0-rc.2) was neither started nor modified.

## Repairs

- Startup admission checks the exact persistence instance owned by the currently activating Cordis fiber. Runtime checks still require that original active instance; replacement, foreign ownership, unknown providers and removal fail closed.
- Shutdown stops new runtime admission, drains accepted hooks and lifecycle updates, closes persistence handles, then permanently disposes the owned coordinator client. Cleanup errors remain visible. The reusable `close()` API remains available separately from terminal `dispose()`.
- The offline GUI CLI has no Harness peer runtime import. Its YAML schema never evaluates JavaScript. Only the three fixed official Desktop conditions, matched by exact plugin identity and expression, are resolved statically; arbitrary expressions and forged values are refused.
- Only the private daemon is bundled. Its exact official SDK validators remain intact, its runtime imports are limited to Node builtins, and bundled licenses are included in `lib/daemon-entry.NOTICES.txt`. Public host entrypoints retain the host SDK instances. `--check-runtime` checks the installed daemon without creating state or listening.
- Windows fixtures initialize canonical workspace identities, use ordinary junctions for directory-alias cases, check actual abrupt child termination, track injected file descriptors without `/proc`, preserve pinned LF source hashes, and import Windows paths through file URLs. The IPC platform selector uses explicit POSIX paths for its POSIX branch.

## Verified scope

| Check | Result |
| --- | --- |
| Typecheck / build | Pass; build also bundles the private daemon |
| Native component suite | 616 total: 613 pass, 0 fail, 3 existing skips |
| Native IPC singleton / authentication | 2/2 pass |
| Two independent real headless Harness processes | Pass; source-linked plugin fixture with production named pipe |
| Official tgz installation | Pass in a new test home using `dsh plugin --profile web add` |
| Installed GUI CLI | Pass without Harness peer resolution; both Web/Desktop overlay generation and overwrite refusal |
| Installed daemon runtime | Pass with only Node builtin imports |
| Isolated installed Web | READY, token-to-cookie exchange, HTML and all initial script assets HTTP 200 |

The two-host fixture records both PIDs/session IDs and the authenticated daemon PID. Each host makes five local fake-model requests; one message is delivered with one durable context receipt; two file mutations commit. B's stale edit is rejected before a reread, the final file is exactly `base\nA\nB\n`, and both hosts exit naturally. This is one finite scenario, not all crash/idle/revocation combinations.

The installed Web check submits no model prompt, uses no real provider key, redacts its launch token, and stops only its own host and authenticated daemon. It verifies startup and resource delivery, not browser execution of every UI flow. Desktop overlay generation alone is not Desktop activation.

## Platform boundaries

- The Windows directory enumeration bound remains enforced. Tests set TEMP/TMP to a clean private directory; they do not clear the user's large Temp or increase production limits.
- Windows Node does not expose the POSIX directory-fsync guarantee. Thirty POSIX fault cases remain in the POSIX branch; Windows uses four explicit unavailable-capability cases with real mutation/recovery checks. The test count therefore changes; these cases do not claim POSIX failure-window coverage on Windows.
- Junction rejection is tested without enabling Developer Mode. Privileged Windows file-symlink creation and whole-machine power-loss durability are not certified.
- The account-level SQLite election directory is still used and retained. Databases, journals, original unknown operation IDs and runtime keys are never deleted to force acceptance.
- The three existing skips remain; no test was skipped to conceal a new native failure. No production guard or permission setting was relaxed.

## Repeating the checks

Use a new isolated directory outside production workspaces, install the locked development dependencies with `npm ci --ignore-scripts`, and set this terminal's TEMP/TMP to a private existing directory before testing:

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:components
node --import tsx/esm --test --test-reporter=tap tests/server.test.ts
$env:DSH_TEST_KEEP_ARTIFACTS = '1'
node --import tsx/esm --test --test-reporter=tap tests/integration/two-host-processes.test.ts
Remove-Item Env:DSH_TEST_KEEP_ARTIFACTS -ErrorAction SilentlyContinue
```

Run listener/daemon cases sequentially after checking for another active coordinator. Keep their private evidence directories; share only reviewed summaries.

After packing and installing the archive into an isolated Web profile:

```powershell
node tests/installed-gui-config-smoke.mjs <profile-dir> <official-dump.yml>
node tests/installed-daemon-runtime-smoke.mjs <profile-dir>
node tests/installed-web-smoke.mjs <isolated-home> <generated-overlay.yml> <project> <coordinator-state> <new-evidence-dir>
```

The Web smoke requires a genuine installed archive, refuses evidence overwrite, fetches only its local origin and keeps credentials out of its summary. None of these commands install into or launch the ordinary Desktop profile.
