/** In-process component integration: actual upstream loop + actual SQLite core.
 * This is NOT a substitute transport or a two-real-process acceptance claim.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime,{LlmAdapter,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import SessionStore,{SessionId} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Coordinator } from '../../src/coordinator.ts'
import { resolveConfig } from '../../src/config.ts'
import { conservativeTokenCost } from '../../src/messaging.ts'
import { CoordinationSessionPersistence,wireObject,wireString } from '../../src/host/persistence.ts'
import { applyHostRuntime } from '../../src/host/runtime.ts'
import type {RuntimeIdentity} from '../../src/types.ts'

class KeylessAdapter extends LlmAdapter {
  requests:GenerateOptions[]=[]
  constructor(readonly beforeModel:(request:GenerateOptions)=>void){super()}
  async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
  async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
    this.beforeModel(request);this.requests.push(request)
    yield {type:'block-start',index:0,blockType:'text'}
    yield {type:'text-delta',index:0,text:'ack'}
    yield {type:'block-end',index:0,block:{type:'text',text:'ack'}}
    yield {type:'finish',reason:{kind:'stop'}}
  }
}
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'dsh-real-loop-')),root=join(dir,'project');mkdirSync(root)
  const coordinator=new Coordinator(resolveConfig({data_dir:join(dir,'state'),communication_policy:'same_project_enabled'}))
  const ctx=new Context(),calls:string[]=[],control:{afterFetch?:(result:unknown,identity:RuntimeIdentity|undefined)=>Promise<void>}={}
  const client={async call(method:string,params:Record<string,unknown>={},identity?:RuntimeIdentity):Promise<unknown>{
    calls.push(method)
    const result=await coordinator.dispatch('in-process-test-fixture',method,params,identity)
    if(method==='fetch_delivery_batch')await control.afterFetch?.(result,identity)
    return result
  }}
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt,{personaPrefix:'Keyless integration fixture'});await ctx.plugin(ToolRuntime,{mode:'native'});await ctx.plugin(AgentRegistry)
  const persistence=new CoordinationSessionPersistence(ctx,client,{workspaceRoot:root})
  applyHostRuntime(ctx,client,persistence,{heartbeatMs:60000,injectionBudget:2000})
  await ctx.plugin(AgentLoop,{agents:[]})
  const priorSeq=new Map<string,number>(),costs:number[]=[]
  const adapter=new KeylessAdapter(request=>{
    let cost=0
    const sessionId=request.sessionId!
    const rows=coordinator.store.db.prepare('SELECT seq,event FROM host_events WHERE session_id=? AND seq>=? ORDER BY seq').all(sessionId,priorSeq.get(sessionId)??0)
    for(const row of rows){
      const event=JSON.parse(String(row.event))
      priorSeq.set(sessionId,Number(row.seq)+1)
      if(event.type!=='user/message')continue
      const message=event.data
      if(message.source.kind!=='session-coordination'&&message.source.kind!=='session-coordination-state')continue
      const text=message.content.map((b:{type:string;text?:string})=>b.type==='text'?b.text:'').join('')
      cost+=conservativeTokenCost(text)
      if(message.source.kind==='session-coordination'){
        assert.ok(request.messages.some(m=>m.id===message.id),'durable relay must be in the actual model request')
        const ledger=coordinator.store.db.prepare('SELECT * FROM context_deliveries WHERE delivery_id=?').get(message.source.delivery_id)
        assert.ok(ledger,'the same actual delivery must already have atomic admission evidence')
      }
    }
    costs.push(cost);assert.ok(cost<=2000,`new coordination cost ${cost} exceeds 2000`)
  })
  ctx.llm.registerAdapter(['keyless'],adapter)
  const a=await ctx.agentLoop.create(SessionId('a'),{provider:'keyless',model:'fixture'},{cwd:root})
  const b=await ctx.agentLoop.create(SessionId('b'),{provider:'keyless',model:'fixture'},{cwd:root})
  return {coordinator,ctx,client,persistence,adapter,a,b,calls,costs,control,async close(ignoreFailedDrain=false){try{await ctx.fiber.dispose()}catch(error){if(!ignoreFailedDrain)throw error}finally{coordinator.close();rmSync(dir,{recursive:true,force:true})}}}
}
function prompt(text:string){return createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})}

test('M01 M02 actual AgentLoop and SQLite admit relay + ledger atomically while idle never wakes',async()=>{
  const f=await fixture()
  try{
    const a=f.persistence.runtimeIdentity(f.a.id)
    const sent=wireObject(await f.client.call('send_message',{to_session_id:'b',body:'Please use interface v2.',idempotency_key:'interface-v2'},a),'sent')
    assert.equal(sent.delivery_state,'queued');assert.equal(f.b.status,'idle');assert.equal(f.adapter.requests.length,0)
    f.b.followup(prompt('resume'));await f.b.whenIdle()
    assert.equal(f.adapter.requests.length,1)
    const status=wireObject(await f.client.call('get_message_status',{message_id:sent.message_id},a),'status')
    assert.equal(status.delivery_state,'delivered');assert.equal(status.handling_state,'pending')
    assert.equal(f.adapter.requests[0]!.messages.some(m=>m.source.kind==='session-coordination'),true)
    f.b.followup(prompt('continue'));await f.b.whenIdle()
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM context_deliveries').get()!.n,1)
  }finally{await f.close()}
})

test('M14 actual model boundaries drain a large Unicode message under total framing-inclusive budget',async()=>{
  const f=await fixture()
  try{
    const body='协作😀'.repeat(700),a=f.persistence.runtimeIdentity(f.a.id)
    const sent=wireObject(await f.client.call('send_message',{to_session_id:'b',body,idempotency_key:'unicode'},a),'sent')
    let delivered=false
    for(let boundary=0;boundary<30&&!delivered;boundary++){
      f.b.followup(prompt(`boundary ${boundary}`));await f.b.whenIdle()
      const status=wireObject(await f.client.call('get_message_status',{message_id:sent.message_id},a),'status')
      delivered=status.delivery_state==='delivered'
    }
    assert.equal(delivered,true);assert.ok(f.adapter.requests.length>1)
    const messageId=wireString(sent.message_id,'message_id')
    const parts=f.coordinator.store.db.prepare('SELECT body_part FROM message_parts WHERE message_id=? ORDER BY part_index').all(messageId)
    assert.equal(parts.map(p=>p.body_part).join(''),body)
    const counts=f.coordinator.store.db.prepare('SELECT COUNT(*) n,COUNT(DISTINCT delivery_id) d FROM context_deliveries WHERE message_id=?').get(messageId)!
    assert.equal(counts.n,parts.length);assert.equal(counts.d,parts.length)
    assert.ok(f.costs.every(cost=>cost<=2000))
  }finally{await f.close()}
})


test('M18 revocation between actual pre-step fetch and canonical append prevents model admission',async()=>{
  const f=await fixture()
  try{
    const a=f.persistence.runtimeIdentity(f.a.id)
    const sent=wireObject(await f.client.call('send_message',{to_session_id:'b',body:'Revoked before admission.',idempotency_key:'revoke'},a),'sent')
    f.control.afterFetch=async()=>{
      f.control.afterFetch=undefined
      const project=f.coordinator.store.session('b').project_id
      await f.client.call('revoke_communication',{grant_id:`configured-project:${project}`})
    }
    f.b.followup(prompt('resume'));await f.b.whenIdle()
    assert.equal(f.adapter.requests.length,0)
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM context_deliveries').get()!.n,0)
    assert.equal(f.coordinator.store.db.prepare("SELECT COUNT(*) n FROM host_events WHERE json_extract(event,'$.data.source.kind')='session-coordination'").get()!.n,0)
    const status=wireObject(await f.client.call('get_message_status',{message_id:sent.message_id},a),'status')
    assert.equal(status.delivery_state,'rejected')
  }finally{await f.close(true)}
})
