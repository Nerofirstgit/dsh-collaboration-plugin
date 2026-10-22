# Portable Windows / GUI implementation candidate

This is a **development candidate**, not native Windows certification, a complete GUI boot, or all-65-case acceptance. The authoritative scope is cooperation among enabled DeepSeek Harness (dsh) sessions. Unrelated programs' file changes are outside prevention; dsh shell, MCP, subagents and tools are not exceptions.

## Implemented boundaries

- The portable coordinator uses Node IPC (Windows named pipe / Unix socket), separate SQLite lifetime election, canonical session history, durable messaging and the managed writer. The owner is never replaced merely for being paused. Never delete election/database/journal files to take ownership.
- The writer uses portable Node filesystem operations. Windows existing-resource aliases are resolved through filesystem evidence; missing names conservatively serialize the parent namespace. Unmarked legacy Windows identity stores require explicit migration. This is not a raw-shell or unchecked Windows fallback. Native Windows filesystem and process execution remain unverified.
- Protocol `2` is required by production bootstrap. Every new connection verifies it. GUI clients retain their host-state roots and re-reserve them before later session RPCs, including reconnect. Incompatible daemons are rejected, not spawned over; uncertain mutations are never automatically replayed with new IDs.
- `reserve_host_state_roots` commits an append-only reservation of the selected Harness home against **all** stored workspaces, including offline sessions. Later registration also checks it. This setup RPC is not exposed as a model tool. Successful root startup waits for the exact committed acknowledgment; timeout, wrong acknowledgment or disposal cannot publish readiness.
- Actual session `create` and write `open` revalidate the trusted session cwd, persisted original workspace root, unchanged GUI state configuration and the live controller guard. They do not substitute the backend process cwd. Read-only inspection does not acquire execution authority.

## Actual GUI composition, not a wildcard allowlist

`buildGuiOverlay` and `checkActiveGuiProfile` are distinct: an offline config dump is not runtime authorization. The live check verifies actual Loader topology, package identities/versions, `ProtectedFileSystem`, `CoordinationSessionPersistence`, restricted ConfigEditor, dedicated empty collaboration preset and the installed controller guard.

The official SessionController Loader root stays enabled, retaining its actual browser client bundle and Typert manifest. An owned component wraps **that instance's public `create` method**, with pinned source evidence and real Gateway tests; it does not replace package metadata or mutate the host prototype/source. It validates human-selected placement before stock mkdir, then delegates unchanged business behavior. The provider independently gates subsequent create/open operations.

General `collaborationReady` requires the coordinator reservation. The real controller guard then publishes `collaborationGuiControllerReady`. Webserver, Typert gateway and Web runtime wait for the second gate. The carrier-neutral connection registry cannot wait for that second gate because it is a prerequisite of the controller's file-upload service; it has no `/api` listener until the separately gated WebServer exists. Config-only tests check the dependency closure and retained browser module declarations. This does **not** prove an actual browser boot.

The restricted editor preserves reviewed presentation settings (theme/locale); arbitrary plugin/config/path mutation is refused. Normal session/workspace UI components remain in the reviewed composition. Unsupported write/process entrypoints are disabled, including terminal/subprocess/shell, MCP, external agents/jobs/workflows, dynamic plugin management/HMR, unreviewed permission presets, office conversion, workspace-change subprocess helpers and optional unsafe settings pages. There is no promise to preserve every stock GUI feature.

The fixed composition retains the real in-memory `LocalJobRegistry` so Desktop stock quit/update inspection remains functional; job controllers/producers/executor tools remain disabled. With no controller, `jobs.start` refuses before its run callback. Desktop also mounts Office plugins after `runProfile`, outside Loader inventory: the pinned skill provider reads resource text, while the workspace-dependency installer is an unowned tool rejected before execution. These narrow source/component findings are not whole-Desktop boot proof.

## Startup and shutdown

Use cold starts with the complete overlay. Mid-session enablement and seamless hot fallback are not supported. On guard disposal, its instance-local wrapper refuses new create calls while dependent components shut down; an in-flight create must still pass the live persistence gate. Reinstalling a known inactive guard does not stack wrappers. A fresh stock controller after complete overlay removal/cold restart is unchanged. The user explicitly excludes disabled-mode collaboration protection; temporary shutdown refusal is not permanent protection after removal.

Stop all old participants/coordinators before upgrading. The previous Linux-native election namespace and new portable protocol do not interoperate. Preserve histories, IDs, recovery evidence and keys; do not copy a live database into a second domain or silently migrate identity schemes.

## Offline generation / packaging

The default package bundle still provides the audited headless baseline. GUI use explicitly composes the official `web` or `desktop` base, the installed bundle, then a generated GUI overlay. Do not apply the headless bundle alone to a real GUI profile and assume compatibility.

The package includes:

- `@nerofirstgit/dsh-collaboration/gui-profile`: deterministic builder and live checker;
- `@nerofirstgit/dsh-collaboration/gui-config-editor`: restricted provider;
- `@nerofirstgit/dsh-collaboration/gui-controller-guard`: instance guard;
- `dsh-collaboration-gui-config`: offline CLI reading an official composed `--dump-config`.

The CLI requires explicit absolute paths, never evaluates `!!js` expressions, emits only the fixed overlay rather than source credentials, and only creates a **new** UTF-8 output file. It does not install packages, modify existing profiles, bind a listener or call a model. See the [Windows native test handoff](Windows原生候选版测试交接.md) for isolated use and stopping conditions.

## Remaining gates

1. Windows-native Node/SQLite/named-pipe, canonical alias, managed publication and crash-recovery tests on the declared local filesystem.
2. Official `dsh plugin --profile ... add <tgz>` and packed exports, distinct from source-linked fixtures.
3. Two **real Harness processes**, including live discovery, idle delivery, conflicts, lost replies and coordinator/process death; existing source fixture covers only a finite subset.
4. Actual pinned Web UI and the user's actual Desktop surface, including first state write, API/GUI startup ordering, approval, blank reuse, cold open/fork/archive and shutdown/restart. Desktop's Electron `userData` is separate from `DSH_HOME`; do not assume setting one isolates both.
5. Full 65-case matrix review under the revised scope. Component counts are not acceptance IDs.

Cloud bind restrictions prevented original transport tests here. That is not an observed product failure. No alternative transport was introduced to evade them. Windows directory fsync, whole-machine power-loss guarantees, arbitrary external-process defense, native Windows ACL isolation, network shares and cross-user/container participants are not certified.
