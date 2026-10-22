import { randomUUID } from 'node:crypto'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { assertContiguous, materializeCreateHeader, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { Store } from './store.ts'
import { Identities } from './identity.ts'
import { fingerprint, integer, record, string } from './util.ts'
import { fail } from './errors.ts'
import type { RuntimeIdentity } from './types.ts'
interface Handle {id:string;connection:string;session_id:string;access:'read'|'write';identity?:RuntimeIdentity}
export interface OpenResult {handle_id:string;header:SessionHeader;inherited_event_count:number;identity?:RuntimeIdentity;event_count:number}
interface Stored {id:string;header:string;inherited_event_count:number;event_count:number}
/** Canonical host event storage and collaboration admission share this SQLite transaction owner. */
export class HostStore {
  readonly handles=new Map<string,Handle>()
  readonly writers=new Map<string,string>()
  private readonly closed=new Map<string,{fingerprint:string}>()
  private readonly opens=new Map<string,{fingerprint:string;result:OpenResult}>()
  onAdmit:(identity:RuntimeIdentity,expectedRevision:number,events:SessionEvent[])=>void=()=>{}
  constructor(readonly store:Store,readonly identities:Identities){}
  private stored(id:string):Stored {const row=this.store.db.prepare('SELECT * FROM host_sessions WHERE id=?').get(id);if(!row)fail('SESSION_NOT_FOUND','Stored host session not found.');return row as object as Stored}
  private keep(connection:string,stored:Stored,access:'read'|'write',identity?:RuntimeIdentity):OpenResult {const handle_id=randomUUID();this.handles.set(handle_id,{id:handle_id,connection,session_id:stored.id,access,identity});if(access==='write')this.writers.set(stored.id,handle_id);return{handle_id,header:JSON.parse(stored.header) as SessionHeader,inherited_event_count:stored.inherited_event_count,event_count:stored.event_count,...identity?{identity}:{}}}
  private check(connection:string,params:Record<string,unknown>,identity?:RuntimeIdentity,write=false):Handle {const handle=this.handles.get(string(params.handle_id,'handle_id'));if(!handle||handle.connection!==connection)fail('STALE_INSTANCE','Unknown or foreign persistence handle.');if(write&&handle.access!=='write')fail('PERMISSION_REQUIRED','Read-only handle cannot append or flush.');if(handle.access==='write'){if(!identity||identity.incarnation_id!==handle.identity?.incarnation_id||identity.session_id!==handle.session_id)fail('STALE_INSTANCE','Persistence identity does not own this handle.');this.store.assertIdentity(identity)}return handle}
  private priorOpen(connection:string,params:Record<string,unknown>):OpenResult|undefined {const key=connection+':'+string(params.open_request_id,'open_request_id');const prior=this.opens.get(key);if(prior&&prior.fingerprint!==fingerprint(params))fail('IDEMPOTENCY_CONFLICT','Open identifier reused for another request.');return prior?.result}
  private rememberOpen(connection:string,params:Record<string,unknown>,result:OpenResult):OpenResult {this.opens.set(connection+':'+String(params.open_request_id),{fingerprint:fingerprint(params),result});return result}
  create(connection:string,params:Record<string,unknown>):OpenResult {
    const prior=this.priorOpen(connection,params);if(prior)return prior
    const raw=record(params.header);if(raw.version!==SESSION_FORMAT_VERSION||typeof raw.isSeeded!=='boolean')fail('INVALID_ARGUMENT','Unsupported host session header.')
    const id=SessionId(string(raw.id,'header.id')),header=materializeCreateHeader({...raw,id} as object as SessionHeader)
    const inherited=params.inherited_event_count===undefined?0:integer(params.inherited_event_count,'inherited_event_count',0,Number.MAX_SAFE_INTEGER)
    if(!header.isSeeded&&inherited!==0)fail('INVALID_ARGUMENT','Unseeded host session cannot inherit events.')
    const cwd=header.cwd??string(params.workspace_root,'workspace_root')
    const result=this.store.transaction(()=>{
      if(this.store.db.prepare('SELECT 1 FROM host_sessions WHERE id=?').get(id))fail('STALE_INSTANCE','Host session already exists.',{host_error:'SessionAlreadyExistsError'})
      const identity=this.identities.register({session_id:id,cwd,project_root:typeof params.workspace_root==='string'?params.workspace_root:undefined})
      this.store.db.prepare('INSERT INTO host_sessions(id,header,inherited_event_count) VALUES(?,?,?)').run(id,JSON.stringify(header),inherited)
      return {stored:this.stored(id),identity}
    })
    // In-memory ownership must not outlive a failed outer COMMIT.
    return this.rememberOpen(connection,params,this.keep(connection,result.stored,'write',result.identity))
  }
  open(connection:string,params:Record<string,unknown>):OpenResult {
    const prior=this.priorOpen(connection,params);if(prior)return prior
    const id=string(params.id,'id'),access=params.access
    if(access!=='read'&&access!=='write')fail('INVALID_ARGUMENT','Session access must be read or write.')
    const stored=this.stored(id)
    if(access==='read')return this.rememberOpen(connection,params,this.keep(connection,stored,access))
    if(this.writers.has(id))fail('STALE_INSTANCE','Another connected host owns the session.',{host_error:'SessionAlreadyOwnedError'})
    const header=JSON.parse(stored.header) as SessionHeader,previous=this.store.session(id)
    // The daemon serializes open, checks no live handle, and uses the exact prior incarnation in the CAS.
    const identity=this.identities.register({session_id:id,cwd:header.cwd??this.store.workspace(previous.workspace_id).root,project_root:this.store.workspace(previous.workspace_id).root,expected_previous_incarnation:typeof params.expected_previous_incarnation==='string'?params.expected_previous_incarnation:previous.incarnation_id})
    return this.rememberOpen(connection,params,this.keep(connection,stored,access,identity))
  }
  read(connection:string,params:Record<string,unknown>,identity?:RuntimeIdentity):{events:SessionEvent[]} {const h=this.check(connection,params,identity);const offset=params.offset===undefined?0:integer(params.offset,'offset',0,Number.MAX_SAFE_INTEGER);const limit=params.length===undefined?Number.MAX_SAFE_INTEGER:integer(params.length,'length',0,Number.MAX_SAFE_INTEGER);const rows=this.store.db.prepare('SELECT event FROM host_events WHERE session_id=? AND seq>=? ORDER BY seq LIMIT ?').all(h.session_id,offset,limit);return{events:rows.map(row=>JSON.parse(String(row.event)) as SessionEvent)}}
  append(connection:string,params:Record<string,unknown>,identity:RuntimeIdentity):{event_count:number} {
    const handle=this.check(connection,params,identity,true),append_id=string(params.append_id,'append_id'),expected=integer(params.expected_seq,'expected_seq',0,Number.MAX_SAFE_INTEGER)
    if(!Array.isArray(params.events))fail('INVALID_ARGUMENT','events must be an array.')
    const fp=fingerprint({expected_seq:expected,events:params.events})
    return this.store.transaction(()=>{
      this.store.assertIdentity(identity)
      const prior=this.store.db.prepare('SELECT fingerprint,event_count FROM host_appends WHERE session_id=? AND append_id=?').get(handle.session_id,append_id)
      if(prior){if(prior.fingerprint!==fp)fail('IDEMPOTENCY_CONFLICT','Append identifier reused with different events.');return{event_count:Number(prior.event_count)}}
      const stored=this.stored(handle.session_id)
      if(stored.event_count!==expected)fail('CONTEXT_CONFLICT','Canonical host log advanced; do not overwrite it.',{expected_seq:expected,current_seq:stored.event_count})
      const events=validateStoredEvents(JSON.parse(stored.header) as SessionHeader,structuredClone(params.events) as SessionEvent[])
      assertContiguous(SessionId(handle.session_id),events,expected)
      for(const event of events)this.store.db.prepare('INSERT INTO host_events(session_id,seq,event) VALUES(?,?,?)').run(handle.session_id,event.seq,JSON.stringify(event))
      this.onAdmit(identity,expected,events)
      const event_count=expected+events.length
      this.store.db.prepare('UPDATE host_sessions SET event_count=? WHERE id=?').run(event_count,handle.session_id)
      this.store.db.prepare('UPDATE sessions SET context_revision=? WHERE id=?').run(event_count,handle.session_id)
      this.store.db.prepare('INSERT INTO host_appends(session_id,append_id,fingerprint,event_count) VALUES(?,?,?,?)').run(handle.session_id,append_id,fp,event_count)
      for(const event of events)if(event.type==='tool/result')this.recordToolResult(identity,event)
      return{event_count}
    })
  }
  flush(connection:string,params:Record<string,unknown>,identity?:RuntimeIdentity):{event_count:number} {const h=this.check(connection,params,identity,true);return{event_count:this.stored(h.session_id).event_count}}
  close(connection:string,params:Record<string,unknown>,identity?:RuntimeIdentity):Record<string,never> {
    const key=connection+':'+string(params.handle_id,'handle_id'),fp=fingerprint(identity??null),closed=this.closed.get(key)
    if(closed){if(closed.fingerprint!==fp)fail('STALE_INSTANCE','Closed handle replay has different credentials.');return{}}
    const h=this.check(connection,params,identity)
    // Keep retryable ownership until the revocation and its state event commit.
    if(this.writers.get(h.session_id)===h.id){const row=this.store.session(h.session_id);if(h.identity&&row.incarnation_id===h.identity.incarnation_id)this.identities.close(h.identity,['completed','failed','interrupted'].includes(row.state)?row.state:'idle')}
    this.handles.delete(h.id);if(this.writers.get(h.session_id)===h.id)this.writers.delete(h.session_id)
    this.closed.set(key,{fingerprint:fp});return{}
  }
  disconnect(connection:string):void {for(const h of [...this.handles.values()])if(h.connection===connection){try{this.close(connection,{handle_id:h.id},h.identity)}catch(error){if(h.identity)this.store.revokeInMemory(h.identity);/* Storage failure: retain the ownership barrier and deny this incarnation until coordinator recovery. */}}for(const key of this.opens.keys())if(key.startsWith(connection+':'))this.opens.delete(key);for(const key of this.closed.keys())if(key.startsWith(connection+':'))this.closed.delete(key)}
  stat(id:string):Record<string,unknown>|null {const row=this.store.db.prepare('SELECT * FROM host_sessions WHERE id=?').get(id);if(!row)return null;const stored=row as object as Stored;const session=this.store.session(id);return{header:JSON.parse(stored.header),event_count:stored.event_count,revision:`${this.store.domain}:${stored.event_count}`,previous_incarnation:session.incarnation_id,workspace_root:this.store.workspace(session.workspace_id).root}}
  list():{sessions:Record<string,unknown>[]} {const rows=this.store.db.prepare('SELECT id FROM host_sessions ORDER BY id').all();return{sessions:rows.map(row=>this.stat(String(row.id))!).filter(Boolean)}}
  prepareTool(identity:RuntimeIdentity,params:Record<string,unknown>):{operation_id:string;state:string;result:unknown} {
    this.store.assertIdentity(identity);const turn_id=string(params.turn_id,'turn_id'),tool_call_id=string(params.tool_call_id,'tool_call_id');const fp=fingerprint({tool_name:params.tool_name,arguments:params.arguments})
    return this.store.transaction(()=>{const old=this.store.db.prepare('SELECT * FROM tool_calls WHERE session_id=? AND turn_id=? AND tool_call_id=?').get(identity.session_id,turn_id,tool_call_id);if(old){if(old.fingerprint!==fp)fail('IDEMPOTENCY_CONFLICT','Logical tool call changed while outcome is pending.');return{operation_id:String(old.operation_id),state:String(old.state),result:old.result===null?null:JSON.parse(String(old.result))}}const operation_id=randomUUID();this.store.db.prepare('INSERT INTO tool_calls(session_id,turn_id,tool_call_id,fingerprint,operation_id,request,tool_name) VALUES(?,?,?,?,?,?,?)').run(identity.session_id,turn_id,tool_call_id,fp,operation_id,JSON.stringify(params.arguments),String(params.tool_name));return{operation_id,state:'prepared',result:null}})
  }
  private recordToolResult(identity:RuntimeIdentity,event:SessionEvent<'tool/result'>):void {
    const data=event.data,call_id=data.message.toolCallId
    // A persisted diagnostic is not proof that the original side effect failed.
    // Keep the operation pending across transport uncertainty as well as the
    // host's synthetic restart error, so a new model request cannot replay it.
    if(['TOOL_OUTCOME_UNKNOWN','OUTCOME_UNKNOWN','COORDINATOR_UNAVAILABLE','RESOURCE_RECOVERING'].includes(data.error?.code??''))return
    this.store.db.prepare("UPDATE tool_calls SET result=?,state='committed' WHERE session_id=? AND turn_id=? AND tool_call_id=?").run(JSON.stringify(data),identity.session_id,String(data.turn),call_id)
  }
}
