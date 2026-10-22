import { join } from 'node:path'
import { Store } from './store.ts'
import { Identities } from './identity.ts'
import { HostStore } from './host-store.ts'
import { Messaging } from './messaging.ts'
import { Writer } from './writer.ts'
import {reserveHostStateRoots} from './host-state.ts'
import {COOPERATION_PROTOCOL} from './protocol.ts'
import type { Config, RuntimeIdentity, SessionState } from './types.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CoordinationError, fail, success, failure } from './errors.ts'
import { record, string, integer } from './util.ts'
/** Private daemon composition; not a second agent loop or a standalone Harness application. */
export class Coordinator {
  readonly store:Store;readonly identities:Identities;readonly host:HostStore;readonly messaging:Messaging;readonly writer:Writer
  readonly config:Config
  constructor(config:Config){
    this.config=config;this.store=new Store(join(config.data_dir,'coordinator.sqlite'))
    try{
      // Validate global state-root exclusions before any persisted writer recovery.
      this.identities=new Identities(this.store,config);this.host=new HostStore(this.store,this.identities)
      this.messaging=new Messaging(this.store,config);this.messaging.recover();this.writer=new Writer(this.store,config);this.writer.recoverAll()
      this.host.onAdmit=(identity,revision,events)=>this.admit(identity,revision,events)
    }catch(error){this.store.close();throw error}
  }
  private admit(identity:RuntimeIdentity,revision:number,events:SessionEvent[]):void {
    const groups=new Map<string,{delivery_id:string;context_record_id:string;text:string}[]>()
    for(const event of events){if(event.type!=='user/message')continue;const data=event.data;const source=record(data.source);if(source.kind!=='session-coordination')continue;const batch=string(source.batch_id,'batch_id');const receipts=groups.get(batch)??[];const block=data.content[0];if(!block||block.type!=='text')fail('CONTEXT_CONFLICT','Collaboration message must contain exact text evidence.');receipts.push({delivery_id:string(source.delivery_id,'delivery_id'),context_record_id:String(data.id),text:block.text});groups.set(batch,receipts)}
    for(const [batch_id,receipts]of groups)this.messaging.admitParts(identity,{batch_id,expected_context_revision:revision,receipts})
  }
  private configuredGrant(identity:RuntimeIdentity|undefined):void {if(!identity||this.config.communication_policy!=='same_project_enabled')return;const project_id=this.store.session(identity.session_id).project_id;this.messaging.grant({project_id,grant_id:'configured-project:'+project_id})}
  private identity(value:RuntimeIdentity|undefined):RuntimeIdentity {if(!value)fail('STALE_INSTANCE','A private runtime identity is required.');this.store.assertIdentity(value);return value}
  async dispatch(connection:string,method:string,params:Record<string,unknown>,value?:RuntimeIdentity):Promise<unknown> {
    switch(method){
      case 'reserve_host_state_roots':{if(value!==undefined)fail('PERMISSION_REQUIRED','Host-state reservation is trusted runtime setup, not an agent/session operation.');return reserveHostStateRoots(this.store,params)}
      case 'ping':return{cooperation_protocol:COOPERATION_PROTOCOL,coordinator_epoch:this.store.epoch,coordinator_domain:this.store.domain,protected_mode:'host-enforcement-pending',pid:process.pid}
      case 'session_create':{const result=this.host.create(connection,params);this.configuredGrant(result.identity);return result}
      case 'session_open':{const result=this.host.open(connection,params);this.configuredGrant(result.identity);return result}
      case 'session_read':return this.host.read(connection,params,value)
      case 'session_append':return this.host.append(connection,params,this.identity(value))
      case 'session_flush':return this.host.flush(connection,params,value)
      case 'session_close':{if(value&&this.host.handles.has(String(params.handle_id)))this.writer.releaseSession(value);return this.host.close(connection,params,value)}
      case 'session_stat':return this.host.stat(string(params.id,'id'))
      case 'session_list':return this.host.list()
      case 'register_session':{const id=this.identities.register(params as object as Parameters<Identities['register']>[0]);this.configuredGrant(id);return id}
      case 'heartbeat':return this.identities.heartbeat(this.identity(value))
      case 'update_session_state':{const id=this.identity(value);const state=string(params.state,'state') as SessionState;const result=this.identities.update(id,state,typeof params.task_summary==='string'?params.task_summary:undefined);if(['idle','waiting','completed','failed','interrupted'].includes(state))this.writer.releaseSession(id);return result}
      case 'close_session':{const id=this.identity(value);this.writer.releaseSession(id);return this.identities.close(id,typeof params.reason==='string'?params.reason as SessionState:'interrupted')}
      case 'list_sessions':return this.identities.list(this.identity(value),params as Parameters<Identities['list']>[1])
      case 'get_session_status':{const id=this.identity(value);const result=this.identities.status(id,string(params.session_id,'session_id'));const s=result.session;const now=this.store.clock.monotonic();return{...result,file_activity:this.store.db.prepare("SELECT l.resource_key AS path,l.owner_session_id,l.expires_at FROM writer_leases l JOIN sessions o ON o.id=l.owner_session_id AND o.incarnation_id=l.owner_incarnation_id AND o.execution_epoch=l.execution_epoch AND o.owner_epoch=l.coordinator_epoch AND o.deleted=0 AND o.state IN ('starting','running') WHERE l.workspace_id=? AND l.owner_session_id=? AND l.active=1 AND l.coordinator_epoch=? AND l.expires_mono>?").all(s.workspace_id,s.id,this.store.epoch,now)}}
      case 'send_message':return this.messaging.send(this.identity(value),params)
      case 'get_message_status':return this.messaging.status(this.identity(value),string(params.message_id,'message_id'))
      case 'read_message':return this.messaging.read(this.identity(value),params)
      case 'mark_message_handled':return this.messaging.markHandled(this.identity(value),params)
      case 'fetch_delivery_batch':return this.messaging.fetchBatch(this.identity(value),{context_revision:integer(params.context_revision,'context_revision',0,Number.MAX_SAFE_INTEGER),budget:integer(params.budget,'budget',1,1000000)})
      case 'poll_events':return this.messaging.poll(this.identity(value),params)
      case 'get_coordination_snapshot':return this.messaging.snapshot(this.identity(value),params)
      case 'claim_files':return this.writer.claimFiles(this.identity(value),params as object as Parameters<Writer['claimFiles']>[1])
      case 'release_files':return this.writer.releaseFiles(this.identity(value),params as object as Parameters<Writer['releaseFiles']>[1])
      case 'renew_claims':return this.writer.renewClaims(this.identity(value),params as object as Parameters<Writer['renewClaims']>[1])
      case 'read_file':return this.writer.readFile(this.identity(value),params as object as Parameters<Writer['readFile']>[1])
      case 'apply_file_change':return this.writer.applyFileChange(this.identity(value),params as object as Parameters<Writer['applyFileChange']>[1])
      case 'get_mutation_status':return this.writer.mutationStatus(this.identity(value),{mutation_id:string(params.mutation_id,'mutation_id')})
      case 'reconcile_mutation':return this.writer.reconcile(this.identity(value),{mutation_id:string(params.mutation_id,'mutation_id')})
      case 'prepare_tool_operation':return this.host.prepareTool(this.identity(value),params)
      case 'recover_tool_operations':return this.recoverTools(this.identity(value))
      case 'grant_communication':return this.messaging.grant(params as object as Parameters<Messaging['grant']>[0])
      case 'revoke_communication':{const grant=string(params.grant_id,'grant_id');this.messaging.beginRevoke(grant);return this.messaging.finishRevoke(grant)}
      default:fail('UNMEDIATED_WRITE_DENIED','The coordinator does not expose this operation; there is no raw execution fallback.',{method})
    }
  }
  private recoverTools(identity:RuntimeIdentity):{operations:unknown[]} {
    const rows=this.store.db.prepare("SELECT * FROM tool_calls WHERE session_id=? AND state='prepared' ORDER BY turn_id,tool_call_id").all(identity.session_id)
    return{operations:rows.map(row=>{
      const unknown=this.store.db.prepare("SELECT seq,event FROM host_events WHERE session_id=? AND json_extract(event,'$.type')='tool/result' AND json_extract(event,'$.data.error.code') IN ('TOOL_OUTCOME_UNKNOWN','OUTCOME_UNKNOWN','COORDINATOR_UNAVAILABLE','RESOURCE_RECOVERING') AND json_extract(event,'$.data.message.toolCallId')=? AND CAST(json_extract(event,'$.data.turn') AS TEXT)=? ORDER BY seq DESC LIMIT 1").get(identity.session_id,String(row.tool_call_id),String(row.turn_id))
      const call=this.store.db.prepare("SELECT seq,event FROM host_events WHERE session_id=? AND json_extract(event,'$.type')='tool/call' AND json_extract(event,'$.data.callId')=? AND CAST(json_extract(event,'$.data.turn') AS TEXT)=? ORDER BY seq DESC LIMIT 1").get(identity.session_id,String(row.tool_call_id),String(row.turn_id))
      const callData=call?record(record(JSON.parse(String(call.event))).data):undefined
      const hasResult=this.store.db.prepare("SELECT 1 FROM host_events WHERE session_id=? AND json_extract(event,'$.type')='tool/result' AND json_extract(event,'$.data.message.toolCallId')=? AND CAST(json_extract(event,'$.data.turn') AS TEXT)=? AND COALESCE(json_extract(event,'$.data.error.code'),'') NOT IN ('TOOL_OUTCOME_UNKNOWN','OUTCOME_UNKNOWN','COORDINATOR_UNAVAILABLE','RESOURCE_RECOVERING') LIMIT 1").get(identity.session_id,String(row.tool_call_id),String(row.turn_id))!==undefined
      const base={operation_id:String(row.operation_id),tool_call_id:String(row.tool_call_id),turn_id:String(row.turn_id),unknown_result_seq:unknown?Number(unknown.seq):null,step:callData?Number(callData.step):0,call_seq:call?Number(call.seq):null,tool_name:String(row.tool_name),has_result:hasResult}
      const mutation=this.writer.mutationStatus(identity,{mutation_id:String(row.operation_id)})
      if(mutation.state==='committed')return{...base,state:'committed',result:success(mutation.original_result,String(row.operation_id))}
      if(mutation.state==='aborted')return{...base,state:'aborted',result:failure(new CoordinationError('OPERATION_ABORTED','Original mutation was aborted and cannot be replayed.'),String(row.operation_id))}
      if(String(row.tool_name).endsWith('send_message')){
        let args:Record<string,unknown>={};try{const raw=JSON.parse(String(row.request));args=record(typeof raw==='string'?JSON.parse(raw):raw)}catch(error){return{...base,state:'unknown'}}
        try {
          const original=this.messaging.originalSendOutcome(identity,args)
          if(original)return{...base,state:'committed',result:success(original,String(row.operation_id))}
        }catch(error){
          // Only failures determined by the immutable original request are known
          // results. Storage faults and uncertain historical existence stay unknown.
          if(error instanceof CoordinationError&&['INVALID_ARGUMENT','PAYLOAD_TOO_LARGE','IDEMPOTENCY_CONFLICT','CROSS_PROJECT_DENIED'].includes(error.code))return{...base,state:'aborted',result:failure(error,String(row.operation_id))}
          return{...base,state:'unknown'}
        }
      }
      return{...base,state:'unknown'}
    })}
  }
  disconnect(connection:string):void {for(const h of this.host.handles.values())if(h.connection===connection&&h.identity){try{this.writer.releaseSession(h.identity)}catch(error){/* Stale identities have no active lease authority. */}}this.host.disconnect(connection)}
  close():void{this.store.close()}
}
