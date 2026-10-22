/** Fault-injection subprocess; never used by the installed plugin or daemon. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Writer } from '../src/writer.ts';
import type { FaultPoint, FileChange } from '../src/writer.ts';
import { digest } from '../src/util.ts';
import type { RuntimeIdentity } from '../src/types.ts';
const [directory, point, mode = 'write', operation = 'replace'] = process.argv.slice(2);
if (!directory || !point)
    throw new Error('directory and fault point required');
const root = join(directory, 'workspace');
mkdirSync(root, { recursive: true });
const store = new Store(join(directory, 'private', 'store.sqlite')), writer = new Writer(store);
writer.fault = (boundary) => {
    if (boundary === point as FaultPoint)
        process.kill(process.pid, 'SIGKILL');
};
if (mode === 'recover') {
    writer.recoverAll();
    store.close();
    process.exit(0);
}
store.db.prepare('INSERT INTO workspaces(id,project_id,root) VALUES(?,?,?)').run('w', 'p', root);
const token = 'test-runtime-token', now = Date.now();
store.db.prepare(`INSERT INTO sessions(id,project_id,workspace_id,incarnation_id,execution_epoch,token_hash,title,task_summary,state,host_id,started_at,last_heartbeat_at,last_heartbeat_mono,owner_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('a', 'p', 'w', 'inc-a', 1, digest(token), 'A', '', 'running', 'host', now, now, performance.now(), store.epoch);
const identity: RuntimeIdentity = { session_id: 'a', incarnation_id: 'inc-a', execution_epoch: 1, coordinator_epoch: store.epoch, coordinator_domain: store.domain, runtime_token: token };
if (operation !== 'create')
    writeFileSync(join(root, 'common.py'), 'old');
const read = operation === 'create' ? null : writer.readFile(identity, { path: 'common.py' });
const lease = writer.claimFiles(identity, { paths: ['common.py'], purpose: 'fault test', request_id: 'claim' }).claims[0]!;
const request: FileChange = { path: 'common.py', operation: operation as FileChange['operation'], expected_version: read?.version ?? null, ...read ? { read_token: read.read_token } : {}, lease_id: lease.lease_id, coordinator_epoch: lease.coordinator_epoch, fencing_token: lease.fencing_token, mutation_id: 'crash-mutation', ...operation === 'delete' ? {} : { content: 'new' } };
writer.applyFileChange(identity, request);
throw new Error('Fault point did not terminate the writer');
