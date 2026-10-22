/** Recovery at the supported pre-resume persistence boundary. */
import { MessageId,ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq,type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { RuntimeIdentity } from '../types.ts'
import { CoordinationError } from '../errors.ts'
import { wireObject,wireInteger,wireString,type HostCoordinatorTransport } from './persistence.ts'

/** Materialize only a coordinator-confirmed original Result, retaining its request identity. */
function resultData(operation:Record<string,unknown>,call:SessionEvent<'tool/call'>):SessionEvent<'tool/result'>['data'] {
  const operationId=wireString(operation.operation_id,'operation_id')
  const result=wireObject(operation.result,'original tool result')
  if(result.status!=='success'&&result.status!=='warning'&&result.status!=='error')throw new TypeError('Invalid original tool result status')
  wireString(result.request_id,'original request_id')
  if(operation.state==='aborted'&&result.status!=='error')throw new TypeError('An aborted operation cannot have a successful result')
  const isError=result.status==='error',error=isError?wireObject(result.error,'original error'):undefined
  const callId=ToolCallId(call.data.callId)
  return {turn:call.data.turn,step:call.data.step,message:{
    id:MessageId(`coord-recovered:${operationId}`),role:'tool',toolCallId:callId,source:{kind:'tool',callId},isError,
    content:[{type:'text',text:JSON.stringify(result)}],
  },...error?{error:{name:'CoordinationError',code:wireString(error.code,'error.code')}}:{}}
}

/**
 * Before AgentLoop adds its synthetic closers, admit the known original effect
 * as an ordinary result of the same recorded call. Never re-execute the body.
 * Already-synthesized unknown results cannot change their error metadata in the
 * pinned host: leave those untouched and let the model gate report the limit.
 */
export async function restorePendingToolResults(handle:SessionHandle,client:HostCoordinatorTransport,identity:RuntimeIdentity):Promise<void> {
  const response=wireObject(await client.call('recover_tool_operations',{},identity),'tool recovery')
  if(!Array.isArray(response.operations))throw new TypeError('tool recovery operations must be an array')
  if(response.operations.length===0)return
  const events=(await handle.read()).events
  const repair:SessionEvent<'tool/result'>[]=[]
  for(const value of response.operations){
    const op=wireObject(value,'tool recovery operation')
    if(op.state!=='committed'&&op.state!=='aborted')continue
    // A durable synthetic unknown is not silently relabeled as successful.
    if(op.unknown_result_seq!==-1&&op.unknown_result_seq!==null&&op.unknown_result_seq!==undefined)continue
    const operationId=wireString(op.operation_id,'operation_id')
    const callSeq=wireInteger(op.call_seq,'call_seq'),callId=wireString(op.tool_call_id,'tool_call_id')
    const call=events[callSeq]
    if(!call||call.type!=='tool/call'||call.data.callId!==callId||String(call.data.turn)!==wireString(op.turn_id,'turn_id')||call.data.step!==wireInteger(op.step,'step'))throw new CoordinationError('OUTCOME_UNKNOWN','Recovery does not identify the original recorded host call.',{operation_id:operationId})
    if(events.some(e=>e.type==='tool/result'&&e.data.turn===call.data.turn&&e.data.message.toolCallId===callId))throw new CoordinationError('OUTCOME_UNKNOWN','This call already has a durable result; refusing a second result.',{operation_id:operationId})
    const lastBoundary=[...events].reverse().find(e=>e.type==='turn/start'||e.type==='turn/end')
    if(lastBoundary?.type!=='turn/start'||lastBoundary.data.turn!==call.data.turn)throw new CoordinationError('OUTCOME_UNKNOWN','The original call is no longer in an open tail turn.',{operation_id:operationId})
    repair.push({type:'tool/result',seq:SessionSeq(events.length+repair.length),time:Date.now(),data:resultData(op,call),surfaceOp:'append',sourceEventSeqs:[call.seq]})
  }
  if(repair.length){await handle.append(repair);await handle.flush()}
}
