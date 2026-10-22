# Installation and safe operation

## Release status and prerequisites

This is a **development plugin bundle**, not a completed P0 release or a standalone application. Build/pack success does not establish real host startup, transport, enforcement, or two-process acceptance. Read [the acceptance matrix](acceptance-matrix.md) and [enabled-only scope](scope-revision.md) before using a non-disposable workspace.

Supported target for development:

- Linux, Node **24+**; cloud tests used Node 24.19.0. The writer requires `/proc/self/fd` and Linux descriptor semantics. macOS/Windows/network filesystems are not certified.
- DeepSeek Harness **0.2.1-rc.2**, official commit `687f282e8625c6b8d11ff58211a90524be2e4317`. Do not use a floating host version. The runtime profile also verifies its enabled package versions.
- `pnpm` on `PATH` for the host plugin command. The pinned upstream workspace declares `pnpm@11.28.5`.
- A private, owned, non-symlink coordinator directory **outside every participating project/workspace**. All participating host processes must use the same directory and coordinator configuration. Do not use a network share or copy a live database into a second domain.
- One active coordinator per Linux OS user/mount namespace. A fixed kernel election guard additionally refuses concurrent profiles using different state directories. Do not unlink `/tmp/dsh-collaboration-instance-UID/coordinator.lock` to bypass a live owner. Different users/containers sharing files are not certified participants.
- A fresh headless profile containing only the audited entries in [`src/host/profile.ts`](../src/host/profile.ts). Browser/API terminals, MCP, LSP, shell/subprocess tools, dynamic host loading, plugin/config hot editing, external tools, and tool-result pruning are not supported in this composition.

The development repository is private: [Nerofirstgit/dsh-collaboration-plugin](https://github.com/Nerofirstgit/dsh-collaboration-plugin). Repository access is not npm publication, and a WIP branch is not a release. No remote package registry publication or deployment is implied.

## Build a local installable archive

Run in a dedicated development workspace, not an existing user project:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run test:components
npm run build
npm pack --dry-run
npm pack
```

The expected archive name at version `0.1.0-dev.0` is `nerofirstgit-dsh-collaboration-0.1.0-dev.0.tgz`. Inspect `npm pack --dry-run` before distributing it: the package should contain compiled `lib`, the profile bundle patch, documentation and license, not databases, runtime keys, test workspaces, `node_modules`, or the upstream checkout. `private: true` intentionally prevents accidental npm publication; it does not prevent local tarball installation.

The native kernel-lock dependency must load successfully on the target platform. Do not weaken the lock or switch to PID/mtime/heartbeat ownership if it does not. The pinned `koffi@3.1.1` dependency provides the fixed in-process libc binding for ordinary no-overwrite rename; a system without `renameat2(RENAME_NOREPLACE)` support explicitly refuses that operation. It never substitutes a shell/helper or copy/delete sequence. Dependencies and build scripts remain trusted code; this guide does not authorize installing or executing arbitrary packages.

## Install into an isolated headless profile

The pinned CLI forwards a package-manager verb after `plugin`. Use **`add`**, not `install <archive>`:

```sh
export DSH_HOME=/absolute/private/harness-collaboration-test-home

dsh --version
# Confirm 0.2.1-rc.2 before continuing.
dsh plugin --profile headless add /absolute/path/nerofirstgit-dsh-collaboration-0.1.0-dev.0.tgz
```

Choose a new private `DSH_HOME`, not your ordinary Harness home. The shipped `headless` template initializes the correct base + headless bundle set. A newly invented profile name otherwise starts from base alone and may lack required headless services. Do not use `--from-default-profile` to reset an existing profile: the upstream command replaces its directory and dependencies.

The bundle declares `dsh.bundle.patch`; the CLI reconciles it into the profile's bundle stack. Restart after adding/updating/removing a bundle. The supplied patch disables unsupported host families, replaces filesystem/persistence paths, and adds a collaboration-readiness dependency before the headless runner or agent factory starts.

CLI evidence: pinned [`apps/cli/src/args.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/args.ts) and [`apps/cli/reference/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/reference/README.md). These commands are installation instructions, not a claim they have completed production acceptance in this sandbox.

## Configure before starting agents

Keep an explicit local overlay outside the project, for example:

```yaml
- id: session-collaboration
  config:
    enabled: true
    workspace_root: /absolute/path/disposable-project
    data_dir: /absolute/private/harness-collaboration-state
    communication_policy: explicit_only
    heartbeat_ms: 10000
    offline_ms: 45000
    lease_ttl_ms: 60000
    auto_renew: true
    message_limit_bytes: 8192
    mailbox_limit_bytes: 10485760
    injection_budget: 2000
    fragment_bytes: 512
    read_limit_lines: 200
    read_output_bytes: 16384
```

Then inspect the composed configuration **without running an agent/model**:

```sh
dsh --profile headless --patch /absolute/path/collaboration.local.yml --dump-config
```

A patch replaces an entry's whole `config`, not a deep subset; plugin defaults fill omitted declared settings. A home-level or later CLI patch can override earlier layers, so inspect the final tree, not only the bundle file. An inventory dump is not the runtime provider/activation check.

`workspace_root` and read-display limits are per-host settings; they are excluded from shared coordinator configuration. Other coordinator settings must match exactly. The bootstrap refuses changed settings, unsafe mode/ownership, directory or private-file aliases, and invalid existing credentials rather than silently overwriting a domain. Do not loosen directory permissions, delete a lock pathname, replace a runtime key, or delete the SQLite files to get past an error.

### Communication choice

- `explicit_only` is the default and grants nothing by discovery. If no approved host human-approval answerer is present, a send returns `PERMISSION_REQUIRED`; it must not auto-approve. The minimal headless profile may have no such answerer.
- A human may deliberately choose `same_project_enabled` in the trusted profile configuration before starting participants. This grants same-project **coordination messages**, not tasks, arbitrary history access, agent control, or cross-project communication. Do not change this setting as an automatic workaround for a denied send.
- An allowed-once approval, when an audited approval integration is available, is bound to exact sender, recipient and message key; it cannot approve later messages.

A live headless task can call a paid model endpoint. No such command or new credential is necessary for the component tests. Configure/use a real endpoint only with separate authorization; do not copy credentials from unrelated projects. The keyless tests exercise a recording model adapter in-process, not a production daemon transport.

## Verification gates before real use

1. Confirm package/host/profile pins, private state location, no unknown active plugin, and replacement filesystem/persistence providers.
2. Verify actual readiness: no model or tool is dispatched before the shared coordinator connects and required recovery/profile checks finish.
3. Run the two-real-Harness-process cases, including A/B discovery, idle messaging, canonical relay receipts, stale-version writes, unknown tool denial, same-name tool shadows, coordinator loss and process recovery.
4. Inspect durable rows/events and final bytes, not just displayed tool success. Test truncation/compaction cannot retain a stronger read receipt than the model actually saw.
5. Record unsupported platforms and operation types; do not count compilation, packaging, fake sockets or loopback calls as these gates.

Production Unix-socket startup is blocked by this cloud sandbox (`listen EPERM`); a narrow retry also failed before launch at sandbox setup. The project retains the real Unix transport and does not bypass that restriction with TCP or another production transport. Therefore successful two-host startup/acceptance must still be established in an authorized compatible environment.

## Upgrade, disable and rollback without data loss

1. Stop scheduling new work and let in-flight mutations settle. Query the **original** mutation/tool/message IDs after an unknown result; never create a new ID merely to retry an uncertain effect.
2. Stop all participating host processes, then shut down the actual coordinator cleanly. A paused process still owns its kernel lock; do not steal ownership by deleting a file or guessing a PID from a stale heartbeat.
3. Preserve a consistent backup of the entire private state directory after shutdown, including SQLite/WAL-related files, configuration, runtime credential and recovery evidence. Keep credentials private. Preserve the project files and any writer recovery artifacts; they may be required to prove an unfinished result.
4. Install a pinned replacement archive with `dsh plugin --profile headless add /absolute/new-archive.tgz`, inspect the final profile again, and restart only after schema/config compatibility is known. There is no general destructive downgrade/migration tool in this development release.
5. To remove the bundle from this isolated profile, use `dsh plugin --profile headless remove @nerofirstgit/dsh-collaboration` while stopped. The user explicitly removed protection guarantees while disabled/unloaded. Do not label a disabled participant protected, and do not continue sharing it as if it were mediated.
6. Rollback means restoring a known compatible package/profile and a coordinated state/recovery plan—not overwriting a live database with an old snapshot. Reverting counters while old credentials/executors exist can revive stale authority. If the domain must be rebuilt, establish new domain credentials and invalidate old executors through an explicit migration.

Removal must not delete the collaboration database, canonical session history, user files, or recovery artifacts. Automatic migration of coordinated session history back to stock JSONL persistence is not provided; preserve/export it through an explicitly reviewed procedure before changing persistence backends.
