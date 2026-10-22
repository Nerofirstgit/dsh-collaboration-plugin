/** Canonical DeepSeek Harness SessionPersistence provider over the coordinator. */
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence, SessionPersistenceRevision, materializeAppendBatch, materializeCreateHeader,
  assertContiguous, validateStoredEvents, SessionReadOnlyError, SessionHandleClosedError,
  SessionOwnershipLostError, SessionPersistenceNotFoundError, SessionAlreadyExistsError, SessionAlreadyOwnedError,
  type SessionHandle, type SessionAccess, type SessionHandleReadResult,
  type SessionPersistenceCreateOptions, type SessionPersistenceOpenOptions, type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions, type SessionPersistenceListOptions,
  type SessionHandleAppendOptions, type SessionHandleFlushOptions, type SessionHandleReadOptions,
} from '@deepseek-ai/dsh-session-persistence'
import type { CoordinatorClient } from '../client.ts'
import type { RuntimeIdentity } from '../types.ts'
import { restorePendingToolResults } from './recovery.ts'

/** Only the authenticated coordinator call capability crosses the adapter. */
export type HostCoordinatorTransport = Pick<CoordinatorClient, 'call'>
/** Trusted fallback for sessions whose original header has no working directory. */
export interface HostPersistenceOptions { workspaceRoot: string }

/** Parse a wire object before trusting any returned identifiers. */
export function wireObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as Record<string, unknown>
}
/** Parse a nonempty wire string. */
export function wireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a nonempty string`)
  return value
}
/** Parse a nonnegative safe wire integer. */
export function wireInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) throw new TypeError(`${name} must be a nonnegative integer`)
  return value
}
/** Admit the exact private runtime credential fields; never expose this object to a model. */
function parseIdentity(value: unknown): RuntimeIdentity {
  const v=wireObject(value,'identity')
  return {
    session_id:wireString(v.session_id,'session_id'), incarnation_id:wireString(v.incarnation_id,'incarnation_id'),
    execution_epoch:wireInteger(v.execution_epoch,'execution_epoch'), coordinator_epoch:wireInteger(v.coordinator_epoch,'coordinator_epoch'),
    coordinator_domain:wireString(v.coordinator_domain,'coordinator_domain'),runtime_token:wireString(v.runtime_token,'runtime_token'),
  }
}
/** Validate storage headers through the host's own durable format validator. */
function parseHeader(value: unknown): SessionHeader {
  const v=wireObject(value,'SessionHeader')
  if(v.version!==SESSION_FORMAT_VERSION || typeof v.isSeeded!=='boolean') throw new TypeError('Unsupported or invalid SessionHeader')
  wireString(v.id,'SessionHeader.id'); wireInteger(v.createdAt,'SessionHeader.createdAt')
  if(v.cwd!==undefined && (typeof v.cwd!=='string'||!isAbsolute(v.cwd)))throw new TypeError('SessionHeader.cwd must be absolute')
  if(v.origin!==undefined&&v.origin!=='subagent')throw new TypeError('Invalid SessionHeader.origin')
  return materializeCreateHeader({
    id:SessionId(String(v.id)),version:SESSION_FORMAT_VERSION,createdAt:Number(v.createdAt),isSeeded:v.isSeeded,
    ...v.cwd===undefined?{}:{cwd:v.cwd as string},
    ...v.parentSession===undefined?{}:{parentSession:SessionId(wireString(v.parentSession,'parentSession'))},
    ...v.origin===undefined?{}:{origin:'subagent' as const},
    ...v.delegationDepth===undefined?{}:{delegationDepth:wireInteger(v.delegationDepth,'delegationDepth')},
    ...v.agentPreset===undefined?{}:{agentPreset:wireString(v.agentPreset,'agentPreset')},
  })
}
/** Preserve host ownership errors that its create/resume code handles by class. */
function rethrowHost(error: unknown,id:SessionId,activeHandle=false): never {
  const e=error instanceof Error ? error : new Error(String(error))
  const fields=error!==null && typeof error==='object' ? error as Record<string,unknown> : {}
  const details=fields.details!==null && typeof fields.details==='object' ? fields.details as Record<string,unknown> : {}
  if(fields.code==='SESSION_NOT_FOUND') throw new SessionPersistenceNotFoundError(id)
  if(details.host_error==='SessionAlreadyExistsError') throw new SessionAlreadyExistsError(id)
  if(details.host_error==='SessionAlreadyOwnedError') throw new SessionAlreadyOwnedError(id)
  if(activeHandle && fields.code==='STALE_INSTANCE') throw new SessionOwnershipLostError(id)
  throw e
}

interface PendingAppend { id:string; fingerprint:string; events:readonly SessionEvent[]; expected:number; fromBuffer:boolean }
/** One private handle; live events and explicit appends share one serialized drain. */
class CoordinatorSessionHandle implements SessionHandle {
  readonly id:SessionId
  readonly header:SessionHeader
  readonly inheritedEventCount:SessionLogOffset
  readonly access:SessionAccess
  readonly identity:RuntimeIdentity|undefined
  readonly handleId:string
  private cursor:number
  private buffered:SessionEvent[]=[]
  private chain:Promise<void>=Promise.resolve()
  private closing:Promise<void>|undefined
  private closed=false
  private closePrepared=false
  private pending:PendingAppend|undefined
  private readonly provider:CoordinationSessionPersistence

  constructor(provider:CoordinationSessionPersistence,value:unknown,access:SessionAccess) {
    this.provider=provider
    const v=wireObject(value,'session handle')
    this.header=parseHeader(v.header); this.id=this.header.id; this.access=access
    this.handleId=wireString(v.handle_id,'handle_id')
    this.inheritedEventCount=SessionLogOffset(wireInteger(v.inherited_event_count,'inherited_event_count'))
    this.cursor=wireInteger(v.event_count,'event_count')
    this.identity=access==='write' ? parseIdentity(v.identity) : undefined
    if(this.identity && this.identity.session_id!==this.id) throw new TypeError('Handle identity names a different session')
    // A new seeded handle is created before its inherited prefix is appended.
    // Host restore validates that prefix after the owner has materialized it.
  }
  get eventCount():number { return this.cursor }
  private assertOpen(operation:string):void {
    if(this.closed||this.closing||this.closePrepared) throw new SessionHandleClosedError(this.id,operation)
  }
  private assertWriter(operation:string):void { if(this.access!=='write') throw new SessionReadOnlyError(this.id,operation) }
  private enqueue<T>(operation:()=>Promise<T>):Promise<T> {
    const result=this.chain.then(operation)
    this.chain=result.then(()=>undefined,()=>undefined)
    return result
  }
  private async rpc(method:string,params:Record<string,unknown>):Promise<unknown> {
    try{return await this.provider.transport.call(method,{handle_id:this.handleId,...params},this.identity)}
    catch(error){return rethrowHost(error,this.id,true)}
  }
  route(event:SessionEvent):void {
    this.assertOpen('route'); this.assertWriter('route')
    const snapshot=materializeAppendBatch([event])[0]
    if(snapshot) this.buffered.push(snapshot)
  }
  async read(offset=0,length?:number,options?:SessionHandleReadOptions):Promise<SessionHandleReadResult> {
    this.assertOpen('read'); options?.signal?.throwIfAborted()
    wireInteger(offset,'offset'); if(length!==undefined) wireInteger(length,'length')
    await this.chain
    const response=wireObject(await this.rpc('session_read',{offset,...length===undefined?{}:{length}}),'session_read')
    if(!Array.isArray(response.events)) throw new TypeError('session_read.events must be an array')
    const events=validateStoredEvents(this.header,response.events as SessionEvent[])
    assertContiguous(this.id,events,offset)
    return {eventState:'shared-frozen',events}
  }
  append(events:readonly SessionEvent[],options?:SessionHandleAppendOptions):Promise<void> {
    try {this.assertOpen('append');this.assertWriter('append');options?.signal?.throwIfAborted()}
    catch(error){return Promise.reject(error)}
    const batch=materializeAppendBatch(events)
    return this.enqueue(async()=>{options?.signal?.throwIfAborted();await this.writeBatch(batch)})
  }
  private async writeBatch(events:readonly SessionEvent[],fromBuffer=false):Promise<void> {
    if(events.length===0) return
    const fingerprint=createHash('sha256').update(JSON.stringify(events)).digest('hex')
    if(this.pending && this.pending.fingerprint!==fingerprint) throw new Error('A pending append has an unresolved outcome; retry the original batch before new events')
    if(!this.pending) {
      assertContiguous(this.id,events,this.cursor)
      this.pending={id:randomUUID(),fingerprint,events,expected:this.cursor,fromBuffer}
    }
    const p=this.pending
    const response=wireObject(await this.rpc('session_append',{expected_seq:p.expected,events:p.events,append_id:p.id}),'session_append')
    const count=wireInteger(response.event_count,'event_count')
    if(count!==p.expected+p.events.length) throw new Error('Coordinator append returned an inconsistent event count')
    this.cursor=count;this.pending=undefined
  }
  private async drain():Promise<void> {
    while(this.pending || this.buffered.length>0) {
      // Explicit seed/repair appends are not live-buffer entries. A failed
      // explicit append must not consume later routed events on recovery.
      const batch=this.pending?.events ?? this.buffered.slice()
      const fromBuffer=this.pending?.fromBuffer ?? true
      await this.writeBatch(batch,fromBuffer)
      if(fromBuffer)this.buffered.splice(0,batch.length)
    }
  }
  flush(options?:SessionHandleFlushOptions):Promise<void> {
    try{this.assertOpen('flush');this.assertWriter('flush');options?.signal?.throwIfAborted()}
    catch(error){return Promise.reject(error)}
    return this.enqueue(async()=>{options?.signal?.throwIfAborted();await this.drain();await this.rpc('session_flush',{})})
  }
  close():Promise<void> {
    if(this.closing) return this.closing
    if(this.closed) return Promise.resolve()
    this.closing=this.enqueue(async()=>{
      if(this.access==='write'&&!this.closePrepared) {
        await this.drain()
        if(this.pending) await this.writeBatch(this.pending.events)
        await this.rpc('session_flush',{})
      }
      this.closePrepared=true
      await this.rpc('session_close',{})
      this.closed=true; this.provider.release(this)
    })
    // Failed drain keeps the handle owned, permitting explicit close retry.
    void this.closing.catch(()=>{this.closing=undefined})
    return this.closing
  }
  [Symbol.asyncDispose]():Promise<void>{return this.close()}
}

/** Swappable host provider storing actual Session events in the coordinator SQLite log. */
export class CoordinationSessionPersistence extends SessionPersistence {
  readonly transport:HostCoordinatorTransport
  private readonly options:HostPersistenceOptions
  private readonly handles=new Set<CoordinatorSessionHandle>()
  private readonly pendingOpens=new Map<string,{method:string;fingerprint:string;params:Record<string,unknown>}>()
  private readonly opening=new Set<string>()
  private readonly writers=new Map<SessionId,CoordinatorSessionHandle>()
  constructor(ctx:Context,transport:HostCoordinatorTransport,options:HostPersistenceOptions) {
    super(ctx)
    this.transport=transport;this.options=options
    ctx.on('session/event',(session,event)=>{this.route(session.id,event)})
    ctx.on('session/flush',async session=>{await this.writers.get(session.id)?.flush()})
    // AgentLoop owns handle.close(); provider disposal still drains orphaned handles.
    ctx.effect(()=>async()=>{
      const outcomes=await Promise.allSettled([...this.handles].map(h=>h.close()))
      const failures=outcomes.filter((x):x is PromiseRejectedResult=>x.status==='rejected').map(x=>x.reason)
      if(failures.length) throw new AggregateError(failures,'Coordination session handle shutdown failed')
    })
  }
  private keep(value:unknown,access:SessionAccess):CoordinatorSessionHandle {
    const h=new CoordinatorSessionHandle(this,value,access)
    if(access==='write'&&this.writers.has(h.id)) throw new SessionAlreadyOwnedError(h.id)
    this.handles.add(h);if(access==='write')this.writers.set(h.id,h)
    return h
  }
  /** Remove a closed handle without dropping a newer owner's registration. */
  release(handle:CoordinatorSessionHandle):void {
    this.handles.delete(handle)
    if(this.writers.get(handle.id)===handle)this.writers.delete(handle.id)
  }
  /** Route the committed host event, not a separately synthesized conversation. */
  route(id:SessionId,event:SessionEvent):void {this.writers.get(id)?.route(event)}
  /** Return the runtime-only credential established by the canonical write handle. */
  runtimeIdentity(id:SessionId):RuntimeIdentity {
    const identity=this.writers.get(id)?.identity
    if(!identity)throw new SessionOwnershipLostError(id)
    return identity
  }
  /** Read canonical durable events without using deprecated synchronous Session reads. */
  async readEvents(id:SessionId,offset:number,length?:number):Promise<readonly SessionEvent[]> {
    const h=this.writers.get(id);if(!h)throw new SessionOwnershipLostError(id)
    return (await h.read(offset,length)).events
  }
  /** Current durable event-count revision after a flush. */
  contextRevision(id:SessionId):number {
    const h=this.writers.get(id);if(!h)throw new SessionOwnershipLostError(id)
    return h.eventCount
  }
  private async openRequest(id:SessionId,access:SessionAccess,method:string,base:Record<string,unknown>,prepare?:()=>Promise<Record<string,unknown>>):Promise<SessionHandle> {
    const key=`${access}:${id}`,fingerprint=JSON.stringify({method,...base})
    if(this.opening.has(key))throw new SessionAlreadyOwnedError(id)
    const prior=this.pendingOpens.get(key)
    if(prior&&prior.fingerprint!==fingerprint)throw new Error('A pending session open has an unresolved outcome; retry the original request')
    this.opening.add(key)
    try{
      let request=prior
      if(!request){
        request={method,fingerprint,params:{...base,...await prepare?.(),open_request_id:randomUUID()}}
        this.pendingOpens.set(key,request)
      }
      let response:unknown
      try{response=await this.transport.call(request.method,request.params)}
      catch(error){
        const fields=error!==null&&typeof error==='object'?error as Record<string,unknown>:{}
        const details=fields.details!==null&&typeof fields.details==='object'?fields.details as Record<string,unknown>:{}
        const definitive=typeof fields.code==='string'&&!['OUTCOME_UNKNOWN','COORDINATOR_UNAVAILABLE','STORAGE_ERROR'].includes(fields.code)
        if(definitive)this.pendingOpens.delete(key)
        // A committed open whose connection was lost has no retrievable handle.
        // A definitive stale-CAS reply (never AlreadyOwned) permits one new
        // owner CAS. The daemon still refuses every connected live writer.
        if(prior&&method==='session_open'&&fields.code==='STALE_INSTANCE'&&details.host_error===undefined){
          request={method,fingerprint,params:{...base,...await prepare?.(),open_request_id:randomUUID()}}
          this.pendingOpens.set(key,request)
          try{response=await this.transport.call(request.method,request.params)}
          catch(retryError){
            const retryFields=retryError!==null&&typeof retryError==='object'?retryError as Record<string,unknown>:{}
            if(typeof retryFields.code==='string'&&!['OUTCOME_UNKNOWN','COORDINATOR_UNAVAILABLE','STORAGE_ERROR'].includes(retryFields.code))this.pendingOpens.delete(key)
            throw retryError
          }
        }else throw error
      }
      const handle=this.keep(response,access)
      this.pendingOpens.delete(key)
      return handle
    }finally{this.opening.delete(key)}
  }
  async create(header:SessionHeader,options?:SessionPersistenceCreateOptions):Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const canonical=materializeCreateHeader(header)
    if(this.writers.has(header.id))throw new SessionAlreadyExistsError(header.id)
    try{return await this.openRequest(header.id,'write','session_create',{header:canonical,inherited_event_count:options?.inheritedEventCount??0,workspace_root:this.options.workspaceRoot})}
    catch(error){return rethrowHost(error,header.id)}
  }
  async open(id:SessionId,access:SessionAccess,options?:SessionPersistenceOpenOptions):Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    if(access==='write'&&this.writers.has(id))throw new SessionAlreadyOwnedError(id)
    try{
      const handle=await this.openRequest(id,access,'session_open',{id,access},async()=>{
        const previous=access==='write'?await this.transport.call('session_stat',{id}):null
        const expected=previous===null?undefined:wireObject(previous,'session stat').previous_incarnation
        return expected===undefined?{}:{expected_previous_incarnation:wireString(expected,'previous_incarnation')}
      })
      if(access==='write'){
        try{await restorePendingToolResults(handle,this.transport,this.runtimeIdentity(id))}
        catch(error){await handle.close().catch(()=>undefined);throw error}
      }
      return handle
    }catch(error){return rethrowHost(error,id)}
  }
  async flush():Promise<void> {
    const outcomes=await Promise.allSettled([...this.writers.values()].map(h=>h.flush()))
    const failures=outcomes.filter((x):x is PromiseRejectedResult=>x.status==='rejected').map(x=>x.reason)
    if(failures.length)throw new AggregateError(failures,'Coordination session flush failed')
  }
  private snapshot(value:unknown):SessionPersistenceSnapshot {
    const v=wireObject(value,'session snapshot')
    return {header:parseHeader(v.header),eventCount:wireInteger(v.event_count,'event_count'),revision:SessionPersistenceRevision(wireString(v.revision,'revision')),formatStatus:'current'}
  }
  async stat(id:SessionId,options?:SessionPersistenceStatOptions):Promise<SessionPersistenceSnapshot|undefined> {
    options?.signal?.throwIfAborted()
    const result=await this.transport.call('session_stat',{id})
    return result===null?undefined:this.snapshot(result)
  }
  async list(options?:SessionPersistenceListOptions):Promise<readonly SessionPersistenceSnapshot[]> {
    options?.signal?.throwIfAborted()
    const result=wireObject(await this.transport.call('session_list',{}),'session_list')
    if(!Array.isArray(result.sessions))throw new TypeError('session_list.sessions must be an array')
    return result.sessions.map(x=>this.snapshot(x))
  }
}
