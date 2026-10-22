import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CoordinatorClient, type ClientSocket } from '../src/client.ts'
import { success } from '../src/errors.ts'

class FakeSocket extends EventEmitter implements ClientSocket {
  destroyed = false
  writes: string[] = []
  writeError: Error | undefined
  setEncoding(_encoding: BufferEncoding): this { return this }
  write(data: string, callback: (error?: Error | null) => void): boolean { this.writes.push(data); callback(this.writeError); return !this.writeError }
  destroy(_error?: Error): this { this.destroyed = true; return this }
  connected(): void { this.emit('connect') }
  closed(): void { this.destroyed = true; this.emit('close') }
  response(index: number, value: unknown): string { const request = JSON.parse(this.writes[index]!); return JSON.stringify(success(value, request.id)) + '\n' }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture(timeout = 1000) {
  const sockets: FakeSocket[] = []
  const client = new CoordinatorClient({ socket_path: '/not-opened/unit-test.sock', admin_token: 'test-token', timeout_ms: timeout }, path => {
    assert.equal(path, '/not-opened/unit-test.sock')
    const socket = new FakeSocket(); sockets.push(socket); return socket
  })
  return { client, sockets, close() { client.close(); for (const socket of sockets) { socket.emit('error', new Error('test cleanup')); socket.closed() } } }
}
function outcome(promise: Promise<unknown>) { return promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error })) }

test('client simultaneous calls await the one connecting generation before either writes', async () => {
  const f = fixture()
  const a = outcome(f.client.call('read_a')), b = outcome(f.client.call('read_b'))
  try {
    await tick(); assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0]!.writes.length, 0)
    f.sockets[0]!.connected(); await tick(); assert.equal(f.sockets[0]!.writes.length, 2)
    f.sockets[0]!.emit('data', f.sockets[0]!.response(0, 'a') + f.sockets[0]!.response(1, 'b'))
    assert.equal((await a).value, 'a'); assert.equal((await b).value, 'b')
  } finally { f.close(); await Promise.all([a, b]) }
})

test('client close before connect rejects waiters without dispatch or hanging', async () => {
  const f = fixture(), call = outcome(f.client.call('never_dispatched'))
  f.sockets[0]!.closed()
  const result = await Promise.race([call, tick().then(() => 'hung')])
  assert.notEqual(result, 'hung')
  assert.equal(typeof result === 'string' ? null : result.error?.code, 'COORDINATOR_UNAVAILABLE')
  assert.equal(f.sockets[0]!.writes.length, 0)
  f.close()
})

test('client close between connect resolution and call continuation cannot dispatch to the old socket', async () => {
  const f=fixture(10), result=outcome(f.client.call('apply_file_change',{mutation_id:'never-dispatched'}))
  try {
    const socket=f.sockets[0]!
    socket.connected();queueMicrotask(()=>f.client.close())
    const settled=await result
    assert.equal(socket.writes.length,0)
    assert.equal(settled.error?.code,'COORDINATOR_UNAVAILABLE')
  } finally {f.close()}
})

test('client late old close cannot erase newer connection buffer or reject its requests', async () => {
  const f = fixture(), first = outcome(f.client.call('apply_file_change', { mutation_id: 'original' }))
  try {
    const old = f.sockets[0]!; old.connected(); await tick(); old.destroy()
    const next = outcome(f.client.call('get_mutation_status', { mutation_id: 'original' }))
    await tick(); const current = f.sockets[1]!; current.connected(); await tick()
    const response = current.response(0, 'original-result'), middle = Math.floor(response.length / 2)
    current.emit('data', response.slice(0, middle)); old.closed(); current.emit('data', response.slice(middle))
    assert.equal((await first).error?.code, 'OUTCOME_UNKNOWN')
    assert.equal((await next).value, 'original-result')
    assert.equal(f.sockets.length, 2); assert.equal(old.writes.length, 1)
  } finally { f.close(); await first }
})

test('client old generation error cannot settle a newer pending connection', async () => {
  const f = fixture(), oldCall = outcome(f.client.call('first'))
  try {
    const old = f.sockets[0]!; old.destroy()
    const newer = outcome(f.client.call('second')); await tick()
    old.emit('error', new Error('late old failure')); old.closed()
    const third = outcome(f.client.call('third')); await tick()
    assert.equal(f.sockets.length, 2); const socket = f.sockets[1]!
    assert.equal(socket.writes.length, 0); socket.connected(); await tick()
    assert.equal(socket.writes.length, 2)
    socket.emit('data', socket.response(0, 'second') + socket.response(1, 'third'))
    assert.equal((await oldCall).error?.code, 'COORDINATOR_UNAVAILABLE')
    assert.equal((await newer).value, 'second'); assert.equal((await third).value, 'third')
  } finally { f.close(); await oldCall }
})

test('client write failure reports unknown outcome and never replays a mutation', async () => {
  const f = fixture(), result = outcome(f.client.call('apply_file_change', { mutation_id: 'fixed-id' }))
  try {
    const socket = f.sockets[0]!; socket.writeError = new Error('write callback lost'); socket.connected()
    const settled = await result
    assert.equal(settled.error?.code, 'OUTCOME_UNKNOWN')
    assert.equal(socket.writes.length, 1); assert.equal(f.sockets.length, 1)
    assert.equal(settled.error?.details.method, 'apply_file_change')
  } finally { f.close() }
})

test('client timeout and explicit close settle only sent requests as unknown without replay', async () => {
  const f = fixture(10), result = outcome(f.client.call('send_message', { idempotency_key: 'one' }))
  try {
    const socket = f.sockets[0]!; socket.connected()
    assert.equal((await result).error?.code, 'OUTCOME_UNKNOWN')
    socket.emit('data', socket.response(0, 'late'))
    const second = outcome(f.client.call('apply_file_change', { mutation_id: 'two' })); await tick(); f.client.close(); socket.closed()
    assert.equal((await second).error?.code, 'OUTCOME_UNKNOWN')
    assert.equal(socket.writes.length, 2); assert.equal(f.sockets.length, 1)
  } finally { f.close() }
})
