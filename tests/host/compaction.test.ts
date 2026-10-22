/**
 * In-process pinned-host compaction regressions: real AgentLoop, BasicCompactionEngine,
 * TokenMeter, canonical SQLite events and delivery ledger. The controlled LlmAdapter
 * produces local text only; direct coordinator dispatch is a component seam, not an
 * alternative transport or two-process/installed-profile acceptance claim.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime,{LlmAdapter,createUserMessage,type GenerateOptions,type RequestMessage,type StreamChunk} from '@deepseek-ai/dsh-llm'
import SessionStore,{SessionId,type SessionEvent} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import {Coordinator} from '../../src/coordinator.ts'
import {resolveConfig} from '../../src/config.ts'
import {CoordinationSessionPersistence,wireObject,wireString} from '../../src/host/persistence.ts'
import {applyHostRuntime} from '../../src/host/runtime.ts'
import type {RuntimeIdentity} from '../../src/types.ts'

const SUMMARY='Earlier ordinary discussion was condensed. Continue from current durable coordination state.'
const HISTORY='Ordinary background details to compact without erasing the durable coordination ledger. '.repeat(120)
function textOf(message:Pick<RequestMessage,'content'>):string{return message.content.map(block=>block.type==='text'?block.text:'').join('')}
function prompt(text:string){return createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})}
class CompactionAdapter extends LlmAdapter {
  requests:GenerateOptions[]=[]
  async resolveModel(provider:string,model:string){return{provider,id:model,name:model,context:{contextWindow:100_000}}}
  async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
    this.requests.push(request)
    const text=request.purpose==='compaction'?SUMMARY:'Ordinary turn finished; unresolved coordination remains unresolved.'
    yield{type:'block-start',index:0,blockType:'text'}
    yield{type:'block-end',index:0,block:{type:'text',text}}
    yield{type:'finish',reason:{kind:'stop'}}
  }
  get conversation(){return this.requests.filter(request=>request.purpose!=='compaction')}
  get summaries(){return this.requests.filter(request=>request.purpose==='compaction')}
}
async function mount(coordinator:Coordinator,root:string,connection:string){
  const ctx=new Context()
  const client={async call(method:string,params:Record<string,unknown>={},identity?:RuntimeIdentity):Promise<unknown>{return coordinator.dispatch(connection,method,params,identity)}}
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt,{personaPrefix:'Pinned-host local compaction fixture'})
  await ctx.plugin(ToolRuntime,{mode:'native'});await ctx.plugin(AgentRegistry)
  const persistence=new CoordinationSessionPersistence(ctx,client,{workspaceRoot:root})
  applyHostRuntime(ctx,client,persistence,{heartbeatMs:60000,injectionBudget:2000})
  await ctx.plugin(TokenMeter)
  // The actual pinned implementation calls its ordinary summarizer through
  // ctx.llm.stream; there is no summarize override or hand-built replacement.
  await ctx.plugin(BasicCompactionEngine,{auto:false,maxTokens:128,compactionRetries:0})
  await ctx.plugin(AgentLoop,{agents:[]})
  const adapter=new CompactionAdapter();ctx.llm.registerAdapter(['keyless'],adapter)
  return{ctx,client,persistence,adapter}
}
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'dsh-compaction-coordination-')),root=join(dir,'project');mkdirSync(root)
  const coordinator=new Coordinator(resolveConfig({data_dir:join(dir,'state'),communication_policy:'same_project_enabled'}))
  const current=await mount(coordinator,root,'initial-in-process-fixture')
  const a=await current.ctx.agentLoop.create(SessionId('a'),{provider:'keyless',model:'fixture'},{cwd:root})
  const b=await current.ctx.agentLoop.create(SessionId('b'),{provider:'keyless',model:'fixture'},{cwd:root})
  return{...current,coordinator,root,a,b,async close(){try{await current.ctx.fiber.dispose()}finally{coordinator.close();rmSync(dir,{recursive:true,force:true})}}}
}
function storedEvents(coordinator:Coordinator):SessionEvent[]{return coordinator.store.db.prepare('SELECT event FROM host_events WHERE session_id=? ORDER BY seq').all('b').map(row=>JSON.parse(String(row.event))as SessionEvent)}
function ledger(coordinator:Coordinator,messageId:string){return coordinator.store.db.prepare('SELECT * FROM context_deliveries WHERE message_id=? ORDER BY part_index').all(messageId)}
async function prepareCompacted(f:Awaited<ReturnType<typeof fixture>>){
  const sent=wireObject(await f.client.call('send_message',{to_session_id:'b',body:'Keep interface contract revision 3 pending until explicitly resolved.',idempotency_key:'pending-through-compaction'},f.persistence.runtimeIdentity(f.a.id)),'sent')
  const messageId=wireString(sent.message_id,'message_id')
  f.b.followup(prompt(HISTORY));await f.b.whenIdle();await f.ctx.sessions.flush(f.b.session)
  assert.equal(f.adapter.conversation.length,1)
  const before=storedEvents(f.coordinator)
  const relay=before.find(event=>event.type==='user/message'&&event.data.source.kind==='session-coordination')
  assert.ok(relay&&relay.type==='user/message');assert.equal(relay.data.source.kind,'session-coordination')
  const ack=wireObject(await f.client.call('mark_message_handled',{message_id:messageId,action:'acknowledge'},f.persistence.runtimeIdentity(f.b.id)),'ack')
  assert.equal(ack.handling_state,'acknowledged')
  const evidence=ledger(f.coordinator,messageId);assert.equal(evidence.length,1)
  const compacted=await f.ctx.compaction.compactNow(f.b,new AbortController().signal)
  assert.ok(compacted,'actual compaction must replace a useful range, not silently no-op')
  assert.ok(compacted.shadowedSeqs.includes(relay.seq),'the delivered relay itself must leave the active surface')
  assert.equal(f.adapter.summaries.length,1,'the actual default summarizer must use the LLM seam exactly once')
  assert.ok(f.adapter.summaries[0]!.messages.some(message=>textOf(message).includes(messageId)),'summary input must include the old coordination surface')
  assert.ok(!SUMMARY.includes(messageId),'the controlled summary intentionally omits the coordination reference')
  const active=f.b.session.deriveMessages()
  assert.ok(active.some(message=>message.source.kind==='compact-checkpoint'))
  assert.ok(!active.some(message=>message.source.kind==='session-coordination'))
  assert.ok(!active.some(message=>textOf(message).includes(messageId)),'reference must be reconstructed from durable state, not copied from the summary')
  const events=storedEvents(f.coordinator)
  assert.ok(events.some(event=>event.type==='compaction/summary'&&event.seq===compacted.summarySeq))
  assert.ok(events.some(event=>event.type==='compaction/end'&&event.seq===compacted.endSeq))
  assert.deepEqual(ledger(f.coordinator,messageId),evidence)
  return{messageId,evidence,compacted,oldEventCount:events.length,active}
}
function assertFreshReference(request:GenerateOptions,messageId:string){
  const indices=request.messages.filter(message=>message.source?.kind==='session-coordination-state')
  assert.equal(indices.length,1,'only the freshly rebuilt state index should be active after compaction')
  assert.ok(textOf(indices[0]!).includes(`${messageId}:acknowledged`),'acknowledgment is not resolution')
  assert.ok(textOf(indices[0]!).includes('not human authorization'))
  assert.ok(!request.messages.some(message=>message.source?.kind==='session-coordination'),'delivered body must not be re-injected')
  assert.ok(request.messages.some(message=>message.source?.kind==='compact-checkpoint'))
}

test('M05 actual pinned compaction rebuilds an acknowledged unresolved reference without duplicate delivery',async()=>{
  const f=await fixture()
  try{
    const saved=await prepareCompacted(f)
    f.b.followup(prompt('Continue after compaction.'));await f.b.whenIdle();await f.ctx.sessions.flush(f.b.session)
    assert.equal(f.adapter.conversation.length,2)
    assertFreshReference(f.adapter.conversation[1]!,saved.messageId)
    const newEvents=storedEvents(f.coordinator).slice(saved.oldEventCount)
    assert.equal(newEvents.filter(event=>event.type==='user/message'&&event.data.source.kind==='session-coordination-state').length,1)
    assert.deepEqual(ledger(f.coordinator,saved.messageId),saved.evidence)
    assert.equal(storedEvents(f.coordinator).filter(event=>event.type==='user/message'&&event.data.source.kind==='session-coordination').length,1)
    const status=wireObject(await f.client.call('get_message_status',{message_id:saved.messageId},f.persistence.runtimeIdentity(f.b.id)),'status')
    assert.equal(status.delivery_state,'delivered');assert.equal(status.handling_state,'acknowledged')
  }finally{await f.close()}
})

test('M15 canonical close and reopen restores the real compacted surface and rebuilds unresolved state without re-admission',async()=>{
  const f=await fixture();let reopened:Awaited<ReturnType<typeof mount>>|undefined
  try{
    const saved=await prepareCompacted(f),oldIdentity=f.persistence.runtimeIdentity(f.b.id)
    const surfaceBefore=[...f.b.session.surface.nodes],measurementBefore=f.ctx.tokenMeter.measure(f.b.session).nodes
    await f.ctx.fiber.dispose()
    reopened=await mount(f.coordinator,f.root,'resumed-in-process-fixture')
    const {agent}=await reopened.ctx.agents.resume({resumeSessionId:SessionId('b'),agentOptions:{provider:'keyless',model:'fixture'}})
    const identity=reopened.persistence.runtimeIdentity(agent.id)
    assert.notEqual(identity.incarnation_id,oldIdentity.incarnation_id)
    assert.ok(identity.execution_epoch>oldIdentity.execution_epoch)
    assert.deepEqual(agent.session.deriveMessages(),saved.active,'canonical replay must preserve the compaction replacement surface')
    assert.deepEqual([...agent.session.surface.nodes],surfaceBefore)
    assert.deepEqual(reopened.ctx.tokenMeter.measure(agent.session).nodes,measurementBefore,'actual token-meter projection must rebuild from the same canonical events')
    assert.equal(reopened.adapter.requests.length,0,'resume must not wake an idle session')
    agent.followup(prompt('Resume the compacted session.'));await agent.whenIdle();await reopened.ctx.sessions.flush(agent.session)
    assert.equal(reopened.adapter.conversation.length,1);assert.equal(reopened.adapter.summaries.length,0)
    assertFreshReference(reopened.adapter.conversation[0]!,saved.messageId)
    assert.deepEqual(ledger(f.coordinator,saved.messageId),saved.evidence)
    assert.equal(storedEvents(f.coordinator).filter(event=>event.type==='user/message'&&event.data.source.kind==='session-coordination').length,1)
    const status=wireObject(await reopened.client.call('get_message_status',{message_id:saved.messageId},identity),'status')
    assert.equal(status.handling_state,'acknowledged');assert.equal(status.delivery_state,'delivered')
  }finally{await reopened?.ctx.fiber.dispose();await f.close()}
})
