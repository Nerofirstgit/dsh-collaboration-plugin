# Feature-absent stock-host baseline (R01 component evidence)

Target: official DeepSeek Harness `687f282e8625c6b8d11ff58211a90524be2e4317`, installed packages `0.2.1-rc.2`. The executable evidence is [`tests/host/disabled-baseline.test.ts`](../tests/host/disabled-baseline.test.ts). Production modules and the upstream checkout are unchanged.

## Exercised behavior

- A real stock `AgentLoop` executes the official `tool-fs` `write`, `read`, and `edit` tools through the native tool runtime, `LocalFileSystem`, `WorkingDirectoryService`, and stock filesystem observation policy. The local scripted model performs no API request. This selected stock component assembly does not install the collaboration bundle, its guards, runtime, coordinator or replacement providers. Collaboration tool names and readiness service are absent, and actual model requests contain no collaboration schemas or coordination messages.
- The official JSONL persistence plugin materializes its real on-disk session log (`compression: none` is a supported fixture setting), checkpoints ordinary tool results, closes its actual owner, and reopens through a fresh stock host context. The canonical event prefix, header and derived conversation are preserved. The restored agent stays idle until follow-up, then stock `read` and `edit` run successfully again. The test accounts for JSONL's documented serialization of omitted `delegationDepth` as `0`; it compares the reopened header with the pre-close canonical storage header.
- The official CLI's `--dump-config` composes a fresh headless profile before, with, and after a transient `--patch ./cordis.patch.yml`. Omitting the complete overlay returns exactly the original composed stock profile, including ordinary JSONL persistence, `fs-sandbox`, `tool-fs`, and observation-policy entries. No collaboration entries or readiness dependencies remain. The inspected patch is the package's declared `dsh.bundle.patch`.
- Calling the production entry with only `enabled: false` rejects explicitly before bootstrap. It does not create the nominated data directory or publish persistence/readiness services. A partial toggle is not treated as successful stock-mode activation; the entire bundle must be deselected while the profile is stopped.

## Limits

This is in-process ordinary-host behavior plus real CLI configuration composition, not a complete stock profile boot, live package install/uninstall, interactive UI test, cross-platform suite, or two-process acceptance run. The component fixture uses the official local filesystem provider; the CLI composition assertion separately verifies that the unmodified stock profile selects its original sandboxed filesystem provider. No socket listener, external endpoint, user-machine access, or transport workaround is involved.

Removing the bundle does not migrate collaboration-backed canonical sessions to stock JSONL. These tests create a separate stock session and preserve its stock log; they do not assert that coordination storage may be discarded. Disabled/unloaded participants carry no collaboration protection guarantee under the user's revised scope.

## Commands

```sh
node --import tsx/esm --test tests/host/disabled-baseline.test.ts
npm run typecheck
```

At the recorded run on 2026-10-21: all three focused tests passed and typecheck passed. The broader socket-inclusive test command is intentionally not used for this evidence.
