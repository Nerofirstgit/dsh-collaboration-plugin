/** Persistent session messaging and bounded, attributed delivery. */

/**
 * Split a Unicode scalar string into deterministic UTF-8-bounded fragments.
 * @param body - Exact accepted message body; malformed UTF-16 is refused.
 * @param maxBytes - Stable fragment byte ceiling, fixed when the message is accepted.
 * @returns Ordered fragments whose concatenation equals the input.
 */
export function splitDeliveryBody(body: string, maxBytes: number): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Fragment size must be a positive integer')
  if ([...body].some(scalar => { const code = scalar.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff })) throw new TypeError('Message contains unpaired Unicode surrogates')
  const parts: string[] = []
  let part = ''
  let bytes = 0
  for (const scalar of body) {
    const length = Buffer.byteLength(scalar, 'utf8')
    if (length > maxBytes) throw new RangeError('Fragment budget cannot hold one Unicode scalar')
    if (bytes + length > maxBytes) {
      parts.push(part)
      part = ''
      bytes = 0
    }
    part += scalar
    bytes += length
  }
  if (part !== '' || parts.length === 0) parts.push(part)
  return parts
}

/**
 * Conservative cost for byte-based tokenizers, including one relay message frame.
 * @param text - Complete rendered content, including sender and fragment metadata.
 * @returns UTF-8 byte count plus 64 tokens reserved for message framing.
 */
export function conservativeTokenCost(text: string): number {
  return Buffer.byteLength(text, 'utf8') + 64
}

import { randomUUID } from 'node:crypto'
import type { Store } from './store.ts'
import type { RuntimeIdentity, SessionRow, SessionSummary } from './types.ts'
import { fail, success } from './errors.ts'
import { digest, fingerprint, integer, noExtra, record, string } from './util.ts'

export interface MessagingConfig {
  message_limit_bytes: number
  mailbox_limit_bytes: number
  fragment_bytes: number
  snapshot_ttl_ms: number
  injection_budget: number
  offline_ms: number
  max_snapshot_items: number
}
export type DeliveryState = 'queued' | 'reconciling' | 'delivered' | 'rejected' | 'expired'
export type HandlingState = 'pending' | 'acknowledged' | 'resolved'
interface GrantRow {
  id: string; project_id: string; from_session_id: string | null; to_session_id: string | null
  message_key: string | null
  state: 'active' | 'revoking' | 'revoked'; generation: number; expires_at: number | null
}
interface MessageRow {
  id: string; project_id: string; from_session_id: string; to_session_id: string; source_workspace_id: string
  body: string; body_bytes: number; related_paths: string; in_reply_to: string | null
  idempotency_key: string; request_fingerprint: string; recipient_sequence: number
  grant_id: string; grant_generation: number; part_count: number; delivery_state: DeliveryState
  handling_state: HandlingState; terminal_reason: string | null; created_at: number
  delivered_at: number | null; acknowledged_at: number | null; resolved_at: number | null; resolution: string | null
}
export interface MessageStatus {
  delivery_state: DeliveryState; handling_state: HandlingState; terminal_reason: string | null
  admitted_parts: number[]; delivered_at: string | null; acknowledged_at: string | null; resolved_at: string | null
}
export interface DeliveryPart {
  delivery_id: string; message_id: string; part_index: number; part_count: number; content_digest: string
  text: string; from_session_id: string; source_workspace_id: string; batch_id: string
}
export interface MessageReference {
  message_id: string; from_session_id: string; source_workspace_id: string; delivery_state: DeliveryState
  handling_state: HandlingState; admitted_parts: number[]; part_count: number; terminal_reason: string | null
}
interface PartRow { message_id: string; part_index: number; delivery_id: string; body_part: string; text: string; content_digest: string }
interface ParsedSend { toId:string; key:string; body:string; fragments:string[]; paths:string[]; reply:string|null; logicalFingerprint:string }
export interface SendOutcome { message_id:string; delivery_state:DeliveryState }
function validateStored(value: unknown, strings: string[], numbers: string[], nullableStrings: string[] = [], nullableNumbers: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('STORAGE_ERROR', 'Persisted messaging row is malformed.')
  const row = value as Record<string, unknown>
  for (const key of strings) if (typeof row[key] !== 'string') fail('STORAGE_ERROR', `Persisted ${key} must be text.`)
  for (const key of numbers) if (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key])) fail('STORAGE_ERROR', `Persisted ${key} must be an integer.`)
  for (const key of nullableStrings) if (row[key] !== null && typeof row[key] !== 'string') fail('STORAGE_ERROR', `Persisted ${key} must be text or null.`)
  for (const key of nullableNumbers) if (row[key] !== null && (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]))) fail('STORAGE_ERROR', `Persisted ${key} must be an integer or null.`)
  return row
}
function messageRow(value: unknown): MessageRow {
  const row = validateStored(value, ['id','project_id','from_session_id','to_session_id','source_workspace_id','body','related_paths','idempotency_key','request_fingerprint','grant_id'], ['body_bytes','recipient_sequence','grant_generation','part_count','created_at'], ['in_reply_to','terminal_reason','resolution'], ['delivered_at','acknowledged_at','resolved_at'])
  if (!['queued','reconciling','delivered','rejected','expired'].includes(String(row.delivery_state)) || !['pending','acknowledged','resolved'].includes(String(row.handling_state))) fail('STORAGE_ERROR', 'Persisted message state is invalid.')
  return value as MessageRow
}
function partRow(value: unknown): PartRow {
  validateStored(value, ['message_id','delivery_id','body_part','text','content_digest'], ['part_index'])
  return value as PartRow
}
function grantRow(value: unknown): GrantRow {
  const row = validateStored(value, ['id','project_id'], ['generation'], ['from_session_id','to_session_id','message_key'], ['expires_at'])
  if (!['active','revoking','revoked'].includes(String(row.state))) fail('STORAGE_ERROR', 'Persisted grant state is invalid.')
  return value as GrantRow
}
function optionalRow<T>(value: unknown, parse: (row: unknown) => T): T | undefined { return value === undefined ? undefined : parse(value) }
export interface EventSummary { id:string; sequence:number; type:string; project_id:string; workspace_id:string|null; actor_session_id:string|null; payload:unknown; created_at:string }
export interface PollRequest {cursor?:string;limit?:number;scope?:'same_project'|'same_workspace';wait_ms?:number}
export interface SnapshotRequest {cursor?:string;limit?:number;scope?:'same_project'|'same_workspace'}
export interface CoordinationSnapshot {snapshot_id:string;sessions:SessionSummary[];file_activity:Record<string,unknown>[];pending_message_refs:MessageReference[];event_high_watermark:string;next_cursor:string|null}
type SnapshotItem = {kind:'session';value:SessionSummary}|{kind:'file_activity';value:Record<string,unknown>}|{kind:'message';value:MessageReference}
const iso = (value: number | null): string | null => value === null ? null : new Date(value).toISOString()

/** Durable coordination messages; all methods run only inside the trusted coordinator. */
export class Messaging {
  readonly store: Store
  readonly config: MessagingConfig

  constructor(store: Store, config: Partial<MessagingConfig> = {}) {
    this.store = store
    this.config = {
      message_limit_bytes: config.message_limit_bytes ?? 8192,
      mailbox_limit_bytes: config.mailbox_limit_bytes ?? 10 * 1024 * 1024,
      fragment_bytes: config.fragment_bytes ?? 512,
      snapshot_ttl_ms: config.snapshot_ttl_ms ?? 60_000,
      injection_budget: config.injection_budget ?? 2000,
      offline_ms: config.offline_ms ?? 45_000,
      max_snapshot_items: config.max_snapshot_items ?? 10_000,
    }
    for (const [key, value] of Object.entries(this.config)) integer(value, key, 1, 1024 * 1024 * 1024)
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS communication_grants(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_session_id TEXT, to_session_id TEXT, message_key TEXT,
        action TEXT NOT NULL DEFAULT 'coordination', state TEXT NOT NULL, generation INTEGER NOT NULL,
        expires_at INTEGER, created_at INTEGER NOT NULL, revocation_started_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_session_id TEXT NOT NULL, to_session_id TEXT NOT NULL,
        source_workspace_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'coordination', body TEXT NOT NULL,
        body_bytes INTEGER NOT NULL, related_paths TEXT NOT NULL, in_reply_to TEXT,
        idempotency_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
        recipient_sequence INTEGER NOT NULL, grant_id TEXT NOT NULL REFERENCES communication_grants(id),
        grant_generation INTEGER NOT NULL, part_count INTEGER NOT NULL, delivery_state TEXT NOT NULL,
        handling_state TEXT NOT NULL DEFAULT 'pending', terminal_reason TEXT,
        delivered_at INTEGER, acknowledged_at INTEGER, acknowledged_by TEXT, resolved_at INTEGER, resolution TEXT,
        UNIQUE(project_id,from_session_id,idempotency_key), UNIQUE(to_session_id,recipient_sequence));
      CREATE TABLE IF NOT EXISTS message_parts(
        message_id TEXT NOT NULL REFERENCES messages(id), part_index INTEGER NOT NULL,
        delivery_id TEXT UNIQUE NOT NULL, body_part TEXT NOT NULL, text TEXT NOT NULL, content_digest TEXT NOT NULL,
        PRIMARY KEY(message_id,part_index));
      CREATE TABLE IF NOT EXISTS delivery_batches(
        id TEXT PRIMARY KEY, receiver_session_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
        execution_epoch INTEGER NOT NULL, coordinator_epoch INTEGER NOT NULL, expected_context_revision INTEGER NOT NULL,
        part_ids TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS context_deliveries(
        receiver_session_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id),
        part_index INTEGER NOT NULL, delivery_id TEXT UNIQUE NOT NULL, batch_id TEXT NOT NULL,
        incarnation_id TEXT NOT NULL, execution_epoch INTEGER NOT NULL, expected_context_revision INTEGER NOT NULL,
        content_digest TEXT NOT NULL, context_record_id TEXT NOT NULL, committed_at INTEGER NOT NULL,
        PRIMARY KEY(receiver_session_id,message_id,part_index));
      CREATE TABLE IF NOT EXISTS mailbox_progress(receiver_session_id TEXT PRIMARY KEY, completed_sequence INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS coordination_snapshots(
        id TEXT PRIMARY KEY, caller_session_id TEXT NOT NULL, project_id TEXT NOT NULL,
        scope TEXT NOT NULL, high_watermark INTEGER NOT NULL, content TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_mailbox ON messages(to_session_id,recipient_sequence);
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(to_session_id,handling_state);
      CREATE INDEX IF NOT EXISTS host_event_message_ids ON host_events(session_id,json_extract(event,'$.data.id'));
    `)
    // Existing persistent project/pair policies retain their original scope. Only
    // newly approved one-message grants carry a sender-scoped idempotency key.
    if (!store.db.prepare('PRAGMA table_info(communication_grants)').all().some(column => column.name === 'message_key')) {
      store.db.exec('ALTER TABLE communication_grants ADD COLUMN message_key TEXT')
    }
  }

  /** Trusted control operation. Never expose this method as a model tool. */
  grant(request: { project_id: string; grant_id: string; from_session_id?: string; to_session_id?: string; idempotency_key?: string; expires_at?: number }): { grant_id: string; state: string } {
    const project = string(request.project_id, 'project_id', 512)
    const id = string(request.grant_id, 'grant_id', 256)
    const from = request.from_session_id ?? null
    const to = request.to_session_id ?? null
    const key = request.idempotency_key === undefined ? null : string(request.idempotency_key, 'idempotency_key', 256)
    if (key !== null && (from === null || to === null)) fail('INVALID_ARGUMENT', 'One-message grants require an explicit sender and recipient.')
    for (const sessionId of [from, to]) if (sessionId !== null && this.store.session(sessionId).project_id !== project) fail('CROSS_PROJECT_DENIED', 'Grant scope crosses project boundaries.')
    const expires = request.expires_at === undefined ? null : integer(request.expires_at, 'expires_at', 0, Number.MAX_SAFE_INTEGER)
    return this.store.transaction(() => {
      const old = optionalRow(this.store.db.prepare('SELECT * FROM communication_grants WHERE id=?').get(id), grantRow)
      if (old) {
        if (old.project_id !== project || old.from_session_id !== from || old.to_session_id !== to || old.message_key !== key || old.expires_at !== expires) fail('IDEMPOTENCY_CONFLICT', 'Grant ID already names a different authorization.')
        return { grant_id: id, state: old.state }
      }
      this.store.db.prepare("INSERT INTO communication_grants(id,project_id,from_session_id,to_session_id,message_key,state,generation,expires_at,created_at) VALUES(?,?,?,?,?,'active',1,?,?)").run(id, project, from, to, key, expires, this.store.clock.utc())
      return { grant_id: id, state: 'active' }
    })
  }

  private activeGrant(from: SessionRow, to: SessionRow, key: string): GrantRow {
    const grant = optionalRow(this.store.db.prepare(`SELECT * FROM communication_grants WHERE project_id=? AND state='active'
      AND (from_session_id IS NULL OR from_session_id=?) AND (to_session_id IS NULL OR to_session_id=?)
      AND (message_key IS NULL OR message_key=?)
      AND (expires_at IS NULL OR expires_at>?) ORDER BY (message_key IS NOT NULL) DESC,(from_session_id IS NOT NULL)+(to_session_id IS NOT NULL) DESC,id LIMIT 1`)
      .get(from.project_id, from.id, to.id, key, this.store.clock.utc()), grantRow)
    if (!grant) fail('PERMISSION_REQUIRED', 'The human has not authorized this scoped coordination action.')
    return grant
  }

  private requireGrant(message: MessageRow): GrantRow {
    const grant = optionalRow(this.store.db.prepare('SELECT * FROM communication_grants WHERE id=?').get(message.grant_id), grantRow)
    if (!grant || grant.state !== 'active' || grant.generation !== message.grant_generation || (grant.expires_at !== null && grant.expires_at <= this.store.clock.utc())) fail('PERMISSION_REQUIRED', 'The message authorization is expired or revoked.')
    return grant
  }

  private message(identity: RuntimeIdentity, id: string, requireBodyAuthority = false): MessageRow {
    const caller = this.store.assertIdentity(identity)
    const message = optionalRow(this.store.db.prepare('SELECT * FROM messages WHERE id=?').get(string(id, 'message_id', 256)), messageRow)
    if (!message) fail('SESSION_NOT_FOUND', 'Message does not exist or is not visible.')
    if (caller.project_id !== message.project_id) fail('CROSS_PROJECT_DENIED', 'Message belongs to a different project.')
    if (caller.id !== message.from_session_id && caller.id !== message.to_session_id) fail('PERMISSION_REQUIRED', 'Private messages are visible only to their participants.')
    if (requireBodyAuthority) this.requireGrant(message)
    return message
  }

  private parseSend(input: unknown):ParsedSend {
    const request = record(input)
    noExtra(request, ['to_session_id', 'body', 'related_paths', 'in_reply_to', 'idempotency_key'])
    const toId = string(request.to_session_id, 'to_session_id', 512)
    const key = string(request.idempotency_key, 'idempotency_key', 256)
    if (typeof request.body !== 'string' || request.body.length === 0) fail('INVALID_ARGUMENT', 'Message body must be nonempty text.')
    const body = request.body
    if (Buffer.byteLength(body, 'utf8') > this.config.message_limit_bytes) fail('PAYLOAD_TOO_LARGE', 'Message body exceeds the configured UTF-8 byte limit.')
    let fragments: string[]
    try { fragments = splitDeliveryBody(body, this.config.fragment_bytes) } catch (error) { fail('INVALID_ARGUMENT', String(error)) }
    const related = request.related_paths === undefined ? [] : request.related_paths
    if (!Array.isArray(related) || related.length > 64) fail('INVALID_ARGUMENT', 'related_paths must contain at most 64 paths.')
    const paths = related.map(path => string(path, 'related_path', 1024))
    const reply = request.in_reply_to === undefined ? null : string(request.in_reply_to, 'in_reply_to', 256)
    const logicalFingerprint = fingerprint({ to_session_id: toId, body, related_paths: paths, in_reply_to: reply })
    return {toId,key,body,fragments,paths,reply,logicalFingerprint}
  }

  private originalSend(from:SessionRow,request:ParsedSend):SendOutcome|null {
    const old = optionalRow(this.store.db.prepare('SELECT * FROM messages WHERE project_id=? AND from_session_id=? AND idempotency_key=?').get(from.project_id, from.id, request.key), messageRow)
    if(!old)return null
    if(old.request_fingerprint!==request.logicalFingerprint)fail('IDEMPOTENCY_CONFLICT','Message key is already bound to different content or recipient.')
    return {message_id:old.id,delivery_state:old.delivery_state}
  }

  /** Recover only a previously accepted immutable request; never enqueue or grant authority. */
  originalSendOutcome(identity:RuntimeIdentity,input:unknown):SendOutcome|null {
    const request=this.parseSend(input)
    const from=this.store.assertIdentity(identity),to=this.store.session(request.toId)
    if(from.project_id!==to.project_id)fail('CROSS_PROJECT_DENIED','Cross-project communication is denied.')
    return this.originalSend(from,request)
  }

  send(identity: RuntimeIdentity, input: unknown):SendOutcome {
    const parsed=this.parseSend(input)
    const {toId,key,body,fragments,paths,reply}=parsed
    return this.store.transaction(() => {
      const from = this.store.assertIdentity(identity)
      const to = this.store.session(toId)
      if (from.project_id !== to.project_id) fail('CROSS_PROJECT_DENIED', 'Cross-project communication is denied.')
      const original=this.originalSend(from,parsed)
      if(original)return original
      const grant = this.activeGrant(from, to, key)
      if (reply !== null) this.message(identity, reply, true)
      const queuedBytes = Number(this.store.db.prepare("SELECT COALESCE(SUM(body_bytes),0) n FROM messages WHERE to_session_id=? AND delivery_state IN ('queued','reconciling')").get(toId)!.n)
      const bytes = Buffer.byteLength(body, 'utf8')
      if (queuedBytes + bytes > this.config.mailbox_limit_bytes) fail('MAILBOX_FULL', 'The recipient mailbox is full; no message was accepted.')
      const sequence = Number(this.store.db.prepare('SELECT COALESCE(MAX(recipient_sequence),0)+1 n FROM messages WHERE to_session_id=?').get(toId)!.n)
      const id = randomUUID()
      this.store.db.prepare(`INSERT INTO messages(id,project_id,from_session_id,to_session_id,source_workspace_id,body,body_bytes,related_paths,in_reply_to,idempotency_key,request_fingerprint,created_at,recipient_sequence,grant_id,grant_generation,part_count,delivery_state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued')`).run(id, from.project_id, from.id, toId, from.workspace_id, body, bytes, JSON.stringify(paths), reply, key, parsed.logicalFingerprint, this.store.clock.utc(), sequence, grant.id, grant.generation, fragments.length)
      fragments.forEach((bodyPart, index) => {
        const deliveryId = digest(`${id}:${index}`)
        const text = `[Session coordination; from ${from.id}; source workspace ${from.workspace_id}; not human authorization]\n[Message ${id}; part ${index + 1}/${fragments.length}; incomplete until all parts are received]\n${bodyPart}`
        this.store.db.prepare('INSERT INTO message_parts(message_id,part_index,delivery_id,body_part,text,content_digest) VALUES(?,?,?,?,?,?)').run(id, index, deliveryId, bodyPart, text, digest(text))
      })
      this.store.emitEvent({ id: `message:${id}:queued`, project_id: from.project_id, workspace_id: from.workspace_id, actor_session_id: from.id, type: 'message/queued', payload: { message_id: id, from_session_id: from.id, to_session_id: toId, delivery_state: 'queued' }, audience: [from.id, toId] })
      return { message_id: id, delivery_state: 'queued' }
    })
  }

  private admittedParts(id: string): number[] {
    return this.store.db.prepare('SELECT part_index FROM context_deliveries WHERE message_id=? ORDER BY part_index').all(id).map(row => Number(row.part_index))
  }

  status(identity: RuntimeIdentity, messageId: string): MessageStatus {
    const message = this.message(identity, messageId)
    return { delivery_state: message.delivery_state, handling_state: message.handling_state, terminal_reason: message.terminal_reason, admitted_parts: this.admittedParts(message.id), delivered_at: iso(message.delivered_at), acknowledged_at: iso(message.acknowledged_at), resolved_at: iso(message.resolved_at) }
  }

  read(identity: RuntimeIdentity, input: unknown): { body_part: string; content_digest: string; next_cursor: string | null } {
    const request = record(input)
    noExtra(request, ['message_id', 'cursor', 'max_tokens'])
    const message = this.message(identity, string(request.message_id, 'message_id', 256), true)
    const budget = integer(request.max_tokens ?? 1000, 'max_tokens', 1, 2000)
    let offset = 0
    const scope = { stream: 'message-body', session_id: identity.session_id, project_id: message.project_id, message_id: message.id, digest: digest(message.body) }
    if (request.cursor !== undefined) {
      const cursor = this.store.unsign(string(request.cursor, 'cursor', 4096))
      if (Object.entries(scope).some(([key, value]) => cursor[key] !== value)) fail('PERMISSION_REQUIRED', 'Message cursor belongs to another caller or message.')
      offset = integer(cursor.offset, 'cursor offset', 0, message.body.length)
    }
    const boundaries = [offset]
    for (const scalar of message.body.slice(offset)) boundaries.push(boundaries[boundaries.length - 1]! + scalar.length)
    const page = (count: number) => {
      const next = boundaries[count]!
      return { body_part: message.body.slice(offset, next), content_digest: scope.digest, next_cursor: next < message.body.length ? this.store.sign({ ...scope, offset: next }) : null }
    }
    // The host renders success(...) as JSON and uses UUID operation IDs. Reserve
    // 64 identifier bytes (more than a UUID) and charge the exact escaped JSON,
    // signed continuation and standard envelope, not merely the body bytes.
    const fits = (candidate: ReturnType<typeof page>) => conservativeTokenCost(JSON.stringify(success(candidate, 'x'.repeat(64)))) <= budget
    const complete = page(boundaries.length - 1)
    if (fits(complete)) return complete
    if (boundaries.length < 2 || !fits(page(1))) fail('DELIVERY_BUDGET_UNSATISFIABLE', 'Body retrieval budget cannot contain the next Unicode scalar, signed cursor and complete tool-result framing.')
    let low = 1, high = boundaries.length - 2
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (fits(page(middle))) low = middle
      else high = middle - 1
    }
    return page(low)
  }

  markHandled(identity: RuntimeIdentity, input: unknown): { handling_state: HandlingState } {
    const request = record(input)
    noExtra(request, ['message_id', 'action', 'resolution'])
    if (request.action !== 'acknowledge' && request.action !== 'resolve') fail('INVALID_ARGUMENT', 'action must be acknowledge or resolve.')
    const resolution = request.action === 'resolve' ? string(request.resolution, 'resolution', 2048) : null
    return this.store.transaction(() => {
      const message = this.message(identity, string(request.message_id, 'message_id', 256), true)
      if (identity.session_id !== message.to_session_id) fail('PERMISSION_REQUIRED', 'Only the recipient may acknowledge or resolve a message.')
      if (message.handling_state === 'resolved') return { handling_state: 'resolved' }
      const now = this.store.clock.utc()
      if (request.action === 'resolve') this.store.db.prepare("UPDATE messages SET handling_state='resolved',resolved_at=?,resolution=? WHERE id=?").run(now, resolution, message.id)
      else if (message.handling_state === 'pending') this.store.db.prepare("UPDATE messages SET handling_state='acknowledged',acknowledged_at=?,acknowledged_by=? WHERE id=?").run(now, identity.session_id, message.id)
      const state = request.action === 'resolve' ? 'resolved' : 'acknowledged'
      this.store.emitEvent({ id: `message:${message.id}:${state}`, project_id: message.project_id, actor_session_id: identity.session_id, type: `message/${state}`, payload: { message_id: message.id, handling_state: state }, audience: [message.from_session_id, message.to_session_id] })
      return { handling_state: state }
    })
  }
  /** Fetch bounded stable parts without acknowledging or waking the receiver. */
  fetchBatch(identity: RuntimeIdentity, request: {context_revision:number;budget:number}): {batch_id:string|null;expected_context_revision:number;parts:DeliveryPart[];pending_references:MessageReference[];pending_has_more:boolean} {
    const expected = integer(request.context_revision, 'context_revision', 0, Number.MAX_SAFE_INTEGER)
    const budget = integer(request.budget, 'budget', 1, 1_000_000)
    this.store.assertIdentity(identity)
    this.recover()
    return this.store.transaction(() => {
      const caller = this.store.assertIdentity(identity)
      if (caller.context_revision !== expected) fail('CONTEXT_CONFLICT', 'Fetch revision differs from the canonical host context.')
      this.verifyContextLineage(identity)
      const refs = this.pendingReferences(identity, 21)
      const response = { batch_id: null as string | null, expected_context_revision: expected, parts: [] as DeliveryPart[], pending_references: refs.slice(0, 20), pending_has_more: refs.length > 20 }
      const message = optionalRow(this.store.db.prepare("SELECT * FROM messages WHERE to_session_id=? AND delivery_state IN ('queued','reconciling') ORDER BY recipient_sequence LIMIT 1").get(caller.id), messageRow)
      if (!message || message.delivery_state === 'reconciling') return response
      this.requireGrant(message)
      const rows = this.store.db.prepare(`SELECT p.* FROM message_parts p LEFT JOIN context_deliveries d ON d.delivery_id=p.delivery_id WHERE p.message_id=? AND d.delivery_id IS NULL ORDER BY p.part_index`).all(message.id).map(partRow)
      let remaining = budget
      const selected: PartRow[] = []
      for (const part of rows) {
        const cost = conservativeTokenCost(part.text)
        if (cost > remaining) {
          if (selected.length === 0) fail('DELIVERY_BUDGET_UNSATISFIABLE', 'The fixed next fragment and its source metadata exceed this model boundary budget.', { required_tokens: cost, available_tokens: budget, message_id: message.id, part_index: part.part_index })
          break
        }
        selected.push(part)
        remaining -= cost
      }
      if (selected.length === 0) return response
      const partIds = JSON.stringify(selected.map(part => part.delivery_id))
      const prior = this.store.db.prepare(`SELECT id FROM delivery_batches WHERE receiver_session_id=? AND incarnation_id=? AND execution_epoch=? AND coordinator_epoch=? AND expected_context_revision=? AND part_ids=? AND state='open' ORDER BY created_at DESC LIMIT 1`)
        .get(caller.id, identity.incarnation_id, identity.execution_epoch, this.store.epoch, expected, partIds)
      const batchId = prior ? String(prior.id) : randomUUID()
      if (!prior) {
        this.store.db.prepare("UPDATE delivery_batches SET state='superseded' WHERE receiver_session_id=? AND state='open'").run(caller.id)
        this.store.db.prepare("INSERT INTO delivery_batches(id,receiver_session_id,incarnation_id,execution_epoch,coordinator_epoch,expected_context_revision,part_ids,state,created_at) VALUES(?,?,?,?,?,?,?,'open',?)")
          .run(batchId, caller.id, identity.incarnation_id, identity.execution_epoch, this.store.epoch, expected, partIds, this.store.clock.utc())
      }
      response.batch_id = batchId
      response.parts = selected.map(part => ({ delivery_id: part.delivery_id, message_id: message.id, part_index: part.part_index, part_count: message.part_count, content_digest: part.content_digest, text: part.text, from_session_id: message.from_session_id, source_workspace_id: message.source_workspace_id, batch_id: batchId }))
      return response
    })
  }

  /**
   * Admit receipts only inside the transaction that inserts their actual host events.
   * Caller must update the host event count/context revision after this method succeeds.
   */
  admitParts(identity: RuntimeIdentity, request: {batch_id:string;expected_context_revision:number;receipts:{delivery_id:string;context_record_id:string;text:string}[]}): {admitted_delivery_ids:string[]} {
    if (!this.store.db.isTransaction) fail('CONTEXT_CONFLICT', 'Delivery admission must share the actual host-event append transaction.')
    const caller = this.store.assertIdentity(identity)
    const batch = this.store.db.prepare('SELECT * FROM delivery_batches WHERE id=?').get(request.batch_id)
    if (!batch || batch.receiver_session_id !== caller.id || batch.incarnation_id !== identity.incarnation_id || batch.execution_epoch !== identity.execution_epoch || batch.coordinator_epoch !== this.store.epoch) fail('STALE_INSTANCE', 'Delivery batch is not owned by this execution instance.')
    if (batch.state === 'revoked') fail('PERMISSION_REQUIRED', 'Revocation fenced this pending delivery batch.')
    if (batch.state !== 'open' && batch.state !== 'admitted') fail('STALE_INSTANCE', 'Delivery batch was superseded or invalidated.')
    if (batch.expected_context_revision !== request.expected_context_revision || caller.context_revision !== request.expected_context_revision) fail('CONTEXT_CONFLICT', 'Delivery context revision changed before the canonical append.')
    const allowed = new Set<string>(JSON.parse(String(batch.part_ids)))
    const admitted: string[] = []
    for (const receipt of request.receipts) {
      const part = optionalRow(this.store.db.prepare('SELECT * FROM message_parts WHERE delivery_id=?').get(receipt.delivery_id), partRow)
      if (!part || !allowed.has(receipt.delivery_id)) fail('CONTEXT_CONFLICT', 'Receipt does not belong to this batch.')
      const message = this.message(identity, part.message_id, true)
      if (message.to_session_id !== caller.id || receipt.context_record_id !== part.delivery_id || receipt.text !== part.text || digest(receipt.text) !== part.content_digest) fail('CONTEXT_CONFLICT', 'Receipt does not match the exact attributed delivery text.')
      const evidence = this.store.db.prepare(`SELECT event FROM host_events WHERE session_id=? AND json_extract(event,'$.type')='user/message' AND json_extract(event,'$.data.id')=?`).all(caller.id, receipt.context_record_id)
      if (evidence.length !== 1) fail('CONTEXT_CONFLICT', 'A unique canonical host context record is required for every receipt.')
      const event = record(JSON.parse(String(evidence[0]!.event)))
      const data = record(event.data)
      const source = record(data.source)
      const content = data.content
      if (event.surfaceOp !== 'append' || data.role !== 'user' || source.kind !== 'session-coordination' || source.form !== 'relay' || source.delivery_id !== part.delivery_id || source.message_id !== message.id || source.batch_id !== request.batch_id || source.expected_context_revision !== request.expected_context_revision || source.part_index !== part.part_index || source.part_count !== message.part_count || source.content_digest !== part.content_digest || source.from_session_id !== message.from_session_id || source.source_workspace_id !== message.source_workspace_id || !Array.isArray(content) || content.length !== 1 || record(content[0]).type !== 'text' || record(content[0]).text !== part.text) fail('CONTEXT_CONFLICT', 'Canonical host event content/source does not prove this delivery.')
      const old = this.store.db.prepare('SELECT * FROM context_deliveries WHERE delivery_id=?').get(part.delivery_id)
      if (old) {
        if (old.receiver_session_id !== caller.id || old.context_record_id !== receipt.context_record_id || old.content_digest !== part.content_digest) fail('CONTEXT_CONFLICT', 'Delivery ID already names different persistent evidence.')
        admitted.push(part.delivery_id)
        continue
      }
      const nextMessage = this.store.db.prepare("SELECT id FROM messages WHERE to_session_id=? AND delivery_state IN ('queued','reconciling') ORDER BY recipient_sequence LIMIT 1").get(caller.id)
      const nextPart = this.store.db.prepare(`SELECT p.part_index FROM message_parts p LEFT JOIN context_deliveries d ON d.delivery_id=p.delivery_id WHERE p.message_id=? AND d.delivery_id IS NULL ORDER BY p.part_index LIMIT 1`).get(message.id)
      if (!nextMessage || nextMessage.id !== message.id || !nextPart || nextPart.part_index !== part.part_index) fail('CONTEXT_CONFLICT', 'Admission cannot skip a mailbox slot or fragment.')
      this.store.db.prepare(`INSERT INTO context_deliveries(receiver_session_id,message_id,part_index,delivery_id,batch_id,incarnation_id,execution_epoch,expected_context_revision,content_digest,context_record_id,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(caller.id, message.id, part.part_index, part.delivery_id, request.batch_id, identity.incarnation_id, identity.execution_epoch, request.expected_context_revision, part.content_digest, receipt.context_record_id, this.store.clock.utc())
      admitted.push(part.delivery_id)
      if (this.admittedParts(message.id).length === message.part_count) this.completeMessage(message)
    }
    if (request.receipts.length > 0) this.store.db.prepare("UPDATE delivery_batches SET state='admitted' WHERE id=?").run(request.batch_id)
    this.advanceMailbox(caller.id)
    return { admitted_delivery_ids: admitted }
  }

  private completeMessage(message: MessageRow): void {
    this.store.db.prepare("UPDATE messages SET delivery_state='delivered',delivered_at=COALESCE(delivered_at,?),terminal_reason=NULL WHERE id=?").run(this.store.clock.utc(), message.id)
    this.store.emitEvent({ id: `message:${message.id}:delivered`, project_id: message.project_id, actor_session_id: message.to_session_id, type: 'message/delivered', payload: { message_id: message.id, delivery_state: 'delivered' }, audience: [message.from_session_id, message.to_session_id] })
  }

  private advanceMailbox(receiver: string): void {
    const pending = this.store.db.prepare("SELECT MIN(recipient_sequence) n FROM messages WHERE to_session_id=? AND delivery_state IN ('queued','reconciling')").get(receiver)
    const maximum = Number(this.store.db.prepare('SELECT COALESCE(MAX(recipient_sequence),0) n FROM messages WHERE to_session_id=?').get(receiver)!.n)
    const complete = pending?.n === null ? maximum : Number(pending!.n) - 1
    this.store.db.prepare('INSERT INTO mailbox_progress(receiver_session_id,completed_sequence) VALUES(?,?) ON CONFLICT(receiver_session_id) DO UPDATE SET completed_sequence=MAX(completed_sequence,excluded.completed_sequence)').run(receiver, complete)
  }

  /** First durable revocation phase; pending host appends are fenced immediately. */
  beginRevoke(grantId: string): {state:string} {
    return this.store.transaction(() => {
      const grant = optionalRow(this.store.db.prepare('SELECT * FROM communication_grants WHERE id=?').get(grantId), grantRow)
      if (!grant) fail('PERMISSION_REQUIRED', 'Authorization grant does not exist.')
      if (grant.state !== 'active') return { state: grant.state }
      this.store.db.prepare("UPDATE communication_grants SET state='revoking',generation=generation+1,revocation_started_at=? WHERE id=?").run(this.store.clock.utc(), grantId)
      this.store.db.prepare(`UPDATE delivery_batches SET state='revoked' WHERE state='open' AND EXISTS(SELECT 1 FROM json_each(delivery_batches.part_ids) j JOIN message_parts p ON p.delivery_id=j.value JOIN messages m ON m.id=p.message_id WHERE m.grant_id=?)`).run(grantId)
      this.store.db.prepare("UPDATE messages SET delivery_state='reconciling' WHERE grant_id=? AND delivery_state='queued'").run(grantId)
      return { state: 'revoking' }
    })
  }

  /** Complete revocation using authoritative receipts in the same transaction domain. */
  finishRevoke(grantId: string): {state:string} {
    return this.store.transaction(() => {
      const grant = optionalRow(this.store.db.prepare('SELECT * FROM communication_grants WHERE id=?').get(grantId), grantRow)
      if (!grant || grant.state === 'active') fail('PERMISSION_REQUIRED', 'Begin revocation before completing the admission barrier.')
      if (grant.state === 'revoked') return { state: 'revoked' }
      const messages = this.store.db.prepare("SELECT * FROM messages WHERE grant_id=? AND delivery_state IN ('queued','reconciling') ORDER BY recipient_sequence").all(grantId).map(messageRow)
      for (const message of messages) {
        if (this.admittedParts(message.id).length === message.part_count) this.completeMessage(message)
        else {
          const reason = 'Communication permission revoked; any unreceived parts were terminated.'
          this.store.db.prepare("UPDATE messages SET delivery_state='rejected',terminal_reason=? WHERE id=?").run(reason, message.id)
          this.store.emitEvent({ id: `message:${message.id}:rejected`, project_id: message.project_id, type: 'message/rejected', payload: { message_id: message.id, delivery_state: 'rejected', terminal_reason: reason, admitted_parts: this.admittedParts(message.id) }, audience: [message.from_session_id, message.to_session_id] })
        }
        this.advanceMailbox(message.to_session_id)
      }
      this.store.db.prepare("UPDATE communication_grants SET state='revoked',revoked_at=? WHERE id=?").run(this.store.clock.utc(), grantId)
      return { state: 'revoked' }
    })
  }

  /** Durable unresolved index; includes acknowledged and partially terminated messages. */
  pendingReferences(identity: RuntimeIdentity, limit = 20): MessageReference[] {
    this.store.assertIdentity(identity)
    const rows = this.store.db.prepare("SELECT * FROM messages WHERE to_session_id=? AND handling_state!='resolved' ORDER BY recipient_sequence LIMIT ?").all(identity.session_id, integer(limit, 'limit', 1, 100)).map(messageRow)
    return rows.map(message => ({ message_id: message.id, from_session_id: message.from_session_id, source_workspace_id: message.source_workspace_id, delivery_state: message.delivery_state, handling_state: message.handling_state, admitted_parts: this.admittedParts(message.id), part_count: message.part_count, terminal_reason: message.terminal_reason }))
  }
  private cursorScope(caller:SessionRow, stream:string, scope:'same_project'|'same_workspace'):Record<string,unknown> {
    return { v:1, stream, session_id:caller.id, project_id:caller.project_id, workspace_id:scope==='same_workspace'?caller.workspace_id:null, scope }
  }
  private parseScope(value:unknown):'same_project'|'same_workspace' {
    if(value===undefined||value==='same_project')return 'same_project'
    if(value==='same_workspace')return 'same_workspace'
    fail('INVALID_ARGUMENT','scope must be same_project or same_workspace.')
  }
  private cursorPosition(cursor:string, expected:Record<string,unknown>):Record<string,unknown> {
    const value=this.store.unsign(string(cursor,'cursor',8192))
    if(Object.entries(expected).some(([key,item])=>value[key]!==item))fail('PERMISSION_REQUIRED','Cursor belongs to another caller, stream, or scope.')
    return value
  }
  private eventFloor():number {
    const row=this.store.db.prepare("SELECT value FROM metadata WHERE key='event_retention_floor'").get()
    return row?Number(row.value):0
  }
  private eventHighWatermark():number {
    return Math.max(this.eventFloor(),Number(this.store.db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM events').get()!.n))
  }
  /** Read one bounded event page; the RPC layer owns cancellable long-poll waiting. */
  poll(identity:RuntimeIdentity,request:PollRequest):{events:EventSummary[];next_cursor:string|null;has_more:boolean;resync_required:boolean} {
    const limit=integer(request.limit??20,'limit',1,100)
    integer(request.wait_ms??0,'wait_ms',0,30_000)
    const scope=this.parseScope(request.scope)
    return this.store.transaction(()=>{
      const caller=this.store.assertIdentity(identity)
      const cursorScope=this.cursorScope(caller,'events',scope)
      let after=this.eventFloor()
      if(request.cursor!==undefined)after=integer(this.cursorPosition(request.cursor,cursorScope).after,'cursor position',0,Number.MAX_SAFE_INTEGER)
      if(after<this.eventFloor())fail('RESYNC_REQUIRED','Event cursor predates the retained event stream.',{resync_required:true,next_cursor:null})
      if(after>this.eventHighWatermark())fail('RESYNC_REQUIRED','Event cursor names a future or restored event stream.',{resync_required:true,next_cursor:null})
      const rows=this.store.db.prepare('SELECT * FROM events WHERE project_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(caller.project_id,after,limit+1)
      const scanned=rows.slice(0,limit)
      const events:EventSummary[]=[]
      for(const row of scanned) {
        after=Number(row.sequence)
        if(scope==='same_workspace'&&row.workspace_id!==null&&row.workspace_id!==caller.workspace_id)continue
        const audience=row.audience===null?null:JSON.parse(String(row.audience))
        if(audience!==null&&(!Array.isArray(audience)||!audience.includes(caller.id)))continue
        const payload:unknown=JSON.parse(String(row.payload))
        events.push({id:String(row.id),sequence:Number(row.sequence),type:String(row.type),project_id:String(row.project_id),workspace_id:row.workspace_id===null?null:String(row.workspace_id),actor_session_id:row.actor_session_id===null?null:String(row.actor_session_id),payload,created_at:new Date(Number(row.created_at)).toISOString()})
      }
      return {events,next_cursor:this.store.sign({...cursorScope,after}),has_more:rows.length>limit,resync_required:false}
    })
  }

  private fileActivity(caller:SessionRow):Record<string,unknown>[] {
    if(!this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='writer_leases'").get())return []
    const rows=this.store.db.prepare(`SELECT g.resource_key,g.recovery_state,l.owner_session_id,l.fencing_token,l.expires_at
      FROM resource_guards g LEFT JOIN writer_leases l ON l.workspace_id=g.workspace_id AND l.resource_key=g.resource_key
        AND l.active=1 AND l.coordinator_epoch=? AND l.expires_mono>?
        AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=l.owner_session_id AND s.incarnation_id=l.owner_incarnation_id AND s.execution_epoch=l.execution_epoch AND s.owner_epoch=l.coordinator_epoch)
      WHERE g.workspace_id=? AND (g.recovery_state!='ready' OR l.lease_id IS NOT NULL) ORDER BY g.resource_key`)
      .all(this.store.epoch,this.store.clock.monotonic(),caller.workspace_id)
    return rows.map(row=>({workspace_id:caller.workspace_id,path:String(row.resource_key),recovery_state:String(row.recovery_state),owner_session_id:row.owner_session_id===null?null:String(row.owner_session_id),fencing_token:row.fencing_token===null?null:Number(row.fencing_token),expires_at:row.expires_at===null?null:new Date(Number(row.expires_at)).toISOString()}))
  }
  private summary(row:SessionRow):SessionSummary {
    const active=row.owner_epoch===this.store.epoch&&this.store.clock.monotonic()-row.last_heartbeat_mono<=this.config.offline_ms
    return {id:row.id,project_id:row.project_id,workspace_id:row.workspace_id,title:row.title,task_summary:row.task_summary,state:row.state,presence:active?'online':'offline',workspace:this.store.workspace(row.workspace_id).root,started_at:new Date(row.started_at).toISOString(),last_heartbeat_at:new Date(row.last_heartbeat_at).toISOString()}
  }
  /** Capture state and event watermark together, then paginate the immutable caller-bound image. */
  snapshot(identity:RuntimeIdentity,request:SnapshotRequest):CoordinationSnapshot {
    const limit=integer(request.limit??20,'limit',1,100)
    const scope=this.parseScope(request.scope)
    return this.store.transaction(()=>{
      const caller=this.store.assertIdentity(identity)
      const cursorScope=this.cursorScope(caller,'snapshot',scope)
      let id:string, high:number, items:SnapshotItem[], offset=0
      if(request.cursor!==undefined) {
        const cursor=this.cursorPosition(request.cursor,cursorScope)
        id=string(cursor.snapshot_id,'snapshot_id',256)
        offset=integer(cursor.offset,'snapshot offset',0,Number.MAX_SAFE_INTEGER)
        const saved=this.store.db.prepare('SELECT * FROM coordination_snapshots WHERE id=?').get(id)
        if(!saved||saved.caller_session_id!==caller.id||saved.project_id!==caller.project_id||saved.scope!==scope)fail('PERMISSION_REQUIRED','Snapshot does not belong to this caller and scope.')
        if(Number(saved.expires_at)<=this.store.clock.utc())fail('RESYNC_REQUIRED','Snapshot expired; obtain a new complete snapshot.',{resync_required:true,next_cursor:null})
        high=Number(saved.high_watermark)
        items=JSON.parse(String(saved.content)) as SnapshotItem[]
      } else {
        id=randomUUID();high=this.eventHighWatermark();items=[]
        const sessions=this.store.db.prepare('SELECT id FROM sessions WHERE project_id=? AND deleted=0 ORDER BY id').all(caller.project_id)
        for(const entry of sessions) {
          const session=this.store.session(String(entry.id))
          if(scope==='same_workspace'&&session.workspace_id!==caller.workspace_id)continue
          items.push({kind:'session',value:this.summary(session)})
        }
        for(const activity of this.fileActivity(caller))items.push({kind:'file_activity',value:activity})
        const messages=this.store.db.prepare("SELECT * FROM messages WHERE to_session_id=? AND handling_state!='resolved' ORDER BY recipient_sequence").all(caller.id).map(messageRow)
        for(const message of messages)items.push({kind:'message',value:{message_id:message.id,from_session_id:message.from_session_id,source_workspace_id:message.source_workspace_id,delivery_state:message.delivery_state,handling_state:message.handling_state,admitted_parts:this.admittedParts(message.id),part_count:message.part_count,terminal_reason:message.terminal_reason}})
        if(items.length>this.config.max_snapshot_items)fail('PAYLOAD_TOO_LARGE','Snapshot exceeds the configured item capacity; resolve retained items or increase the capacity.',{items:items.length,maximum:this.config.max_snapshot_items})
        this.store.db.prepare('INSERT INTO coordination_snapshots(id,caller_session_id,project_id,scope,high_watermark,content,expires_at) VALUES(?,?,?,?,?,?,?)').run(id,caller.id,caller.project_id,scope,high,JSON.stringify(items),this.store.clock.utc()+this.config.snapshot_ttl_ms)
      }
      if(offset>items.length)fail('RESYNC_REQUIRED','Snapshot page offset is invalid.',{resync_required:true,next_cursor:null})
      const page=items.slice(offset,offset+limit)
      const result:CoordinationSnapshot={snapshot_id:id,sessions:[],file_activity:[],pending_message_refs:[],event_high_watermark:this.store.sign({...this.cursorScope(caller,'events',scope),after:high}),next_cursor:offset+limit<items.length?this.store.sign({...cursorScope,snapshot_id:id,offset:offset+limit}):null}
      for(const item of page) {
        if(item.kind==='session')result.sessions.push(item.value)
        else if(item.kind==='file_activity')result.file_activity.push(item.value)
        else if(item.kind==='message')result.pending_message_refs.push(item.value)
        else fail('STORAGE_ERROR','Persisted snapshot contains an unknown item type.')
      }
      return result
    })
  }

  /** Retain all unpublished notifications and advance the floor only across a safe prefix. */
  pruneEvents(beforeSequence:number):void {
    integer(beforeSequence,'before_sequence',0,Number.MAX_SAFE_INTEGER)
    this.store.transaction(()=>{
      const requested=Math.min(beforeSequence,this.eventHighWatermark())
      const unpublished=this.store.db.prepare('SELECT MIN(e.sequence) n FROM events e LEFT JOIN outbox o ON o.event_id=e.id WHERE e.sequence<=? AND o.published_at IS NULL').get(requested)!.n
      const through=Math.max(this.eventFloor(),unpublished===null?requested:Number(unpublished)-1)
      this.store.db.prepare('DELETE FROM outbox WHERE event_id IN (SELECT id FROM events WHERE sequence<=?) AND published_at IS NOT NULL').run(through)
      this.store.db.prepare('DELETE FROM events WHERE sequence<=?').run(through)
      this.store.db.prepare("INSERT INTO metadata(key,value) VALUES('event_retention_floor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(through))
    })
  }
  /** Finish durable grant barriers before reopening the mailbox after a coordinator restart. */
  recover():void {
    const expired=this.store.db.prepare("SELECT id FROM communication_grants WHERE state='active' AND expires_at IS NOT NULL AND expires_at<=?").all(this.store.clock.utc())
    for(const grant of expired)this.beginRevoke(String(grant.id))
    const revoking=this.store.db.prepare("SELECT id FROM communication_grants WHERE state='revoking'").all()
    for(const grant of revoking)this.finishRevoke(String(grant.id))
  }

  /** Canonical append-only history must still contain every admitted part on resume. */
  verifyContextLineage(identity:RuntimeIdentity):void {
    this.store.assertIdentity(identity)
    const receipts=this.store.db.prepare('SELECT delivery_id,context_record_id,content_digest FROM context_deliveries WHERE receiver_session_id=?').all(identity.session_id)
    for(const receipt of receipts) {
      const rows=this.store.db.prepare("SELECT event FROM host_events WHERE session_id=? AND json_extract(event,'$.type')='user/message' AND json_extract(event,'$.data.id')=?").all(identity.session_id,String(receipt.context_record_id))
      if(rows.length!==1)fail('CONTEXT_CONFLICT','Canonical history is missing an admitted coordination part; context repair is required before another model request.',{repair_required:true,delivery_id:receipt.delivery_id})
      const event=record(JSON.parse(String(rows[0]!.event))),data=record(event.data),source=record(data.source),content=data.content
      if(source.kind!=='session-coordination'||source.delivery_id!==receipt.delivery_id||source.content_digest!==receipt.content_digest||!Array.isArray(content)||content.length!==1||record(content[0]).type!=='text'||digest(String(record(content[0]).text))!==receipt.content_digest)fail('CONTEXT_CONFLICT','Canonical coordination history differs from the committed receipt; context repair is required.',{repair_required:true,delivery_id:receipt.delivery_id})
    }
  }

}
