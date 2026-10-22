import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, linkSync, renameSync, readdirSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Writer } from '../src/writer.ts';
import { digest } from '../src/util.ts';
import type { RuntimeIdentity } from '../src/types.ts';
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-writer-'));
    const root = join(dir, 'workspace');
    mkdirSync(root);
    let utc = 1000000;
    let mono = 1000;
    const store = new Store(join(dir, 'private', 'store.sqlite'), { utc: () => utc, monotonic: () => mono });
    store.db.prepare('INSERT INTO workspaces(id,project_id,root) VALUES(?,?,?)').run('w', 'p', root);
    function identity(id: string): RuntimeIdentity {
        const token = 'token-' + id;
        store.db.prepare(`INSERT INTO sessions(id,project_id,workspace_id,incarnation_id,execution_epoch,token_hash,title,task_summary,state,host_id,started_at,last_heartbeat_at,last_heartbeat_mono,owner_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'p', 'w', 'inc-' + id, 1, digest(token), id, '', 'running', 'host', utc, utc, mono, store.epoch);
        return { session_id: id, incarnation_id: 'inc-' + id, execution_epoch: 1, coordinator_epoch: store.epoch, coordinator_domain: store.domain, runtime_token: token };
    }
    const a = identity('a'), b = identity('b'), writer = new Writer(store, { max_read_bytes: 1024 * 1024, lease_ttl_ms: 60000 });
    return { dir, root, store, writer, a, b, advance: (ms: number) => {
            mono += ms;
            utc += ms;
        }, wall: (ms: number) => {
            utc += ms;
        }, close: () => {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        } };
}
function code(expected: string) {
    return (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
}
function claim(f: ReturnType<typeof fixture>, who: RuntimeIdentity, path = 'common.py', request = 'claim-' + who.session_id) {
    return f.writer.claimFiles(who, { paths: [path], purpose: 'test', request_id: request }).claims[0]!;
}
function change(f: ReturnType<typeof fixture>, who: RuntimeIdentity, lease: ReturnType<typeof claim>, read: ReturnType<Writer['readFile']>, content: string, id = 'mutation-' + who.session_id) {
    return f.writer.applyFileChange(who, { path: 'common.py', operation: 'replace', expected_version: read.version, read_token: read.read_token, lease_id: lease.lease_id, coordinator_epoch: lease.coordinator_epoch, fencing_token: lease.fencing_token, mutation_id: id, content });
}
test('F01 F11 claim is exclusive and a conflicted multi-file claim leaves no partial leases', () => {
    const f = fixture();
    try {
        claim(f, f.a);
        assert.throws(() => f.writer.claimFiles(f.b, { paths: ['other.py', 'common.py'], purpose: 'test', request_id: 'both' }), code('FILE_BUSY'));
        assert.equal(claim(f, f.a, 'other.py', 'other').path, 'other.py');
    }
    finally {
        f.close();
    }
});
test('F02 F03 stale write is rejected and strict reread patch preserves both changes', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'A=0\nB=0\n');
        const a = f.writer.readFile(f.a, { path: 'common.py' }), b = f.writer.readFile(f.b, { path: 'common.py' });
        const la = claim(f, f.a);
        change(f, f.a, la, a, 'A=1\nB=0\n');
        f.writer.releaseFiles(f.a, { lease_ids: [la.lease_id], request_id: 'release' });
        const lb = claim(f, f.b);
        assert.throws(() => change(f, f.b, lb, b, 'A=0\nB=1\n'), code('VERSION_CONFLICT'));
        const newer = f.writer.readFile(f.b, { path: 'common.py' });
        f.writer.applyFileChange(f.b, { path: 'common.py', operation: 'patch', expected_version: newer.version, read_token: newer.read_token, lease_id: lb.lease_id, coordinator_epoch: lb.coordinator_epoch, fencing_token: lb.fencing_token, mutation_id: 'patch-b', patch: { start: 4, old_text: 'B=0', new_text: 'B=1' } });
        assert.equal(readFileSync(join(f.root, 'common.py'), 'utf8'), 'A=1\nB=1\n');
    }
    finally {
        f.close();
    }
});
test('F05 L07 committed retry returns original result after lease release and later file changes', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        const first = change(f, f.a, l, r, 'new');
        f.writer.releaseFiles(f.a, { lease_ids: [l.lease_id], request_id: 'release' });
        writeFileSync(join(f.root, 'common.py'), 'later');
        assert.deepEqual(change(f, f.a, l, r, 'new'), first);
        assert.equal(readFileSync(join(f.root, 'common.py'), 'utf8'), 'later');
        assert.throws(() => change(f, f.a, l, r, 'different'), code('IDEMPOTENCY_CONFLICT'));
    }
    finally {
        f.close();
    }
});
test('F04 F20 F21 wall-clock changes cannot extend leases and fencing never resets', () => {
    const f = fixture();
    try {
        const l = claim(f, f.a);
        f.wall(-10000000);
        assert.equal(f.writer.claimFiles(f.a, { paths: ['common.py'], purpose: 'test', request_id: 'claim-a' }).claims[0]!.fencing_token, l.fencing_token);
        f.advance(60001);
        const next = claim(f, f.b);
        assert.ok(next.fencing_token > l.fencing_token);
        assert.throws(() => f.writer.renewClaims(f.a, { lease_ids: [l.lease_id], request_id: 'renew-old' }), code('STALE_FENCING_TOKEN'));
    }
    finally {
        f.close();
    }
});
test('F09 F15 read receipts bind the same raw-byte snapshot and incomplete reads cannot replace', () => {
    const f = fixture();
    try {
        const bytes = Buffer.from('one\r\ntwo\r\n');
        writeFileSync(join(f.root, 'common.py'), bytes);
        const r = f.writer.readFile(f.a, { path: 'common.py', range: { start: 0, end: 3 } });
        assert.equal(r.version, 'sha256:' + digest(bytes));
        assert.equal(r.content, 'one');
        assert.equal(r.truncated, true);
        const l = claim(f, f.a);
        assert.throws(() => change(f, f.a, l, r, 'one'), code('READ_REQUIRED'));
        assert.throws(() => f.writer.applyFileChange(f.b, { path: 'common.py', operation: 'replace', expected_version: r.version, read_token: r.read_token, lease_id: l.lease_id, coordinator_epoch: l.coordinator_epoch, fencing_token: l.fencing_token, mutation_id: 'b-foreign', content: 'x' }), code('STALE_FENCING_TOKEN'));
    }
    finally {
        f.close();
    }
});
test('F07 path traversal, symlinks, hardlinks, directories and Git internals are rejected', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'original'), 'x');
        linkSync(join(f.root, 'original'), join(f.root, 'hard'));
        symlinkSync(f.dir, join(f.root, 'link'));
        mkdirSync(join(f.root, 'directory'));
        for (const path of ['../escape', 'link/escape', 'hard', 'directory', '.git/config'])
            assert.throws(() => f.writer.readFile(f.a, { path }), code('PATH_NOT_ALLOWED'));
        assert.throws(() => f.writer.claimFiles(f.a, { paths: ['../escape'], purpose: 'test', request_id: 'escape' }), code('PATH_NOT_ALLOWED'));
    }
    finally {
        f.close();
    }
});
test('F06 explicit create null precondition and delete are mediated; incomplete rename is rejected', () => {
    const f = fixture();
    try {
        const l = claim(f, f.a);
        assert.throws(() => f.writer.applyFileChange(f.a, { path: 'common.py', operation: 'create', lease_id: l.lease_id, coordinator_epoch: l.coordinator_epoch, fencing_token: l.fencing_token, mutation_id: 'missing', content: 'x' } as never), code('INVALID_ARGUMENT'));
        f.writer.applyFileChange(f.a, { path: 'common.py', operation: 'create', expected_version: null, lease_id: l.lease_id, coordinator_epoch: l.coordinator_epoch, fencing_token: l.fencing_token, mutation_id: 'create', content: 'x' });
        const r = f.writer.readFile(f.a, { path: 'common.py' });
        f.writer.applyFileChange(f.a, { path: 'common.py', operation: 'delete', expected_version: r.version, read_token: r.read_token, lease_id: l.lease_id, coordinator_epoch: l.coordinator_epoch, fencing_token: l.fencing_token, mutation_id: 'delete' });
        assert.throws(() => readFileSync(join(f.root, 'common.py')));
        assert.throws(() => f.writer.applyFileChange(f.a, { operation: 'rename' } as never), code('INVALID_ARGUMENT'));
    }
    finally {
        f.close();
    }
});
test('L08 no-op is committed without replacing the inode or generating file.changed', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'same');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        const result = change(f, f.a, l, r, 'same');
        assert.equal(result.no_op, true);
        const events = f.store.db.prepare("SELECT * FROM events WHERE type='file.changed'").all();
        assert.equal(events.length, 0);
    }
    finally {
        f.close();
    }
});
test('L06 prepared fault aborts without modifying target and original ID cannot be replayed', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        f.writer.fault = (point) => {
            if (point === 'after_prepared')
                throw new Error('injected');
        };
        assert.throws(() => change(f, f.a, l, r, 'new'));
        f.writer.fault = undefined;
        assert.equal(readFileSync(join(f.root, 'common.py'), 'utf8'), 'old');
        assert.throws(() => change(f, f.a, l, r, 'new'), code('OPERATION_ABORTED'));
        assert.equal(f.writer.mutationStatus(f.a, { mutation_id: 'mutation-a' }).state, 'aborted');
    }
    finally {
        f.close();
    }
});
test('F19 L06 failure after publication freezes resource until recovery validates inode evidence', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        f.writer.fault = (point) => {
            if (point === 'after_publish')
                throw new Error('injected');
        };
        assert.throws(() => change(f, f.a, l, r, 'new'), code('OUTCOME_UNKNOWN'));
        assert.throws(() => f.writer.readFile(f.b, { path: 'common.py' }), code('RESOURCE_RECOVERING'));
        f.writer.fault = undefined;
        const status = f.writer.reconcile(f.a, { mutation_id: 'mutation-a' });
        assert.equal(status.state, 'committed');
        assert.equal(readFileSync(join(f.root, 'common.py'), 'utf8'), 'new');
    }
    finally {
        f.close();
    }
});
test('L08 external same hash with another inode is not attributed to a failed mutation', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        f.writer.fault = (point) => {
            if (point === 'after_publish')
                throw new Error('injected');
        };
        assert.throws(() => change(f, f.a, l, r, 'new'));
        f.writer.fault = undefined;
        writeFileSync(join(f.root, 'outside-replacement'), 'new');
        renameSync(join(f.root, 'outside-replacement'), join(f.root, 'common.py'));
        assert.equal(f.writer.reconcile(f.a, { mutation_id: 'mutation-a' }).state, 'needs_recovery');
        assert.throws(() => claim(f, f.b), code('RESOURCE_RECOVERING'));
    }
    finally {
        f.close();
    }
});
test('L07 committed retry does not require the old parent directory still to exist', () => {
    const f = fixture();
    try {
        mkdirSync(join(f.root, 'sub'));
        const path = 'sub/a';
        writeFileSync(join(f.root, path), 'old');
        const r = f.writer.readFile(f.a, { path }), l = claim(f, f.a, path);
        const input = { path, operation: 'replace' as const, expected_version: r.version, read_token: r.read_token, lease_id: l.lease_id, coordinator_epoch: l.coordinator_epoch, fencing_token: l.fencing_token, mutation_id: 'parent-gone', content: 'new' };
        const first = f.writer.applyFileChange(f.a, input);
        renameSync(join(f.root, 'sub'), join(f.dir, 'moved'));
        assert.deepEqual(f.writer.applyFileChange(f.a, input), first);
    }
    finally {
        f.close();
    }
});
test('F16 replacing a parent at publication barrier refuses the write rather than following its alias', () => {
    const f = fixture();
    try {
        mkdirSync(join(f.root, 'sub'));
        mkdirSync(join(f.dir, 'outside'));
        writeFileSync(join(f.root, 'sub/a'), 'old');
        writeFileSync(join(f.dir, 'outside/a'), 'outside');
        const path = 'sub/a', r = f.writer.readFile(f.a, { path }), l = claim(f, f.a, path);
        f.writer.fault = point => {
            if (point === 'before_publish') {
                renameSync(join(f.root, 'sub'), join(f.root, 'old-sub'));
                symlinkSync(join(f.dir, 'outside'), join(f.root, 'sub'));
            }
        };
        assert.throws(() => f.writer.applyFileChange(f.a, { path, operation: 'replace', expected_version: r.version, read_token: r.read_token, lease_id: l.lease_id, coordinator_epoch: l.coordinator_epoch, fencing_token: l.fencing_token, mutation_id: 'parent-swap', content: 'new' }), code('PATH_NOT_ALLOWED'));
        assert.equal(readFileSync(join(f.dir, 'outside/a'), 'utf8'), 'outside');
        assert.equal(readFileSync(join(f.root, 'old-sub/a'), 'utf8'), 'old');
    }
    finally {
        f.close();
    }
});
test('F21 release cannot transfer an in-flight mutation’s resource execution right', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        f.writer.fault = point => {
            if (point === 'before_publish')
                assert.throws(() => f.writer.releaseFiles(f.a, { lease_ids: [l.lease_id], request_id: 'during' }), code('RESOURCE_RECOVERING'));
        };
        change(f, f.a, l, r, 'new');
    }
    finally {
        f.close();
    }
});
test('F23 incremental conflicting claims are nonblocking and neither party receives the second resource', () => {
    const f = fixture();
    try {
        claim(f, f.a, 'x', 'a-x');
        claim(f, f.b, 'y', 'b-y');
        assert.throws(() => claim(f, f.a, 'y', 'a-y'), code('FILE_BUSY'));
        assert.throws(() => claim(f, f.b, 'x', 'b-x'), code('FILE_BUSY'));
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM writer_leases WHERE active=1').get()!.n, 2);
    }
    finally {
        f.close();
    }
});
test('F21 an in-flight write reaches a terminal state even if its TTL expires after its start boundary', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        f.writer.fault = point => {
            if (point === 'before_publish') {
                f.advance(60001);
                assert.throws(() => claim(f, f.b), code('RESOURCE_RECOVERING'));
            }
        };
        change(f, f.a, l, r, 'new');
        f.writer.fault = undefined;
        assert.ok(claim(f, f.b).fencing_token > l.fencing_token);
        assert.equal(readFileSync(join(f.root, 'common.py'), 'utf8'), 'new');
    }
    finally {
        f.close();
    }
});
test('F10 independent resource can progress while another resource is at its internal publication barrier', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        f.writer.fault = point => {
            if (point === 'before_publish')
                assert.equal(claim(f, f.b, 'other', 'independent').path, 'other');
        };
        change(f, f.a, l, r, 'new');
    }
    finally {
        f.close();
    }
});
test('D07 F20 stale runtime cannot renew, release or write its prior lease', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        f.store.db.prepare("UPDATE sessions SET incarnation_id='new-inc',execution_epoch=2 WHERE id='a'").run();
        assert.throws(() => f.writer.renewClaims(f.a, { lease_ids: [l.lease_id], request_id: 'renew' }), code('STALE_INSTANCE'));
        assert.throws(() => f.writer.releaseFiles(f.a, { lease_ids: [l.lease_id], request_id: 'release' }), code('STALE_INSTANCE'));
        assert.throws(() => change(f, f.a, l, r, 'new'), code('STALE_INSTANCE'));
    }
    finally {
        f.close();
    }
});
test('F09 partial read may patch only a strict location within the admitted byte range', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'one\ntwo\n');
        const r = f.writer.readFile(f.a, { path: 'common.py', range: { start: 4, end: 7 } }), l = claim(f, f.a);
        const input = { path: 'common.py', operation: 'patch' as const, expected_version: r.version, read_token: r.read_token, lease_id: l.lease_id, coordinator_epoch: l.coordinator_epoch, fencing_token: l.fencing_token, mutation_id: 'partial', patch: { start: 0, old_text: 'one', new_text: 'ONE' } };
        assert.throws(() => f.writer.applyFileChange(f.a, input), code('PATCH_PRECONDITION_FAILED'));
        f.writer.applyFileChange(f.a, { ...input, patch: { start: 4, old_text: 'two', new_text: 'TWO' } });
        assert.equal(readFileSync(join(f.root, 'common.py'), 'utf8'), 'one\nTWO\n');
    }
    finally {
        f.close();
    }
});
// These are real OS-process recovery tests, not the separate required two-dsh-host acceptance demo.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const worker = fileURLToPath(new URL('./writer-worker.ts', import.meta.url));
for (const operation of ['replace', 'create', 'delete'])
    for (const point of ['after_prepared', 'after_temp_flush', 'after_evidence', 'before_publish', 'after_publish', 'after_directory_flush', 'before_commit', 'after_durable_commit_before_cleanup', 'after_commit']) {
        test(`F12 L05 L06 SIGKILL ${operation} at ${point} recovers once without replaying file action`, () => {
            const directory = mkdtempSync(join(tmpdir(), 'dsh-writer-crash-'));
            let store: Store | undefined;
            try {
                const child = spawnSync(process.execPath, ['--experimental-strip-types', worker, directory, point, 'write', operation], { encoding: 'utf8', timeout: 10000 });
                assert.equal(child.signal, 'SIGKILL', child.stderr);
                store = new Store(join(directory, 'private', 'store.sqlite'));
                const writer = new Writer(store);
                writer.recoverAll();
                writer.recoverAll();
                const terminal = store.db.prepare("SELECT state FROM file_mutations WHERE mutation_id='crash-mutation'").get()!;
                const applied = ['after_publish', 'after_directory_flush', 'before_commit', 'after_durable_commit_before_cleanup', 'after_commit'].includes(point);
                assert.equal(terminal.state, applied ? 'committed' : 'aborted');
                const path = join(directory, 'workspace', 'common.py');
                if ((operation === 'create' && !applied) || (operation === 'delete' && applied))
                    assert.throws(() => readFileSync(path));
                else
                    { assert.equal(readFileSync(path, 'utf8'), applied ? 'new' : 'old'); assert.equal(statSync(path).nlink,1); }
                assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE type IN ('file.changed','file.aborted','file.noop')").get()!.n, 1);
                assert.equal(store.db.prepare("SELECT recovery_state FROM resource_guards WHERE resource_key='common.py'").get()!.recovery_state, 'ready');
            }
            finally {
                store?.close();
                rmSync(directory, { recursive: true, force: true });
            }
        });
    }
test('L05 recovery itself can be killed twice before commit without a duplicate terminal event', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-writer-recovery-crash-'));
    let store: Store | undefined;
    try {
        const first = spawnSync(process.execPath, ['--experimental-strip-types', worker, directory, 'after_publish', 'write', 'replace'], { encoding: 'utf8', timeout: 10000 });
        assert.equal(first.signal, 'SIGKILL', first.stderr);
        for (let i = 0; i < 2; i++) {
            const child = spawnSync(process.execPath, ['--experimental-strip-types', worker, directory, 'before_commit', 'recover'], { encoding: 'utf8', timeout: 10000 });
            assert.equal(child.signal, 'SIGKILL', child.stderr);
        }
        store = new Store(join(directory, 'private', 'store.sqlite'));
        const writer = new Writer(store);
        writer.recoverAll();
        assert.equal(store.db.prepare("SELECT state FROM file_mutations WHERE mutation_id='crash-mutation'").get()!.state, 'committed');
        assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE type='file.changed'").get()!.n, 1);
        assert.equal(readFileSync(join(directory, 'workspace', 'common.py'), 'utf8'), 'new');
    }
    finally {
        store?.close();
        rmSync(directory, { recursive: true, force: true });
    }
});
test('F16 mutation artifact replacement is rejected before publishing unowned bytes', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        mkdirSync(join(f.dir, 'outside'));
        writeFileSync(join(f.dir, 'outside/new'), 'untrusted');
        f.writer.fault = point => {
            if (point === 'before_publish') {
                const artifact = readdirSync(f.root).find(name => name.startsWith('.dsh-collab-'))!;
                renameSync(join(f.root, artifact), join(f.root, 'retained-artifact'));
                symlinkSync(join(f.dir, 'outside'), join(f.root, artifact));
            }
        };
        assert.throws(() => change(f, f.a, l, r, 'new'), code('PATH_NOT_ALLOWED'));
        assert.equal(readFileSync(join(f.root, 'common.py'), 'utf8'), 'old');
        assert.equal(readFileSync(join(f.dir, 'outside/new'), 'utf8'), 'untrusted');
    }
    finally {
        f.close();
    }
});
test('F16 target swapped after preparation is not overwritten at publication barrier', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        f.writer.fault = point => {
            if (point === 'before_publish')
                writeFileSync(join(f.root, 'common.py'), 'external');
        };
        assert.throws(() => change(f, f.a, l, r, 'new'), code('VERSION_CONFLICT'));
        assert.equal(readFileSync(join(f.root, 'common.py'), 'utf8'), 'external');
    }
    finally {
        f.close();
    }
});
test('F19 recovery rejects a symlink-substituted artifact instead of following outside evidence', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        f.writer.fault = point => {
            if (point === 'after_publish')
                throw new Error('injected');
        };
        assert.throws(() => f.writer.applyFileChange(f.a, { path: 'common.py', operation: 'delete', expected_version: r.version, read_token: r.read_token, lease_id: l.lease_id, coordinator_epoch: l.coordinator_epoch, fencing_token: l.fencing_token, mutation_id: 'delete-artifact-swap' }), code('OUTCOME_UNKNOWN'));
        f.writer.fault = undefined;
        const artifact = readdirSync(f.root).find(name => name.startsWith('.dsh-collab-'))!;
        renameSync(join(f.root, artifact), join(f.dir, 'outside-evidence'));
        symlinkSync(join(f.dir, 'outside-evidence'), join(f.root, artifact));
        assert.equal(f.writer.reconcile(f.a, { mutation_id: 'delete-artifact-swap' }).state, 'needs_recovery');
        assert.equal(readFileSync(join(f.dir, 'outside-evidence/removed'), 'utf8'), 'old');
    }
    finally {
        f.close();
    }
});
test('F19 recovery verifies removed raw bytes, not just its old inode', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        f.writer.fault = point => {
            if (point === 'after_publish')
                throw new Error('injected');
        };
        assert.throws(() => f.writer.applyFileChange(f.a, { path: 'common.py', operation: 'delete', expected_version: r.version, read_token: r.read_token, lease_id: l.lease_id, coordinator_epoch: l.coordinator_epoch, fencing_token: l.fencing_token, mutation_id: 'delete-corrupt' }), code('OUTCOME_UNKNOWN'));
        f.writer.fault = undefined;
        const artifact = readdirSync(f.root).find(name => name.startsWith('.dsh-collab-'))!;
        writeFileSync(join(f.root, artifact, 'removed'), 'other');
        assert.equal(f.writer.reconcile(f.a, { mutation_id: 'delete-corrupt' }).state, 'needs_recovery');
    }
    finally {
        f.close();
    }
});
test('F21 lifecycle release also respects the in-flight resource barrier', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        f.writer.fault = point => {
            if (point === 'before_publish')
                assert.throws(() => f.writer.releaseSession(f.a), code('RESOURCE_RECOVERING'));
        };
        change(f, f.a, l, r, 'new');
        f.writer.fault = undefined;
        f.writer.releaseSession(f.a);
        assert.equal(f.store.db.prepare('SELECT active FROM writer_leases WHERE lease_id=?').get(l.lease_id)!.active, 0);
    }
    finally {
        f.close();
    }
});
test('F19 corrupt persisted evidence freezes rather than reporting a fabricated no-op', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        f.writer.fault = point => {
            if (point === 'after_prepared')
                throw new Error('injected');
        };
        assert.throws(() => change(f, f.a, l, r, 'new'));
        f.writer.fault = undefined;
        const row = f.store.db.prepare("SELECT evidence FROM file_mutations WHERE mutation_id='mutation-a'").get()!, evidence = JSON.parse(String(row.evidence));
        evidence.no_op = true;
        f.store.db.prepare("UPDATE file_mutations SET state='prepared',evidence=? WHERE mutation_id='mutation-a'").run(JSON.stringify(evidence));
        assert.equal(f.writer.reconcile(f.a, { mutation_id: 'mutation-a' }).state, 'needs_recovery');
        assert.equal(readFileSync(join(f.root, 'common.py'), 'utf8'), 'old');
    }
    finally {
        f.close();
    }
});
test('F15 UTF-8 BOM, CRLF and complete original raw bytes survive a no-op', () => {
    const f = fixture();
    try {
        const original = Buffer.from('\uFEFFone\r\n');
        writeFileSync(join(f.root, 'common.py'), original);
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        assert.equal(r.content, '\uFEFFone\r\n');
        assert.equal(change(f, f.a, l, r, r.content).no_op, true);
        assert.deepEqual(readFileSync(join(f.root, 'common.py')), original);
    }
    finally {
        f.close();
    }
});
test('F09 existing line-offset read API derives bounded receipt from its one raw snapshot', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'α\r\nβ😀\r\nlast\n');
        const r = f.writer.readFile(f.a, { path: 'common.py', line_range: { offset: 2, limit: 1 }, max_bytes: 16384 }), l = claim(f, f.a);
        assert.equal(r.content, 'β😀\r\n');
        assert.equal(r.total_lines, 3);
        assert.deepEqual(r.byte_range, { start: 4, end: 12 });
        assert.equal(r.offset, 2);
        assert.equal(r.truncated, true);
        assert.throws(() => change(f, f.a, l, r, r.content), code('READ_REQUIRED'));
        f.writer.applyFileChange(f.a, { path: 'common.py', operation: 'patch', expected_version: r.version, read_token: r.read_token, lease_id: l.lease_id, coordinator_epoch: l.coordinator_epoch, fencing_token: l.fencing_token, mutation_id: 'line-patch', patch: { start: 4, old_text: 'β😀', new_text: 'B' } });
        assert.equal(readFileSync(join(f.root, 'common.py'), 'utf8'), 'α\r\nB\r\nlast\n');
    }
    finally {
        f.close();
    }
});
test('F09 byte display cap never splits Unicode and cannot mint a complete-file receipt', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'a😀z');
        const r = f.writer.readFile(f.a, { path: 'common.py', line_range: { offset: 1, limit: 200 }, max_bytes: 4 }), l = claim(f, f.a);
        assert.equal(r.content, 'a');
        assert.deepEqual(r.byte_range, { start: 0, end: 1 });
        assert.equal(r.truncated, true);
        assert.throws(() => change(f, f.a, l, r, 'a'), code('READ_REQUIRED'));
        assert.throws(() => f.writer.readFile(f.a, { path: 'common.py', range: { start: 0, end: 1 }, line_range: { offset: 1, limit: 1 } }), code('INVALID_ARGUMENT'));
    }
    finally {
        f.close();
    }
});
test('F09 whole and empty line windows keep exact complete-read semantics', () => {
    const f = fixture();
    try {
        writeFileSync(join(f.root, 'common.py'), 'one\n');
        const r = f.writer.readFile(f.a, { path: 'common.py', line_range: { offset: 1, limit: 200 }, max_bytes: 16384 });
        assert.equal(r.truncated, false);
        assert.equal(r.total_lines, 1);
        assert.throws(() => f.writer.readFile(f.a, { path: 'common.py', line_range: { offset: 2, limit: 1 } }), code('INVALID_ARGUMENT'));
        writeFileSync(join(f.root, 'common.py'), '');
        const e = f.writer.readFile(f.a, { path: 'common.py', line_range: { offset: 1, limit: 1 } });
        assert.equal(e.content, '');
        assert.equal(e.total_lines, 0);
        assert.equal(e.truncated, false);
    }
    finally {
        f.close();
    }
});
test('F15 replacement preserves admitted POSIX rwx permissions despite a restrictive umask', () => {
    const f = fixture(), previous = process.umask(0o077);
    try {
        writeFileSync(join(f.root, 'common.py'), 'old');
        chmodSync(join(f.root, 'common.py'), 0o754);
        const r = f.writer.readFile(f.a, { path: 'common.py' }), l = claim(f, f.a);
        change(f, f.a, l, r, 'new');
        assert.equal(statSync(join(f.root, 'common.py')).mode & 0o777, 0o754);
    }
    finally {
        process.umask(previous);
        f.close();
    }
});
test('D07 a superseded incarnation’s lease becomes inactive without waiting for its old TTL',()=>{
 const f=fixture();try{writeFileSync(join(f.root,'common.py'),'old');const original=claim(f,f.a);f.store.db.prepare("UPDATE sessions SET incarnation_id='replacement',execution_epoch=2 WHERE id='a'").run();const next={...f.a,incarnation_id:'replacement',execution_epoch:2};const cached=f.writer.claimFiles(next,{paths:['common.py'],purpose:'test',request_id:'claim-a'}).claims[0]!;assert.equal(cached.active,false);assert.equal(f.writer.readFile(f.b,{path:'common.py'}).file_activity.owner_session_id,null);const replacement=claim(f,next,'common.py','new-instance-claim');assert.ok(replacement.fencing_token>original.fencing_token);assert.notEqual(replacement.lease_id,original.lease_id)}finally{f.close()}
})
test('F21 stopped work cannot begin a new claim or mutation but may query its original result',()=>{
 const f=fixture();try{writeFileSync(join(f.root,'common.py'),'old');const r=f.writer.readFile(f.a,{path:'common.py'}),l=claim(f,f.a);const committed=change(f,f.a,l,r,'new');f.store.db.prepare("UPDATE sessions SET state='completed' WHERE id='a'").run();assert.deepEqual(change(f,f.a,l,r,'new'),committed);assert.throws(()=>claim(f,f.a,'another','stopped'),code('LEASE_EXPIRED'));const latest=f.writer.readFile(f.a,{path:'common.py'});assert.throws(()=>change(f,f.a,l,latest,'forbidden','new-after-stop'),code('LEASE_EXPIRED'))}finally{f.close()}
})

for(const operation of ['create','replace'] as const)for(const substitution of ['file','symlink','inplace','hardlink'] as const){
 test(`F16 reviewed regression refuses ${operation} with ${substitution} substituted staged leaf`,()=>{
  const f=fixture();try{if(operation==='replace')writeFileSync(join(f.root,'common.py'),'old');const r=operation==='replace'?f.writer.readFile(f.a,{path:'common.py'}):null,l=claim(f,f.a);writeFileSync(join(f.dir,'foreign'),'foreign');f.writer.fault=point=>{if(point==='before_publish'){const dir=readdirSync(f.root).find(name=>name.startsWith('.dsh-collab-'))!,staged=join(f.root,dir,'new');if(substitution==='inplace')writeFileSync(staged,'foreign');else if(substitution==='hardlink')linkSync(staged,join(f.dir,'extra-link'));else{unlinkSync(staged);if(substitution==='file')writeFileSync(staged,'foreign');else symlinkSync(join(f.dir,'foreign'),staged)}}};assert.throws(()=>f.writer.applyFileChange(f.a,{path:'common.py',operation,expected_version:r?.version??null,read_token:r?.read_token,lease_id:l.lease_id,coordinator_epoch:l.coordinator_epoch,fencing_token:l.fencing_token,mutation_id:'staged-swap',content:'intended'}));assert.equal(f.writer.mutationStatus(f.a,{mutation_id:'staged-swap'}).state,'aborted');if(operation==='create')assert.throws(()=>readFileSync(join(f.root,'common.py')));else assert.equal(readFileSync(join(f.root,'common.py'),'utf8'),'old');assert.equal(readFileSync(join(f.dir,'foreign'),'utf8'),'foreign')}finally{f.close()}
 })
}
