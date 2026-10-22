# Pinned official Desktop lifecycle fixtures

These two TypeScript files and LICENSE are copied **byte for byte**, without
rewriting implementations, from `deepseek-ai/deepseek-harness` commit
`687f282e8625c6b8d11ff58211a90524be2e4317` (dsh 0.2.1-rc.2):

| File | Official path | SHA-256 |
| --- | --- | --- |
| `update-tasks.ts` | `apps/desktop-host/src/update-tasks.ts` | `ace98160f307323fd04055dc990ab1d52faeb848a0a03ec9cf43c475fad9972b` |
| `quit-inspection.ts` | `apps/desktop-host/src/quit-inspection.ts` | `d732d8706a6fe5eb993c4dfd90fdec7203889507b0b13b957cfebebd80cd16e2` |

The component test prefers the original pinned checkout when present, verifies
both files against these hashes, and otherwise imports these identical snapshots.
They are test-only, not a replacement Desktop implementation or a host patch.
No Desktop main entrypoint, Electron runtime, listener, updater, or real process
shutdown is executed by these tests. See the included upstream MIT LICENSE.
