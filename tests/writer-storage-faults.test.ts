/**
 * Deterministic simulated syscall errors, not real disk-full or power-loss tests.
 * The replacements are process-local, restored synchronously, and select only
 * descriptors inside each test's disposable workspace. No stress/remounting.
 *
 * These assertions would fail if the writer published before completing staging,
 * reported a durable success before publication flushes, cleared an unresolved
 * resource guard, replayed an aborted request, or deleted unattributed evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { Writer } from '../src/writer.ts';
import type { FileChange } from '../src/writer.ts';
import type { RuntimeIdentity } from '../src/types.ts';
import { digest } from '../src/util.ts';

const originalWrite = fs.writeSync;
const originalFlush = fs.fsyncSync;
type Operation = 'create' | 'replace' | 'delete';
type FlushLocation = 'staged-file' | 'artifact-directory' | 'parent-directory';
function errorCode(expected: string) {
  return (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
}
function syscallError(code: 'ENOSPC' | 'EIO' | 'EROFS', syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}: ${syscall}`), { code, syscall });
}
function fixture(operation: Operation) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'dsh-storage-fault-'));
  const root = join(dir, 'workspace');
  const database = join(dir, 'private', 'store.sqlite');
  fs.mkdirSync(root);
  if (operation !== 'create') fs.writeFileSync(join(root, 'target.txt'), 'original bytes\r\n');
  fs.writeFileSync(join(root, 'independent.txt'), 'independent original');
  let store = new Store(database, { utc: () => 1000000, monotonic: () => 1000 });
  store.db.prepare('INSERT INTO workspaces(id,project_id,root) VALUES(?,?,?)').run('w', 'p', root);
  const identity: RuntimeIdentity = {
    session_id: 'a', incarnation_id: 'inc-a', execution_epoch: 1,
    coordinator_epoch: store.epoch, coordinator_domain: store.domain, runtime_token: 'token-a',
  };
  store.db.prepare(`INSERT INTO sessions(id,project_id,workspace_id,incarnation_id,execution_epoch,token_hash,title,task_summary,state,host_id,started_at,last_heartbeat_at,last_heartbeat_mono,owner_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('a', 'p', 'w', 'inc-a', 1, digest(identity.runtime_token), 'a', '', 'running', 'host', 1000000, 1000000, 1000, store.epoch);
  let writer = new Writer(store);
  const receipt = operation === 'create' ? null : writer.readFile(identity, { path: 'target.txt' });
  const lease = writer.claimFiles(identity, { paths: ['target.txt'], purpose: 'storage failure fixture', request_id: 'initial-claim' }).claims[0]!;
  const change: FileChange = {
    path: 'target.txt', operation, expected_version: receipt?.version ?? null,
    read_token: receipt?.read_token, lease_id: lease.lease_id,
    coordinator_epoch: lease.coordinator_epoch, fencing_token: lease.fencing_token,
    mutation_id: 'original-mutation', ...(operation === 'delete' ? {} : { content: 'intended replacement bytes\r\n' }),
  };
  return {
    dir, root, identity, change, lease,
    get store() { return store; }, get writer() { return writer; },
    restart() {
      store.close();
      store = new Store(database, { utc: () => 1000000, monotonic: () => 1000 });
      writer = new Writer(store);
      writer.recoverAll();
      // Controlled host reconnect for this fixture, after startup recovery.
      store.db.prepare('UPDATE sessions SET owner_epoch=? WHERE id=?').run(store.epoch, identity.session_id);
      identity.coordinator_epoch = store.epoch;
    },
    close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
type Fixture = ReturnType<typeof fixture>;
function descriptorLocation(f: Fixture, fd: number): FlushLocation | undefined {
  const path = fs.readlinkSync(`/proc/self/fd/${fd}`);
  if (path === f.root) return 'parent-directory';
  const prefix = f.root + '/.dsh-collab-';
  if (!path.startsWith(prefix)) return undefined;
  if (path.endsWith('/new')) return 'staged-file';
  if (fs.fstatSync(fd).isDirectory()) return 'artifact-directory';
  return undefined;
}
function withSyscalls<T>(hooks: {
  write?: (fd: number, bytes: Buffer, offset: number, length: number) => number;
  flush?: (fd: number) => void;
}, run: () => T): T {
  assert.equal(fs.writeSync, originalWrite, 'no nested or leaked syscall injection');
  assert.equal(fs.fsyncSync, originalFlush, 'no nested or leaked syscall injection');
  if (hooks.write) fs.writeSync = hooks.write as typeof fs.writeSync;
  if (hooks.flush) fs.fsyncSync = hooks.flush;
  syncBuiltinESMExports();
  try { return run(); }
  finally {
    fs.writeSync = originalWrite;
    fs.fsyncSync = originalFlush;
    syncBuiltinESMExports();
  }
}
function mutationEvents(f: Fixture, type: string): number {
  return Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE type=? AND json_extract(payload,\'$.mutation_id\')=?').get(type, f.change.mutation_id)!.n);
}
function targetBefore(f: Fixture): void {
  if (f.change.operation === 'create') assert.equal(fs.existsSync(join(f.root, 'target.txt')), false);
  else assert.equal(fs.readFileSync(join(f.root, 'target.txt'), 'utf8'), 'original bytes\r\n');
}
function targetAfter(f: Fixture): void {
  if (f.change.operation === 'delete') assert.equal(fs.existsSync(join(f.root, 'target.txt')), false);
  else assert.equal(fs.readFileSync(join(f.root, 'target.txt'), 'utf8'), f.change.content);
}
function unchangedIndependent(f: Fixture): void {
  assert.equal(fs.readFileSync(join(f.root, 'independent.txt'), 'utf8'), 'independent original');
}
function canWorkIndependently(f: Fixture): void {
  unchangedIndependent(f);
  const receipt = f.writer.readFile(f.identity, { path: 'independent.txt' });
  const lease = f.writer.claimFiles(f.identity, { paths: ['independent.txt'], purpose: 'independent work', request_id: 'independent-claim' }).claims[0]!;
  const result = f.writer.applyFileChange(f.identity, {
    path: 'independent.txt', operation: 'replace', expected_version: receipt.version,
    read_token: receipt.read_token, lease_id: lease.lease_id, coordinator_epoch: lease.coordinator_epoch,
    fencing_token: lease.fencing_token, mutation_id: 'independent-change', content: 'independent updated',
  });
  assert.equal(result.new_version, 'sha256:' + digest('independent updated'));
  assert.equal(fs.readFileSync(join(f.root, 'independent.txt'), 'utf8'), 'independent updated');
}
function assertAborted(f: Fixture): void {
  targetBefore(f);
  unchangedIndependent(f);
  const status = f.writer.mutationStatus(f.identity, { mutation_id: f.change.mutation_id });
  assert.equal(status.state, 'aborted');
  assert.equal(status.original_result, null);
  assert.equal(mutationEvents(f, 'file.changed'), 0);
  assert.equal(mutationEvents(f, 'file.aborted'), 1);
  assert.throws(() => f.writer.applyFileChange(f.identity, f.change), errorCode('OPERATION_ABORTED'));
  assert.equal(f.store.db.prepare('SELECT recovery_state FROM resource_guards WHERE resource_key=?').get('target.txt')!.recovery_state, 'ready');
}
function assertFrozen(f: Fixture): void {
  assert.equal(f.writer.mutationStatus(f.identity, { mutation_id: f.change.mutation_id }).state, 'needs_recovery');
  assert.equal(mutationEvents(f, 'file.changed'), 0);
  assert.equal(mutationEvents(f, 'file.aborted'), 0);
  assert.throws(() => f.writer.applyFileChange(f.identity, f.change), errorCode('OUTCOME_UNKNOWN'));
  assert.throws(() => f.writer.applyFileChange(f.identity, { ...f.change, mutation_id: 'forbidden-new-id' }), errorCode('RESOURCE_RECOVERING'));
  assert.throws(() => f.writer.readFile(f.identity, { path: 'target.txt' }), errorCode('RESOURCE_RECOVERING'));
  assert.throws(() => f.writer.claimFiles(f.identity, { paths: ['target.txt'], purpose: 'cannot bypass freeze', request_id: 'new-claim' }), errorCode('RESOURCE_RECOVERING'));
  assert.throws(() => f.writer.renewClaims(f.identity, { lease_ids: [f.lease.lease_id], request_id: 'cannot-renew-frozen' }), errorCode('RESOURCE_RECOVERING'));
}
function assertRecovered(f: Fixture): void {
  targetAfter(f);
  const status = f.writer.mutationStatus(f.identity, { mutation_id: f.change.mutation_id });
  assert.equal(status.state, 'committed');
  assert.equal(status.original_result?.new_version, f.change.operation === 'delete' ? null : 'sha256:' + digest(f.change.content!));
  assert.deepEqual(f.writer.applyFileChange(f.identity, f.change), status.original_result);
  assert.equal(mutationEvents(f, 'file.changed'), 1);
  assert.equal(mutationEvents(f, 'file.aborted'), 0);
  const event = f.store.db.prepare('SELECT id FROM events WHERE type=? AND json_extract(payload,\'$.mutation_id\')=?').get('file.changed', f.change.mutation_id)!;
  assert.equal(typeof event.id, 'string');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE event_id=?').get(String(event.id))!.n, 1);
  assert.equal(f.store.db.prepare('SELECT recovery_state FROM resource_guards WHERE resource_key=?').get('target.txt')!.recovery_state, 'ready');
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith('.dsh-collab-')), []);
  if (f.change.operation !== 'delete') {
    assert.equal(fs.statSync(join(f.root, 'target.txt')).nlink, 1);
    assert.equal(f.writer.readFile(f.identity, { path: 'target.txt' }).content, f.change.content);
  }
}

for (const operation of ['create', 'replace'] as const) {
  test(`simulated short writeSync returns complete ${operation} only after every intended byte`, () => {
    const f = fixture(operation);
    let writes = 0;
    try {
      const result = withSyscalls({ write(fd, bytes, offset, length) {
        if (descriptorLocation(f, fd) !== 'staged-file') return originalWrite(fd, bytes, offset, length);
        writes++;
        return originalWrite(fd, bytes, offset, Math.min(3, length));
      } }, () => f.writer.applyFileChange(f.identity, f.change));
      assert.ok(writes > 1);
      assert.equal(result.new_version, 'sha256:' + digest(f.change.content!));
      assertRecovered(f);
      unchangedIndependent(f);
    } finally { f.close(); }
  });

  test(`simulated partial staged write then ENOSPC aborts ${operation} without publishing or replaying`, () => {
    const f = fixture(operation);
    let writes = 0;
    try {
      withSyscalls({ write(fd, bytes, offset, length) {
        if (descriptorLocation(f, fd) !== 'staged-file') return originalWrite(fd, bytes, offset, length);
        writes++;
        if (writes === 1) return originalWrite(fd, bytes, offset, Math.min(4, length));
        throw syscallError('ENOSPC', 'write');
      } }, () => assert.throws(() => f.writer.applyFileChange(f.identity, f.change), errorCode('STORAGE_ERROR')));
      assert.equal(writes, 2);
      assertAborted(f);
      const raw = f.store.db.prepare('SELECT evidence FROM file_mutations WHERE mutation_id=?').get(f.change.mutation_id)!;
      const evidence = JSON.parse(String(raw.evidence));
      const artifact = join(f.root, evidence.artifact, 'new');
      assert.equal(evidence.staged, null, 'no completed staged inode evidence was persisted');
      assert.equal(fs.readFileSync(artifact, 'utf8'), f.change.content!.slice(0, 4));
      f.restart();
      f.writer.recoverAll();
      assertAborted(f);
      assert.equal(fs.readFileSync(artifact, 'utf8'), f.change.content!.slice(0, 4), 'recovery must retain unattributed partial staging');
      canWorkIndependently(f);
    } finally { f.close(); }
  });
}

for (const operation of ['create', 'replace', 'delete'] as const) {
  for (const code of ['EIO', 'EROFS'] as const) {
    const locations: FlushLocation[] = operation === 'delete' ? ['artifact-directory', 'parent-directory'] : ['staged-file', 'artifact-directory', 'parent-directory'];
    for (const location of locations) {
      test(`simulated ${code} on prepublication ${location} fsync aborts ${operation}`, () => {
        const f = fixture(operation);
        let selectedCalls = 0;
        try {
          withSyscalls({ flush(fd) {
            if (descriptorLocation(f, fd) === location && ++selectedCalls === 1) throw syscallError(code, 'fsync');
            originalFlush(fd);
          } }, () => assert.throws(() => f.writer.applyFileChange(f.identity, f.change), errorCode('STORAGE_ERROR')));
          assert.ok(selectedCalls >= 1, 'the real selected fsync call was exercised');
          assertAborted(f);
          f.restart();
          f.writer.recoverAll();
          assertAborted(f);
          canWorkIndependently(f);
        } finally { f.close(); }
      });
    }
    for (const location of ['artifact-directory', 'parent-directory'] as const) {
      test(`simulated persistent ${code} on postpublication ${location} fsync freezes ${operation} until recovery`, () => {
        const f = fixture(operation);
        let selectedCalls = 0;
        try {
          withSyscalls({ flush(fd) {
            if (descriptorLocation(f, fd) === location && ++selectedCalls >= 2) throw syscallError(code, 'fsync');
            originalFlush(fd);
          } }, () => {
            assert.throws(() => f.writer.applyFileChange(f.identity, f.change), errorCode('OUTCOME_UNKNOWN'));
            assert.equal(selectedCalls, 2, 'first flush succeeded; the postpublication flush failed');
            targetAfter(f);
            unchangedIndependent(f);
            assertFrozen(f);
            assert.equal(f.writer.reconcile(f.identity, { mutation_id: f.change.mutation_id }).state, 'needs_recovery');
            assert.ok(selectedCalls >= 3, 'recovery also encountered the persistent syscall failure');
            assertFrozen(f);
          });
          canWorkIndependently(f);
          assertFrozen(f);
          f.restart();
          f.writer.recoverAll();
          assertRecovered(f);
          assert.equal(fs.readFileSync(join(f.root, 'independent.txt'), 'utf8'), 'independent updated');
        } finally { f.close(); }
      });
    }
  }
}

for (const operation of ['create', 'delete'] as const) {
  test(`simulated cleanup-directory EIO after durable ${operation} commit retains terminal result and permits later cleanup`, () => {
    const f = fixture(operation);
    let artifactFlushes = 0;
    try {
      const result = withSyscalls({ flush(fd) {
        if (descriptorLocation(f, fd) === 'artifact-directory' && ++artifactFlushes === 3) throw syscallError('EIO', 'fsync');
        originalFlush(fd);
      } }, () => f.writer.applyFileChange(f.identity, f.change));
      assert.equal(artifactFlushes, 3);
      assert.equal(f.writer.mutationStatus(f.identity, { mutation_id: f.change.mutation_id }).state, 'committed');
      assert.deepEqual(f.writer.applyFileChange(f.identity, f.change), result);
      targetAfter(f);
      unchangedIndependent(f);
      const artifacts = fs.readdirSync(f.root).filter(name => name.startsWith('.dsh-collab-'));
      assert.equal(artifacts.length, 1, 'only cleanup, not publication durability, remains incomplete');
      assert.deepEqual(fs.readdirSync(join(f.root, artifacts[0]!)), []);
      f.restart();
      f.writer.recoverAll();
      assertRecovered(f);
    } finally { f.close(); }
  });
}

/** Same-filesystem rename keeps the existing inode; no staging-file substitution. */
function renameFixture() {
  const f = fixture('replace');
  fs.mkdirSync(join(f.root, 'destination'));
  const targetPath = 'destination/moved.txt';
  const targetLease = f.writer.claimFiles(f.identity, { paths: [targetPath], purpose: 'rename destination', request_id: 'rename-target-claim' }).claims[0]!;
  delete f.change.content;
  Object.assign(f.change, {
    operation: 'rename', target_path: targetPath, expected_target_version: null,
    target_lease_id: targetLease.lease_id, target_fencing_token: targetLease.fencing_token,
  });
  return { f, targetPath, targetLease, sourceInode: fs.statSync(join(f.root, f.change.path)).ino };
}
function assertRenameMoved(f: Fixture, targetPath: string, sourceInode: number): void {
  assert.equal(fs.existsSync(join(f.root, f.change.path)), false);
  assert.equal(fs.readFileSync(join(f.root, targetPath), 'utf8'), 'original bytes\r\n');
  const destination = fs.statSync(join(f.root, targetPath));
  assert.equal(destination.ino, sourceInode);
  assert.equal(destination.nlink, 1);
}
function assertRenameFrozen(f: Fixture, targetPath: string, targetLease: Fixture['lease']): void {
  assertFrozen(f);
  assert.deepEqual(f.writer.mutationStatus(f.identity, { mutation_id: f.change.mutation_id }).affected_paths, [f.change.path, targetPath]);
  for (const path of [f.change.path, targetPath]) {
    assert.equal(f.store.db.prepare('SELECT recovery_state FROM resource_guards WHERE resource_key=?').get(path)!.recovery_state, 'needs_recovery');
    assert.throws(() => f.writer.readFile(f.identity, { path }), errorCode('RESOURCE_RECOVERING'));
    assert.throws(() => f.writer.claimFiles(f.identity, { paths: [path], purpose: 'cannot bypass rename freeze', request_id: 'blocked-rename-' + path }), errorCode('RESOURCE_RECOVERING'));
  }
  assert.throws(() => f.writer.renewClaims(f.identity, { lease_ids: [targetLease.lease_id], request_id: 'cannot-renew-frozen-destination' }), errorCode('RESOURCE_RECOVERING'));
  assert.throws(() => f.writer.applyFileChange(f.identity, {
    path: targetPath, operation: 'create', expected_version: null, content: 'must not publish',
    lease_id: targetLease.lease_id, coordinator_epoch: targetLease.coordinator_epoch,
    fencing_token: targetLease.fencing_token, mutation_id: 'forbidden-destination-write',
  }), errorCode('RESOURCE_RECOVERING'));
}
function assertRenameCommitted(f: Fixture, targetPath: string, sourceInode: number): void {
  assertRenameMoved(f, targetPath, sourceInode);
  const status = f.writer.mutationStatus(f.identity, { mutation_id: f.change.mutation_id });
  assert.equal(status.state, 'committed');
  const event = f.store.db.prepare('SELECT id,sequence,payload FROM events WHERE type=? AND json_extract(payload,\'$.mutation_id\')=?').get('file.changed', f.change.mutation_id)!;
  const expected = {
    mutation_id: f.change.mutation_id, previous_version: f.change.expected_version,
    new_version: null, event_cursor: String(event.sequence), no_op: false,
    destination_path: targetPath, destination_version: f.change.expected_version,
  };
  assert.deepEqual(status.original_result, expected);
  assert.deepEqual(f.writer.applyFileChange(f.identity, f.change), expected);
  assert.equal(mutationEvents(f, 'file.changed'), 1);
  assert.equal(mutationEvents(f, 'file.aborted'), 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE event_id=?').get(String(event.id))!.n, 1);
  assert.deepEqual(JSON.parse(String(event.payload)), {
    mutation_id: f.change.mutation_id, path: f.change.path, operation: 'rename',
    previous_version: f.change.expected_version, new_version: null, no_op: false,
    destination_path: targetPath, destination_version: f.change.expected_version,
  });
  for (const path of [f.change.path, targetPath]) {
    assert.equal(f.store.db.prepare('SELECT recovery_state FROM resource_guards WHERE resource_key=?').get(path)!.recovery_state, 'ready');
  }
  assert.equal(f.writer.readFile(f.identity, { path: targetPath }).version, f.change.expected_version);
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith('.dsh-collab-')), []);
}

for (const code of ['EIO', 'EROFS'] as const) {
  test(`simulated ${code} on rename source-file fsync fails before intent and preserves both names`, () => {
    const { f, targetPath, sourceInode } = renameFixture();
    let sourceFlushes = 0;
    try {
      withSyscalls({ flush(fd) {
        if (fs.readlinkSync(`/proc/self/fd/${fd}`) === join(f.root, f.change.path)) {
          sourceFlushes++;
          throw syscallError(code, 'fsync');
        }
        originalFlush(fd);
      } }, () => {
        // The transport normalizes raw pre-intent I/O errors to STORAGE_ERROR;
        // either form is an error, never a successful or ambiguous file action.
        assert.throws(() => f.writer.applyFileChange(f.identity, f.change), error =>
          errorCode(code)(error) || errorCode('STORAGE_ERROR')(error));
      });
      assert.equal(sourceFlushes, 1);
      assert.equal(f.writer.mutationStatus(f.identity, { mutation_id: f.change.mutation_id }).state, 'not_found');
      assert.equal(fs.readFileSync(join(f.root, f.change.path), 'utf8'), 'original bytes\r\n');
      assert.equal(fs.statSync(join(f.root, f.change.path)).ino, sourceInode);
      assert.equal(fs.existsSync(join(f.root, targetPath)), false);
      assert.equal(mutationEvents(f, 'file.changed'), 0);
      assert.equal(mutationEvents(f, 'file.aborted'), 0);
      for (const path of [f.change.path, targetPath]) {
        assert.equal(f.store.db.prepare('SELECT recovery_state FROM resource_guards WHERE resource_key=?').get(path)!.recovery_state, 'ready');
      }
      canWorkIndependently(f);
      f.writer.applyFileChange(f.identity, f.change);
      f.writer.recoverAll();
      assertRenameCommitted(f, targetPath, sourceInode);
      assert.equal(fs.readFileSync(join(f.root, 'independent.txt'), 'utf8'), 'independent updated');
    } finally { f.close(); }
  });

  for (const location of ['source-directory', 'destination-directory'] as const) {
    test(`simulated persistent ${code} on rename postpublication ${location} fsync freezes both names until recovery`, () => {
      const { f, targetPath, targetLease, sourceInode } = renameFixture();
      const selectedDirectory = location === 'source-directory' ? f.root : join(f.root, 'destination');
      let selectedFlushes = 0;
      try {
        withSyscalls({ flush(fd) {
          if (fs.readlinkSync(`/proc/self/fd/${fd}`) === selectedDirectory) {
            selectedFlushes++;
            throw syscallError(code, 'fsync');
          }
          originalFlush(fd);
        } }, () => {
          assert.throws(() => f.writer.applyFileChange(f.identity, f.change), errorCode('OUTCOME_UNKNOWN'));
          assert.equal(selectedFlushes, 1, 'the first selected directory flush is after the atomic move');
          assertRenameMoved(f, targetPath, sourceInode);
          unchangedIndependent(f);
          assertRenameFrozen(f, targetPath, targetLease);
          assert.equal(f.writer.reconcile(f.identity, { mutation_id: f.change.mutation_id }).state, 'needs_recovery');
          assert.equal(selectedFlushes, 2, 'recovery cannot clear either guard while its flush still fails');
          assertRenameFrozen(f, targetPath, targetLease);
        });
        canWorkIndependently(f);
        assertRenameFrozen(f, targetPath, targetLease);
        f.restart();
        f.writer.recoverAll();
        assertRenameCommitted(f, targetPath, sourceInode);
        assert.equal(fs.readFileSync(join(f.root, 'independent.txt'), 'utf8'), 'independent updated');
      } finally { f.close(); }
    });
  }
}
