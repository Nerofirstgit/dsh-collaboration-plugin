# Development handoff — Windows candidate, not P0 certification

The current deliverable is an installable Cordis/dsh plugin bundle for DeepSeek Harness `0.2.1-rc.2`, official source `687f282e8625c6b8d11ff58211a90524be2e4317`. It is not a standalone assistant application or a ChatGPT plugin. No upstream source patch was applied.

The user confirmed **native Windows**, portable Node APIs first, and cooperation among enabled dsh sessions only. Other programs' edits are outside prevention; dsh tools/shell/MCP/jobs/subagents remain mediated or denied. Disabled/cold stock profiles do not retain a collaboration guarantee. See [scope revision](scope-revision.md), [current candidate contract](gui-candidate.md), and the [Chinese Windows local testing handoff](Windows原生候选版测试交接.md).

The user separately requested that their own local session run tests. That supersedes the earlier operational note against moving tests to their computer **only for that user-run session**; the cloud development agent is not authorized to operate their machine. 本开发版在云端实现；后续开发不依赖您的电脑在线。

## Verified checkpoint

At code commit `697f75c76084f2fc9abfa85c5abbb00cafd7f80e`, a clean source archive without the upstream checkout passed:

- `npm run typecheck`
- `npm run build`
- `npm run test:components`: **620 passed, 0 failed, 0 skipped**

Platform: cloud Linux, Node 24.19.0. Counts include portable election/process tests, writer/context recovery, actual host persistence/model/tool seams, GUI composition and mounted stock-controller/Gateway component tests, real pinned Desktop quit/update inspector functions, and late Office tool denial. They do **not** establish native Windows, actual browser/Desktop startup or two real networked Harness processes. Some older complete-suite fixtures still need native Windows adaptation; do not silently skip them and call Windows green.

The earlier first Desktop correction suite failed 3 mounted-provider fixture setups (609/612); the production checker newly required the real jobs registry. The fixture now mounts that actual provider behind its readiness dependency; existing business assertions were preserved. The initial failures and subsequent independent reviews are retained in the engineering workspace and summarized in [verification log](verification-log.md).

## Implemented, with limits

- Portable production Node IPC and filesystem operations; separate SQLite lifetime owner election; Windows canonical-component/namespace identity and conservative legacy rejection. The fixed account-level election directory is independent of DSH_HOME; do not remove it to bypass a paused owner.
- Durable messages/context receipts and managed read/version/lease/mutation recovery. Unknown operations keep their original IDs and may hold execution pending recovery; no raw-write fallback.
- Fixed GUI composition with restricted settings, protected provider, general readiness plus a separate controller/carrier barrier. Real stock SessionController is instance-guarded, not patched on disk/prototype. Fresh cold stock instances after complete overlay removal remain unchanged.
- Desktop inspection retains the actual in-memory jobs registry, not job executors. The pinned late Office installer definition is rejected before its execution body. Loader inventory is not claimed to enumerate arbitrary application-owned code.
- Same-filesystem no-overwrite rename only; destination overwrite, cross-filesystem/directory moves and staged external-tool imports remain unsupported. Already-persisted unknown tool results retain an execution hold instead of unsafe relabeling.

## Open gates and stopping conditions

1. Native Windows Node/SQLite/named-pipe, resource aliases, managed writes and process-crash behavior on the declared filesystem.
2. Official `dsh plugin --profile ... add <tgz>` installation, separate from a source-linked fixture.
3. Two real Harness processes: the preserved keyless fixture covers discovery, one boundary relay, stale write rejection and two successful writes only. Idle delivery, restart, lost replies and daemon/process death need separate scenarios.
4. Actual Web and actual Desktop, including approval and UI/session lifecycle. DSH_HOME does not isolate Electron userData. Do not launch the user's normal Desktop as a substitute for a verified isolated setup.
5. The [65-case matrix](acceptance-matrix.md), interpreted under revised scope. No complete in-scope mandatory case is signed off by this checkpoint.

Cloud socket binding was denied; it is not an observed product defect. Do not retry that denied environment operation, weaken policy, or introduce alternate transport just to make the gate green. Real model usage, new credentials, system settings, real updates and deployment require separate authority.

## Delivery / operations

Parent task alone publishes exact allowlisted WIP snapshots to the private repository `Nerofirstgit/dsh-collaboration-plugin`; user authorization permits updating main, not production deployment. Local HEAD/artifact creation does not prove remote publication. Compare the external delivery manifest's commit/tree and SHA256, not the reused dev package version.

Preserve user files, SQLite history, keys and recovery artifacts during upgrade/removal. Stop all participants/coordinators before upgrading; old native-election and current portable protocol domains do not interoperate. Do not duplicate live state, clear unknown intents, delete election journals, grant broad messaging permission to bypass a denial, or restore unmediated tools. See [installation](installation.md) for deliberate configuration and [Windows handoff](Windows原生候选版测试交接.md) for user-run commands.
