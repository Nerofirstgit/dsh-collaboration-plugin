import test from 'node:test'
import assert from 'node:assert/strict'
import { splitDeliveryBody, conservativeTokenCost } from '../src/messaging.ts'

test('M14 stable fragments preserve every Unicode scalar and do not exceed their UTF-8 byte limit', () => {
  const body = '中🙂e\u0301𐐷'.repeat(71)
  const parts = splitDeliveryBody(body, 31)
  assert.ok(parts.length > 1)
  assert.equal(parts.join(''), body)
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part, 'utf8') <= 31)
    assert.equal(Buffer.from(part, 'utf8').toString('utf8'), part)
  }
  assert.deepEqual(splitDeliveryBody(body, 31), parts)
})

test('M14 conservative token charge counts UTF-8 bytes and per-message framing, not character count', () => {
  assert.ok(conservativeTokenCost('🙂'.repeat(10)) >= 40)
  assert.ok(conservativeTokenCost('a') > 1)
})

test('M14 unpaired surrogate input and impossible fragment budgets are rejected, not silently replaced', () => {
  assert.throws(() => splitDeliveryBody('\ud800', 16))
  assert.throws(() => splitDeliveryBody('🙂', 3))
})

import { Store } from '../src/store.ts'
import { digest } from '../src/util.ts'
import { success } from '../src/errors.ts'
import type { RuntimeIdentity } from '../src/types.ts'
import { Messaging } from '../src/messaging.ts'

function fixture(options: Record<string, number> = {}, database = ':memory:') {
  let now = 100_000
  const store = new Store(database, { utc: () => now, monotonic: () => now })
  store.db.prepare('INSERT INTO workspaces(id,project_id,root) VALUES(?,?,?)').run('w', 'p', '/test/workspace')
  store.db.prepare('INSERT INTO workspaces(id,project_id,root) VALUES(?,?,?)').run('other-w', 'other-p', '/other/workspace')
  const identities: Record<string, RuntimeIdentity> = {}
  for (const id of ['A', 'B', 'C', 'X']) {
    const other = id === 'X'
    store.db.prepare(`INSERT INTO sessions(id,project_id,workspace_id,incarnation_id,execution_epoch,token_hash,title,task_summary,state,host_id,started_at,last_heartbeat_at,last_heartbeat_mono,owner_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, other ? 'other-p' : 'p', other ? 'other-w' : 'w', id + '-run', 1, digest(id + '-secret'), id, '', 'idle', 'test-host', now, now, now, store.epoch)
    identities[id] = { session_id: id, incarnation_id: id + '-run', execution_epoch: 1, coordinator_epoch: store.epoch, coordinator_domain: store.domain, runtime_token: id + '-secret' }
  }
  const messaging = new Messaging(store, options)
  return { store, messaging, a: identities.A!, b: identities.B!, c: identities.C!, x: identities.X!, advance: (ms: number) => { now += ms } }
}
function hasCode(code: string) { return (error: unknown) => error instanceof Error && 'code' in error && error.code === code }

test('M07 explicit-only communication rejects before accepting any message', () => {
  const f = fixture()
  assert.throws(() => f.messaging.send(f.a, { to_session_id: 'B', body: 'hello', idempotency_key: 'k' }), hasCode('PERMISSION_REQUIRED'))
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get()!.n, 0)
  f.store.close()
})

test('M07 allowed-once grants authorize only the approved sender, recipient and message key', () => {
  const f = fixture()
  const grant = { project_id: 'p', grant_id: 'once', from_session_id: 'A', to_session_id: 'B', idempotency_key: 'approved' }
  f.messaging.grant(grant)
  assert.deepEqual(f.messaging.grant(grant), { grant_id: 'once', state: 'active' })
  const request = { to_session_id: 'B', body: 'approved message', idempotency_key: 'approved' }
  const sent = f.messaging.send(f.a, request)
  assert.deepEqual(f.messaging.send(f.a, request), sent)
  assert.throws(() => f.messaging.send(f.a, { ...request, idempotency_key: 'future' }), hasCode('PERMISSION_REQUIRED'))
  assert.throws(() => f.messaging.send(f.c, request), hasCode('PERMISSION_REQUIRED'))
  assert.throws(() => f.messaging.send(f.a, { ...request, to_session_id: 'C' }), hasCode('IDEMPOTENCY_CONFLICT'))
  assert.throws(() => f.messaging.grant({ ...grant, idempotency_key: 'changed' }), hasCode('IDEMPOTENCY_CONFLICT'))
  const batch = f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 })
  appendReceipts(f, f.b, batch)
  assert.equal(f.messaging.status(f.b, sent.message_id).delivery_state, 'delivered')
  assert.equal(f.messaging.read(f.b, { message_id: sent.message_id }).body_part, request.body)
  f.store.close()
})

test('M07 one-message authorization refuses missing explicit participants and migrates old grants safely', () => {
  const f = fixture()
  assert.throws(() => f.messaging.grant({ project_id: 'p', grant_id: 'unsafe', idempotency_key: 'key' }), hasCode('INVALID_ARGUMENT'))
  assert.throws(() => f.messaging.grant({ project_id: 'p', grant_id: 'unsafe', from_session_id: 'A', idempotency_key: 'key' }), hasCode('INVALID_ARGUMENT'))
  f.store.close()
  const store = new Store(':memory:')
  store.db.exec(`CREATE TABLE communication_grants(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_session_id TEXT, to_session_id TEXT,
    action TEXT NOT NULL DEFAULT 'coordination', state TEXT NOT NULL, generation INTEGER NOT NULL,
    expires_at INTEGER, created_at INTEGER NOT NULL, revocation_started_at INTEGER, revoked_at INTEGER);
    INSERT INTO communication_grants(id,project_id,state,generation,created_at) VALUES('existing','p','active',1,1);`)
  const messaging = new Messaging(store)
  assert.ok(store.db.prepare('PRAGMA table_info(communication_grants)').all().some(column => column.name === 'message_key'))
  assert.deepEqual(messaging.grant({ project_id: 'p', grant_id: 'existing' }), { grant_id: 'existing', state: 'active' })
  assert.equal(store.db.prepare('SELECT message_key FROM communication_grants WHERE id=?').get('existing')!.message_key, null)
  store.close()
})

test('M02 M03 M17 accepted idle messages persist once and sender-scoped key changes conflict', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const request = { to_session_id: 'B', body: 'hello', related_paths: ['a.ts'], idempotency_key: 'k' }
  const first = f.messaging.send(f.a, request)
  assert.equal(first.delivery_state, 'queued')
  assert.deepEqual(f.messaging.send(f.a, request), first)
  assert.throws(() => f.messaging.send(f.a, { ...request, to_session_id: 'C' }), hasCode('IDEMPOTENCY_CONFLICT'))
  assert.notEqual(f.messaging.send(f.c, request).message_id, first.message_id)
  assert.equal(f.store.session('B').state, 'idle')
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get()!.n, 2)
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM outbox WHERE source_type='message/queued'").get()!.n, 2)
  f.store.close()
})

test('L09 original send outcome uses identical validation without creating a message or broadening retries', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const request = { to_session_id: 'B', body: 'original', idempotency_key: 'original-key' }
  assert.equal(f.messaging.originalSendOutcome(f.a, request), null)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get()!.n, 0)
  const sent = f.messaging.send(f.a, request)
  assert.deepEqual(f.messaging.originalSendOutcome(f.a, request), sent)
  for (const input of [{ ...request, body: 'changed' }, { ...request, to_session_id: 'C' }]) {
    assert.throws(() => f.messaging.originalSendOutcome(f.a, input), hasCode('IDEMPOTENCY_CONFLICT'))
  }
  for (const input of [{ ...request, related_paths: null }, { ...request, in_reply_to: null }, { ...request, injected: true }, { ...request, body: '\ud800' }]) {
    assert.throws(() => f.messaging.send(f.a, input), hasCode('INVALID_ARGUMENT'))
    assert.throws(() => f.messaging.originalSendOutcome(f.a, input), hasCode('INVALID_ARGUMENT'))
  }
  assert.equal(f.messaging.originalSendOutcome(f.c, request), null)
  f.messaging.beginRevoke('policy'); f.messaging.finishRevoke('policy')
  assert.equal(f.messaging.originalSendOutcome(f.a, request)!.delivery_state, 'rejected')
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get()!.n, 1)
  f.store.close()
})

test('D03 M09 M20 project and participant isolation applies to send, status, body and handling', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const sent = f.messaging.send(f.a, { to_session_id: 'B', body: 'private', idempotency_key: 'k' })
  assert.throws(() => f.messaging.send(f.a, { to_session_id: 'X', body: 'cross', idempotency_key: 'x' }), hasCode('CROSS_PROJECT_DENIED'))
  assert.throws(() => f.messaging.status(f.c, sent.message_id), hasCode('PERMISSION_REQUIRED'))
  assert.throws(() => f.messaging.read(f.c, { message_id: sent.message_id }), hasCode('PERMISSION_REQUIRED'))
  assert.throws(() => f.messaging.markHandled(f.a, { message_id: sent.message_id, action: 'acknowledge' }), hasCode('PERMISSION_REQUIRED'))
  assert.equal(f.messaging.read(f.b, { message_id: sent.message_id }).body_part, 'private')
  f.store.close()
})

test('M19 body and mailbox byte ceilings reject before committing, old keys and bodies remain', () => {
  const f = fixture({ message_limit_bytes: 12, mailbox_limit_bytes: 15 })
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  assert.throws(() => f.messaging.send(f.a, { to_session_id: 'B', body: '🙂'.repeat(4), idempotency_key: 'big' }), hasCode('PAYLOAD_TOO_LARGE'))
  const one = f.messaging.send(f.a, { to_session_id: 'B', body: '0123456789', idempotency_key: 'one' })
  assert.throws(() => f.messaging.send(f.a, { to_session_id: 'B', body: '123456', idempotency_key: 'two' }), hasCode('MAILBOX_FULL'))
  assert.equal(f.messaging.read(f.b, { message_id: one.message_id }).body_part, '0123456789')
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get()!.n, 1)
  f.store.close()
})

test('M19 storage failure rolls back message, sequence, parts and outbox together', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  f.store.db.exec("CREATE TRIGGER deny_outbox BEFORE INSERT ON outbox WHEN NEW.source_type='message/queued' BEGIN SELECT RAISE(ABORT, 'injected full disk'); END")
  assert.throws(() => f.messaging.send(f.a, { to_session_id: 'B', body: 'hello', idempotency_key: 'k' }))
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get()!.n, 0)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM message_parts').get()!.n, 0)
  f.store.db.exec('DROP TRIGGER deny_outbox')
  const sent = f.messaging.send(f.a, { to_session_id: 'B', body: 'hello', idempotency_key: 'k' })
  assert.equal(f.store.db.prepare('SELECT recipient_sequence FROM messages WHERE id=?').get(sent.message_id)!.recipient_sequence, 1)
  f.store.close()
})

test('M15 acknowledgement is explicit and monotonic, never implies resolution', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const sent = f.messaging.send(f.a, { to_session_id: 'B', body: 'hello', idempotency_key: 'k' })
  assert.equal(f.messaging.status(f.b, sent.message_id).handling_state, 'pending')
  assert.equal(f.messaging.markHandled(f.b, { message_id: sent.message_id, action: 'acknowledge' }).handling_state, 'acknowledged')
  assert.throws(() => f.messaging.markHandled(f.b, { message_id: sent.message_id, action: 'resolve' }), hasCode('INVALID_ARGUMENT'))
  assert.equal(f.messaging.markHandled(f.b, { message_id: sent.message_id, action: 'resolve', resolution: 'Updated adapter' }).handling_state, 'resolved')
  assert.equal(f.messaging.markHandled(f.b, { message_id: sent.message_id, action: 'acknowledge' }).handling_state, 'resolved')
  f.store.close()
})

function appendReceipts(f: ReturnType<typeof fixture>, identity: RuntimeIdentity, batch: ReturnType<Messaging['fetchBatch']>, parts = batch.parts) {
  return f.store.transaction(() => {
    f.store.db.prepare('INSERT OR IGNORE INTO host_sessions(id,header,inherited_event_count) VALUES(?,?,0)').run(identity.session_id, '{}')
    const revision = f.store.session(identity.session_id).context_revision
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const event = { type: 'user/message', seq: revision + i, time: f.store.clock.utc(), surfaceOp: 'append', data: { id: part.delivery_id, role: 'user', content: [{ type: 'text', text: part.text }], source: { kind: 'session-coordination', form: 'relay', ...part, expected_context_revision: batch.expected_context_revision } } }
      f.store.db.prepare('INSERT INTO host_events(session_id,seq,event) VALUES(?,?,?)').run(identity.session_id, revision + i, JSON.stringify(event))
    }
    const result = f.messaging.admitParts(identity, { batch_id: batch.batch_id!, expected_context_revision: batch.expected_context_revision, receipts: parts.map(part => ({ delivery_id: part.delivery_id, context_record_id: part.delivery_id, text: part.text })) })
    f.store.db.prepare('UPDATE sessions SET context_revision=? WHERE id=?').run(revision + parts.length, identity.session_id)
    f.store.db.prepare('UPDATE host_sessions SET event_count=? WHERE id=?').run(revision + parts.length, identity.session_id)
    return result
  })
}

test('M01 M11 fetching is not delivery; partial real context admission is exact and resumed once', () => {
  const f = fixture({ fragment_bytes: 16 })
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const sent = f.messaging.send(f.a, { to_session_id: 'B', body: '🙂'.repeat(12), idempotency_key: 'k' })
  const batch = f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 })
  assert.equal(batch.parts.length, 3)
  assert.equal(f.messaging.status(f.b, sent.message_id).delivery_state, 'queued')
  appendReceipts(f, f.b, batch, batch.parts.slice(0, 1))
  assert.deepEqual(f.messaging.status(f.b, sent.message_id).admitted_parts, [0])
  assert.equal(f.messaging.status(f.b, sent.message_id).delivery_state, 'queued')
  const next = f.messaging.fetchBatch(f.b, { context_revision: 1, budget: 2000 })
  assert.deepEqual(next.parts.map(part => part.part_index), [1, 2])
  appendReceipts(f, f.b, next)
  assert.equal(f.messaging.status(f.b, sent.message_id).delivery_state, 'delivered')
  assert.equal(f.messaging.status(f.b, sent.message_id).handling_state, 'pending')
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM context_deliveries').get()!.n, 3)
  assert.equal(f.messaging.fetchBatch(f.b, { context_revision: 3, budget: 2000 }).parts.length, 0)
  f.store.close()
})

test('M10 admission refuses fabricated context record IDs and stale instance or revision', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  f.messaging.send(f.a, { to_session_id: 'B', body: 'hello', idempotency_key: 'k' })
  const batch = f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 })
  assert.throws(() => f.store.transaction(() => f.messaging.admitParts(f.b, { batch_id: batch.batch_id!, expected_context_revision: 0, receipts: [{ delivery_id: batch.parts[0]!.delivery_id, context_record_id: 'fabricated', text: batch.parts[0]!.text }] })), hasCode('CONTEXT_CONFLICT'))
  assert.throws(() => f.messaging.fetchBatch(f.b, { context_revision: 1, budget: 2000 }), hasCode('CONTEXT_CONFLICT'))
  f.store.db.prepare('UPDATE sessions SET incarnation_id=?,execution_epoch=2 WHERE id=?').run('B-next', 'B')
  assert.throws(() => appendReceipts(f, f.b, batch), hasCode('STALE_INSTANCE'))
  const nextIdentity = { ...f.b, incarnation_id: 'B-next', execution_epoch: 2 }
  const next = f.messaging.fetchBatch(nextIdentity, { context_revision: 0, budget: 2000 })
  assert.equal(next.parts[0]!.delivery_id, batch.parts[0]!.delivery_id)
  appendReceipts(f, nextIdentity, next)
  f.store.close()
})

test('M11 an out-of-order part cannot be admitted and failed append leaves no host event', () => {
  const f = fixture({ fragment_bytes: 8 })
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  f.messaging.send(f.a, { to_session_id: 'B', body: '0123456789abcdef', idempotency_key: 'k' })
  const batch = f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 })
  assert.throws(() => appendReceipts(f, f.b, batch, batch.parts.slice(1)), hasCode('CONTEXT_CONFLICT'))
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM host_events').get()!.n, 0)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM context_deliveries').get()!.n, 0)
  f.store.close()
})

test('M14 changed too-small budget stops explicitly without changing stable parts', () => {
  const f = fixture({ fragment_bytes: 512 })
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  f.messaging.send(f.a, { to_session_id: 'B', body: '中'.repeat(1000), idempotency_key: 'k' })
  const first = f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 })
  assert.ok(first.parts.length > 0)
  assert.throws(() => f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 100 }), hasCode('DELIVERY_BUDGET_UNSATISFIABLE'))
  const again = f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 })
  assert.deepEqual(again.parts.map(p => [p.delivery_id, p.text]), first.parts.map(p => [p.delivery_id, p.text]))
  f.store.close()
})

test('M18 M21 revocation fences fetched batches, preserves partial facts, and does not starve later messages', () => {
  const f = fixture({ fragment_bytes: 8 })
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const sent = f.messaging.send(f.a, { to_session_id: 'B', body: '0123456789abcdef', idempotency_key: 'k' })
  const first = f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 })
  appendReceipts(f, f.b, first, first.parts.slice(0, 1))
  const remaining = f.messaging.fetchBatch(f.b, { context_revision: 1, budget: 2000 })
  assert.equal(f.messaging.beginRevoke('policy').state, 'revoking')
  assert.throws(() => appendReceipts(f, f.b, remaining), hasCode('PERMISSION_REQUIRED'))
  assert.equal(f.messaging.finishRevoke('policy').state, 'revoked')
  const status = f.messaging.status(f.a, sent.message_id)
  assert.equal(status.delivery_state, 'rejected')
  assert.deepEqual(status.admitted_parts, [0])
  assert.match(status.terminal_reason!, /revok/i)
  f.messaging.grant({ project_id: 'p', grant_id: 'new-policy' })
  const later = f.messaging.send(f.c, { to_session_id: 'B', body: 'later', idempotency_key: 'later' })
  const next = f.messaging.fetchBatch(f.b, { context_revision: 1, budget: 2000 })
  assert.equal(next.parts[0]!.message_id, later.message_id)
  assert.ok(next.pending_references.some(r => r.message_id === sent.message_id && r.terminal_reason !== null))
  f.store.close()
})

test('M22 full durable admission survives lost response then revocation without fake rejection', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const sent = f.messaging.send(f.a, { to_session_id: 'B', body: 'hello', idempotency_key: 'k' })
  const batch = f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 })
  appendReceipts(f, f.b, batch)
  f.messaging.beginRevoke('policy')
  f.messaging.finishRevoke('policy')
  assert.equal(f.messaging.status(f.a, sent.message_id).delivery_state, 'delivered')
  assert.throws(() => f.messaging.read(f.b, { message_id: sent.message_id }), hasCode('PERMISSION_REQUIRED'))
  assert.throws(() => f.messaging.markHandled(f.b, { message_id: sent.message_id, action: 'acknowledge' }), hasCode('PERMISSION_REQUIRED'))
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM context_deliveries').get()!.n, 1)
  f.store.close()
})

test('M04 context and receipt roll back together on any failure before outer transaction commit', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const sent = f.messaging.send(f.a, { to_session_id: 'B', body: 'hello', idempotency_key: 'k' })
  const batch = f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 })
  assert.throws(() => f.store.transaction(() => { appendReceipts(f, f.b, batch); throw new Error('injected crash before COMMIT') }))
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM host_events').get()!.n, 0)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM context_deliveries').get()!.n, 0)
  assert.equal(f.messaging.status(f.a, sent.message_id).delivery_state, 'queued')
  appendReceipts(f, f.b, batch)
  assert.equal(f.messaging.status(f.a, sent.message_id).delivery_state, 'delivered')
  f.store.close()
})

test('M08 M09 public polling does not consume delivery and private events are participant-filtered', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const sent = f.messaging.send(f.a, { to_session_id: 'B', body: 'private-body', idempotency_key: 'k' })
  const observer = f.messaging.poll(f.c, { limit: 100 })
  assert.equal(observer.events.length, 0)
  const receiver = f.messaging.poll(f.b, { limit: 100 })
  assert.equal(receiver.events.length, 1)
  assert.equal(receiver.events[0]!.type, 'message/queued')
  assert.equal(JSON.stringify(receiver).includes('private-body'), false)
  assert.equal(f.messaging.status(f.b, sent.message_id).delivery_state, 'queued')
  assert.equal(f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 }).parts.length, 1)
  assert.throws(() => f.messaging.poll(f.c, { cursor: receiver.next_cursor!, limit: 100 }), hasCode('PERMISSION_REQUIRED'))
  assert.throws(() => f.messaging.poll(f.b, { cursor: receiver.next_cursor!, scope: 'same_workspace' }), hasCode('PERMISSION_REQUIRED'))
  f.store.close()
})

test('M12 snapshot pages retain the same content and high watermark while new events remain incrementally visible', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const before = f.messaging.send(f.a, { to_session_id: 'B', body: 'before', idempotency_key: 'before' })
  const page = f.messaging.snapshot(f.b, { limit: 1 })
  assert.ok(page.next_cursor)
  const after = f.messaging.send(f.a, { to_session_id: 'B', body: 'after', idempotency_key: 'after' })
  let cursor = page.next_cursor
  const refs = [...page.pending_message_refs]
  while (cursor) {
    const next = f.messaging.snapshot(f.b, { cursor, limit: 1 })
    assert.equal(next.snapshot_id, page.snapshot_id)
    assert.equal(next.event_high_watermark, page.event_high_watermark)
    refs.push(...next.pending_message_refs)
    cursor = next.next_cursor
  }
  assert.ok(refs.some(r => r.message_id === before.message_id))
  assert.equal(refs.some(r => r.message_id === after.message_id), false)
  const incremental = f.messaging.poll(f.b, { cursor: page.event_high_watermark, limit: 100 })
  assert.equal(incremental.events.length, 1)
  assert.equal((incremental.events[0]!.payload as {message_id:string}).message_id, after.message_id)
  f.store.close()
})

test('M20 snapshot pagination refuses another caller and expires rather than mixing generations', () => {
  const f = fixture({ snapshot_ttl_ms: 10 })
  const page = f.messaging.snapshot(f.b, { limit: 1 })
  assert.ok(page.next_cursor)
  assert.throws(() => f.messaging.snapshot(f.a, { cursor: page.next_cursor!, limit: 1 }), hasCode('PERMISSION_REQUIRED'))
  f.advance(11)
  assert.throws(() => f.messaging.snapshot(f.b, { cursor: page.next_cursor!, limit: 1 }), hasCode('RESYNC_REQUIRED'))
  f.store.close()
})

test('M13 event retention never drops accepted mailbox/idempotency and expired cursors require resync', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const initial = f.messaging.snapshot(f.b, {})
  const request = { to_session_id: 'B', body: 'retain me', idempotency_key: 'k' }
  const sent = f.messaging.send(f.a, request)
  f.store.db.exec('UPDATE outbox SET published_at=100000')
  f.messaging.pruneEvents(Number(f.store.db.prepare('SELECT MAX(sequence) n FROM events').get()!.n))
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM events').get()!.n, 0)
  assert.throws(() => f.messaging.poll(f.b, { cursor: initial.event_high_watermark }), hasCode('RESYNC_REQUIRED'))
  assert.deepEqual(f.messaging.send(f.a, request), sent)
  assert.equal(f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 }).parts.length, 1)
  assert.equal(f.messaging.snapshot(f.b, {}).pending_message_refs[0]!.message_id, sent.message_id)
  f.store.close()
})

test('M16 event retention cannot remove an unpublished outbox or skip beyond its hole', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const a = f.messaging.send(f.a, { to_session_id: 'B', body: 'a', idempotency_key: 'a' })
  const b = f.messaging.send(f.a, { to_session_id: 'B', body: 'b', idempotency_key: 'b' })
  f.store.db.prepare('UPDATE outbox SET published_at=100000 WHERE event_id=?').run(`message:${b.message_id}:queued`)
  f.messaging.pruneEvents(1000)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n, 2)
  assert.ok(f.store.db.prepare('SELECT * FROM events WHERE id=?').get(`message:${a.message_id}:queued`))
  f.store.close()
})

test('M20 body cursor is caller/message-bound and Unicode pagination is lossless', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const body = '🙂中e\u0301'.repeat(300)
  const sent = f.messaging.send(f.a, { to_session_id: 'B', body, idempotency_key: 'k' })
  const first = f.messaging.read(f.b, { message_id: sent.message_id, max_tokens: 900 })
  assert.ok(first.next_cursor)
  assert.throws(() => f.messaging.read(f.a, { message_id: sent.message_id, cursor: first.next_cursor, max_tokens: 900 }), hasCode('PERMISSION_REQUIRED'))
  let content = first.body_part
  let cursor = first.next_cursor
  while (cursor) {
    const part = f.messaging.read(f.b, { message_id: sent.message_id, cursor, max_tokens: 900 })
    content += part.body_part
    cursor = part.next_cursor
  }
  assert.equal(content, body)
  f.store.close()
})

test('M14 body retrieval charges escaped JSON, signed continuation, tool result envelope and framing', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const body = '\n"\\🙂中'.repeat(170)
  const sent = f.messaging.send(f.a, { to_session_id: 'B', body, idempotency_key: 'k' })
  let cursor: string | undefined, text = '', pages = 0
  do {
    const page = f.messaging.read(f.b, { message_id: sent.message_id, cursor, max_tokens: 900 })
    assert.ok(conservativeTokenCost(JSON.stringify(success(page, 'x'.repeat(64)))) <= 900)
    assert.ok(page.body_part.length > 0)
    text += page.body_part; cursor = page.next_cursor ?? undefined; pages++
  } while (cursor)
  assert.ok(pages > 1)
  assert.equal(text, body)
  assert.throws(() => f.messaging.read(f.b, { message_id: sent.message_id, max_tokens: 200 }), hasCode('DELIVERY_BUDGET_UNSATISFIABLE'))
  f.store.close()
})

test('M18 an expired authorization closes its undelivered slots and permits later authorized traffic', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'temporary', expires_at: 100_010 })
  const old = f.messaging.send(f.a, { to_session_id: 'B', body: 'old authorization', idempotency_key: 'old' })
  f.advance(11)
  f.messaging.grant({ project_id: 'p', grant_id: 'new' })
  const current = f.messaging.send(f.a, { to_session_id: 'B', body: 'current authorization', idempotency_key: 'current' })
  const batch = f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 })
  assert.equal(batch.parts[0]!.message_id, current.message_id)
  assert.equal(f.messaging.status(f.a, old.message_id).delivery_state, 'rejected')
  assert.equal(f.store.db.prepare('SELECT state FROM communication_grants WHERE id=?').get('temporary')!.state, 'revoked')
  f.store.close()
})

test('M18 restart reconciliation completes a persisted revocation barrier without adding body', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const sent = f.messaging.send(f.a, { to_session_id: 'B', body: 'hello', idempotency_key: 'k' })
  f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 })
  f.messaging.beginRevoke('policy')
  const resumed = new Messaging(f.store)
  resumed.recover()
  assert.equal(resumed.status(f.a, sent.message_id).delivery_state, 'rejected')
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM context_deliveries').get()!.n, 0)
  f.store.close()
})

test('M14 explicit body retrieval reports an unsatisfiable tiny budget', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  const sent = f.messaging.send(f.a, { to_session_id: 'B', body: '🙂', idempotency_key: 'k' })
  assert.throws(() => f.messaging.read(f.b, { message_id: sent.message_id, max_tokens: 1 }), hasCode('DELIVERY_BUDGET_UNSATISFIABLE'))
  f.store.close()
})

test('M23 missing canonical context evidence pauses restoration even after mailbox delivery was committed', () => {
  const f = fixture()
  f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
  f.messaging.send(f.a, { to_session_id: 'B', body: 'retain lineage', idempotency_key: 'k' })
  const batch = f.messaging.fetchBatch(f.b, { context_revision: 0, budget: 2000 })
  appendReceipts(f, f.b, batch)
  f.store.db.prepare('DELETE FROM host_events WHERE session_id=?').run('B')
  assert.throws(() => f.messaging.fetchBatch(f.b, { context_revision: 1, budget: 2000 }), hasCode('CONTEXT_CONFLICT'))
  f.store.close()
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function resumeTestActor(store: Store, id: string): RuntimeIdentity {
  const row = store.session(id)
  const incarnation = id + '-restarted-' + store.epoch
  store.db.prepare('UPDATE sessions SET owner_epoch=?,incarnation_id=?,execution_epoch=execution_epoch+1 WHERE id=?').run(store.epoch, incarnation, id)
  return { session_id: id, incarnation_id: incarnation, execution_epoch: row.execution_epoch + 1, coordinator_epoch: store.epoch, coordinator_domain: store.domain, runtime_token: id + '-secret' }
}
function crashMessagingWorker(path: string, admit: boolean) {
  const storeUrl = new URL('../src/store.ts', import.meta.url).href
  const messagingUrl = new URL('../src/messaging.ts', import.meta.url).href
  const program = `
    import { Store } from ${JSON.stringify(storeUrl)};
    import { Messaging } from ${JSON.stringify(messagingUrl)};
    const s=new Store(${JSON.stringify(path)});const m=new Messaging(s);
    function owner(id){const old=s.session(id);const incarnation=id+'-worker-'+s.epoch;s.db.prepare('UPDATE sessions SET owner_epoch=?,incarnation_id=?,execution_epoch=execution_epoch+1 WHERE id=?').run(s.epoch,incarnation,id);return{session_id:id,incarnation_id:incarnation,execution_epoch:old.execution_epoch+1,coordinator_epoch:s.epoch,coordinator_domain:s.domain,runtime_token:id+'-secret'}}
    const a=owner('A'),b=owner('B');
    m.send(a,{to_session_id:'B',body:'committed before abrupt process death',idempotency_key:'kill-case'});
    if(${JSON.stringify(admit)}){
      const batch=m.fetchBatch(b,{context_revision:0,budget:2000});
      s.transaction(()=>{
        s.db.prepare('INSERT INTO host_sessions(id,header,inherited_event_count) VALUES(?,?,0)').run('B','{}');
        batch.parts.forEach((p,i)=>{const event={type:'user/message',seq:i,time:Date.now(),surfaceOp:'append',data:{id:p.delivery_id,role:'user',content:[{type:'text',text:p.text}],source:{kind:'session-coordination',form:'relay',...p,expected_context_revision:0}}};s.db.prepare('INSERT INTO host_events(session_id,seq,event) VALUES(?,?,?)').run('B',i,JSON.stringify(event));});
        m.admitParts(b,{batch_id:batch.batch_id,expected_context_revision:0,receipts:batch.parts.map(p=>({delivery_id:p.delivery_id,context_record_id:p.delivery_id,text:p.text}))});
        s.db.prepare('UPDATE sessions SET context_revision=? WHERE id=?').run(batch.parts.length,'B');
        s.db.prepare('UPDATE host_sessions SET event_count=? WHERE id=?').run(batch.parts.length,'B');
      });
    }
    process.kill(process.pid,'SIGKILL');
  `
  return spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], { encoding: 'utf8', timeout: 10_000 })
}

test('M16 process SIGKILL after send COMMIT leaves one discoverable message and immutable retry record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-message-kill-'))
  try {
    const path = join(dir, 'state.sqlite')
    const f = fixture({}, path)
    f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
    f.store.close()
    const child = crashMessagingWorker(path, false)
    assert.equal(child.signal, 'SIGKILL', child.stderr)
    const store = new Store(path)
    const messaging = new Messaging(store)
    const a = resumeTestActor(store, 'A')
    const b = resumeTestActor(store, 'B')
    const result = messaging.send(a, { to_session_id: 'B', body: 'committed before abrupt process death', idempotency_key: 'kill-case' })
    assert.equal(result.delivery_state, 'queued')
    assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get()!.n, 1)
    assert.equal(store.db.prepare("SELECT count(*) n FROM outbox WHERE source_type='message/queued'").get()!.n, 1)
    assert.equal(messaging.fetchBatch(b, { context_revision: 0, budget: 2000 }).parts.length, 1)
    store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('M04 M22 process SIGKILL after canonical context COMMIT does not reappend on restart or revoke', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-admission-kill-'))
  try {
    const path = join(dir, 'state.sqlite')
    const f = fixture({}, path)
    f.messaging.grant({ project_id: 'p', grant_id: 'policy' })
    f.store.close()
    const child = crashMessagingWorker(path, true)
    assert.equal(child.signal, 'SIGKILL', child.stderr)
    const store = new Store(path)
    const messaging = new Messaging(store)
    const b = resumeTestActor(store, 'B')
    const id = String(store.db.prepare('SELECT id FROM messages').get()!.id)
    assert.equal(messaging.status(b, id).delivery_state, 'delivered')
    assert.equal(messaging.fetchBatch(b, { context_revision: 1, budget: 2000 }).parts.length, 0)
    messaging.beginRevoke('policy'); messaging.finishRevoke('policy')
    assert.equal(messaging.status(b, id).delivery_state, 'delivered')
    assert.equal(store.db.prepare('SELECT count(*) n FROM host_events').get()!.n, 1)
    assert.equal(store.db.prepare('SELECT count(*) n FROM context_deliveries').get()!.n, 1)
    store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
