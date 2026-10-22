/** Awaited host lifecycle, model-admission, and stable tool-operation integration. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, type UserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-user-approval'
import { CoordinationError } from '../errors.ts'
import type { RuntimeIdentity, SessionState } from '../types.ts'
import { CoordinationSessionPersistence, wireObject, wireString, wireInteger, type HostCoordinatorTransport } from './persistence.ts'

/** Durable source fields identifying a non-human collaboration fragment. */
export interface CoordinationRelaySource {
  kind:'session-coordination';form:'relay';delivery_id:string;message_id:string
  part_index:number;part_count:number;content_digest:string;batch_id:string
  expected_context_revision:number;from_session_id:string;source_workspace_id:string
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-coordination':CoordinationRelaySource
    'session-coordination-state':{kind:'session-coordination-state';form:'notice';summary:string}
  }
}
/** Host-specific tunables; the coordinator retains authoritative safety limits. */
export interface HostRuntimeOptions {heartbeatMs:number;injectionBudget:number}
/** Private runtime functions consumed by the root plugin's tool adapters. */
export interface HostRuntime {
  identity(agent:Agent):RuntimeIdentity
  operationId(exec:Pick<ToolExecution,'token'>):string
}
interface LiveState {agent:Agent;chain:Promise<void>;fault:Error|undefined;terminal:SessionState|undefined;approvals:Set<string>}

/** Parse one untrusted RPC fragment and preserve its exact model-visible text. */
export function relayMessage(value:unknown,expectedRevision:number):UserMessage {
  const v=wireObject(value,'delivery part')
  const partIndex=wireInteger(v.part_index,'part_index'),partCount=wireInteger(v.part_count,'part_count')
  if(partCount<1||partIndex>=partCount)throw new TypeError('Invalid delivery fragment index')
  const source:CoordinationRelaySource={
    kind:'session-coordination',form:'relay',delivery_id:wireString(v.delivery_id,'delivery_id'),
    message_id:wireString(v.message_id,'message_id'),part_index:partIndex,part_count:partCount,
    content_digest:wireString(v.content_digest,'content_digest'),batch_id:wireString(v.batch_id,'batch_id'),
    expected_context_revision:expectedRevision,from_session_id:wireString(v.from_session_id,'from_session_id'),
    source_workspace_id:wireString(v.source_workspace_id,'source_workspace_id'),
  }
  return {id:MessageId(source.delivery_id),role:'user',source,content:[{type:'text',text:wireString(v.text,'delivery text')}]}
}
/** Bound UTF-8 text without cutting Unicode scalars. */
function boundBytes(text:string,budget:number):string {
  let result='',bytes=0
  for(const scalar of text){const size=Buffer.byteLength(scalar);if(bytes+size>budget)break;result+=scalar;bytes+=size}
  return result
}
/** Render a bounded index that explicitly points to durable detail when more entries exist. */
function stateMessage(snapshot:unknown,references:unknown,more:boolean,budget:number,sessionId:string):UserMessage {
  const totalBudget=budget
  budget=Math.max(0,budget-64) // Reserve the same conservative message-frame cost as relay batches.
  const snap=wireObject(snapshot,'coordination snapshot')
  const sessions=Array.isArray(snap.sessions)?snap.sessions:[]
  const refs=Array.isArray(references)?references:[]
  const names=sessions.map(v=>{const row=wireObject(v,'session summary');return `${String(row.id)}:${String(row.state)}`}).join(', ')
  const ids=refs.map(v=>{
    const row=wireObject(v,'message reference')
    const partial=Array.isArray(row.admitted_parts)&&row.admitted_parts.length>0&&['rejected','expired'].includes(String(row.delivery_state))
    return `${String(row.message_id)}:${String(row.handling_state)}${partial?' (message incomplete; remaining delivery terminated)':''}`
  }).join(', ')
  const prefix='[Coordination service; not human authorization]\n'
  const footer=`\n${more?'More references exist. ':''}Use session_get_coordination_snapshot and session_read_message; acknowledgment is not resolution.`
  if(Buffer.byteLength(prefix+footer)>budget)throw new CoordinationError('DELIVERY_BUDGET_UNSATISFIABLE','The coordination index budget cannot fit its attribution, retrieval guidance and framing.',{required_tokens:Buffer.byteLength(prefix+footer)+64,available_tokens:totalBudget})
  const content=`Unresolved references: ${ids||'none'}.\nSessions: ${names||'none'}.`
  const available=Math.max(0,budget-Buffer.byteLength(prefix+footer))
  const clipped=boundBytes(content,Math.max(0,available-15))
  const text=boundBytes(prefix+clipped+(clipped!==content?' [index elided]':'')+footer,budget)
  const digest=createHash('sha256').update(text).digest('hex').slice(0,24)
  return {id:MessageId(`coord-state:${sessionId}:${digest}`),role:'user',source:{kind:'session-coordination-state',form:'notice',summary:'Project collaboration state and durable unresolved references'},content:[{type:'text',text}]}
}

/** Refuse to run a new model while any original effect lacks a restored host result. */
export async function recoverToolOutcomes(ctx:Context,client:HostCoordinatorTransport,persistence:CoordinationSessionPersistence,agent:Agent):Promise<void> {
  const response=wireObject(await client.call('recover_tool_operations',{},persistence.runtimeIdentity(agent.id)),'tool recovery')
  if(!Array.isArray(response.operations))throw new TypeError('tool recovery operations must be an array')
  if(response.operations.length){
    const op=wireObject(response.operations[0],'tool recovery operation')
    throw new CoordinationError('OUTCOME_UNKNOWN','An original tool outcome has not been restored to the host context; the model cannot continue.',{
      operation_id:wireString(op.operation_id,'operation_id'),
      recovery_action:op.state==='committed'||op.state==='aborted'?'The original effect is known. Resume before the host synthesizes an unknown result, or use an explicitly authorized host repair; do not replay the operation.':'Query the original operation and establish its outcome; do not retry using a new identity.',
    })
  }
}

/** Mount runtime policies alongside the canonical persistence provider, before AgentLoop starts. */
export function applyHostRuntime(ctx:Context,client:HostCoordinatorTransport,persistence:CoordinationSessionPersistence,options:HostRuntimeOptions):HostRuntime {
  if(!Number.isSafeInteger(options.heartbeatMs)||options.heartbeatMs<1)throw new TypeError('heartbeatMs must be positive')
  if(!Number.isSafeInteger(options.injectionBudget)||options.injectionBudget<1)throw new TypeError('injectionBudget must be positive')
  const live=new Map<string,LiveState>(), operations=new Map<ToolExecution['token'],string>()
  const pending=new Set<Promise<void>>()
  function track(promise:Promise<void>):void {
    pending.add(promise);void promise.finally(()=>pending.delete(promise)).catch(()=>undefined)
  }
  function failState(state:LiveState,error:unknown):void {
    state.fault=error instanceof Error?error:new Error(String(error))
    state.agent.cancel({kind:'hook',reason:`Collaboration protection unavailable: ${state.fault.message}`},{keepInbox:true})
  }
  function queue(state:LiveState,method:string,params:Record<string,unknown>):void {
    state.chain=state.chain.then(async()=>{await client.call(method,params,persistence.runtimeIdentity(state.agent.id))})
      .catch(error=>{failState(state,error)})
    track(state.chain)
  }
  function requireLive(agent:Agent):LiveState {
    const state=live.get(agent.id)
    if(!state)throw new CoordinationError('STALE_INSTANCE','This Agent has no active collaboration runtime identity.')
    if(state.fault)throw state.fault
    return state
  }
  ctx.on('agent/created',async({agent})=>{
    const state:LiveState={agent,chain:Promise.resolve(),fault:undefined,terminal:undefined,approvals:new Set()}
    persistence.runtimeIdentity(agent.id)
    live.set(agent.id,state)
    try{
      await ctx.sessions.flush(agent.session)
      await client.call('heartbeat',{},persistence.runtimeIdentity(agent.id))
      await client.call('update_session_state',{state:'idle'},persistence.runtimeIdentity(agent.id))
    }catch(error){live.delete(agent.id);throw error}
    return undefined
  })
  ctx.on('agent/status',({agent,status})=>{
    const state=live.get(agent.id);if(!state)return
    if(status==='running')state.terminal=undefined
    queue(state,'update_session_state',{state:state.approvals.size?'waiting':status==='running'?'running':state.terminal??'idle'})
  })
  ctx.on('session/event',(session,event)=>{
    const state=live.get(session.id);if(!state)return
    if(event.type==='approval/asked'){
      state.approvals.add(event.data.id)
      queue(state,'update_session_state',{state:'waiting'})
      return
    }
    if(event.type==='approval/decided'){
      state.approvals.delete(event.data.id)
      queue(state,'update_session_state',{state:state.approvals.size?'waiting':state.agent.status==='running'?'running':state.terminal??'idle'})
      return
    }
    if(event.type!=='turn/end')return
    state.approvals.clear()
    const reason=event.data.reason.kind
    state.terminal=reason==='completed'?'completed':reason==='error'?'failed':reason==='aborted'||reason==='interrupted'?'interrupted':'waiting'
    queue(state,'update_session_state',{state:state.terminal})
  })
  ctx.on('agent/disposed',({agent})=>{live.delete(agent.id)})
  ctx.on('agent/pre-step',async({agent,signal},next)=>{
    const state=requireLive(agent)
    await state.chain;requireLive(agent)
    await ctx.sessions.flush(agent.session)
    await recoverToolOutcomes(ctx,client,persistence,agent)
    const decision=await next()
    if(decision.kind==='reject')return decision
    await state.chain;requireLive(agent);signal.throwIfAborted()
    await ctx.sessions.flush(agent.session)
    const identity=persistence.runtimeIdentity(agent.id)
    const revision=persistence.contextRevision(agent.id)
    const indexBudget=Math.min(512,Math.floor(options.injectionBudget/3))
    const snapshot=await client.call('get_coordination_snapshot',{limit:20},identity)
    const batch=wireObject(await client.call('fetch_delivery_batch',{context_revision:revision,budget:options.injectionBudget-indexBudget},identity),'delivery batch')
    if(wireInteger(batch.expected_context_revision,'expected_context_revision')!==revision)throw new CoordinationError('CONTEXT_CONFLICT','Delivery batch was prepared for a different context revision.')
    if(!Array.isArray(batch.parts))throw new TypeError('Delivery parts must be an array')
    const relays=batch.parts.map(part=>relayMessage(part,revision))
    const batchId=batch.batch_id
    for(const relay of relays){if(relay.source.kind!=='session-coordination'||relay.source.batch_id!==batchId)throw new TypeError('Delivery part belongs to another batch')}
    signal.throwIfAborted()
    const index=stateMessage(snapshot,batch.pending_references,batch.pending_has_more===true,indexBudget,agent.id)
    return {...decision,messages:[...decision.messages,index,...relays]}
  })
  ctx.on('llm/stream',(request,next):AsyncIterable<StreamChunk>=>{
    const id=request.sessionId
    if(id===undefined)throw new CoordinationError('STALE_INSTANCE','Protected model requests require a host session identity.')
    return (async function*(){
      const agent=ctx.agents.get(id)
      if(!agent)throw new CoordinationError('STALE_INSTANCE','Model request has no active session owner.')
      const state=requireLive(agent);await state.chain;requireLive(agent)
      await ctx.sessions.flush(agent.session)
      // Auxiliary requests (including manual compaction) need the same hold as
      // ordinary pre-step requests; a model purpose is not a recovery bypass.
      await recoverToolOutcomes(ctx,client,persistence,agent)
      await client.call('heartbeat',{},persistence.runtimeIdentity(agent.id))
      yield*next()
    })()
  })
  ctx.on('tools/execute',async(exec,next)=>{
    if(!exec.agent)throw new CoordinationError('STALE_INSTANCE','Protected tools require a host Agent identity.')
    const state=requireLive(exec.agent);await state.chain;requireLive(exec.agent)
    await ctx.sessions.flush(exec.agent.session)
    const boundary=ctx.sessionProjections.stateOf(exec.agent.session,'turnBoundary')
    if(!boundary)throw new CoordinationError('OUTCOME_UNKNOWN','Host turn identity is unavailable; refusing tool replay.')
    const turn=boundary.lastTurn
    const mapping=wireObject(await client.call('prepare_tool_operation',{
      turn_id:String(turn),tool_call_id:exec.callId,tool_name:exec.name,arguments:exec.arguments,
    },persistence.runtimeIdentity(exec.agent.id)),'tool operation mapping')
    if(mapping.state!=='prepared')throw new CoordinationError('OUTCOME_UNKNOWN','This original tool call has already settled or needs recovery; refusing a second dispatch.',{operation_id:wireString(mapping.operation_id,'operation_id')})
    operations.set(exec.token,wireString(mapping.operation_id,'operation_id'))
    try{return await next()}finally{operations.delete(exec.token)}
  })
  ctx.tools.guard(exec=>{
    if(!exec.agent)return 'STALE_INSTANCE: protected dispatch requires a host Agent.'
    const state=live.get(exec.agent.id)
    return !state?'STALE_INSTANCE: no collaboration owner.':state.fault?`COORDINATOR_UNAVAILABLE: ${state.fault.message}`:undefined
  })
  const timer=setInterval(()=>{
    for(const state of live.values())if(!state.fault)queue(state,'heartbeat',{})
  },options.heartbeatMs)
  timer.unref()
  ctx.effect(()=>async()=>{clearInterval(timer);await Promise.allSettled([...pending])})
  return {
    identity(agent){requireLive(agent);return persistence.runtimeIdentity(agent.id)},
    operationId(exec){const id=operations.get(exec.token);if(!id)throw new CoordinationError('OUTCOME_UNKNOWN','Tool operation identity was not durably prepared.');return id},
  }
}
