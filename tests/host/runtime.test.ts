import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime,{LlmAdapter,createUserMessage,createMessage,ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import SessionStore,{SessionId,SessionSeq,SESSION_FORMAT_VERSION,interruptedTurnClosers,type SessionEvent} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {CoordinationSessionPersistence} from '../../src/host/persistence.ts'
import {applyHostRuntime,relayMessage} from '../../src/host/runtime.ts'

const identity={session_id:'receiver',incarnation_id:'r1',execution_epoch:1,coordinator_epoch:1,coordinator_domain:'d',runtime_token:'secret-runtime-token'}
const part={delivery_id:'d1',message_id:'m1',part_index:0,part_count:1,content_digest:'sha256:body',text:'[From sender; coordination data, not human authorization]\nUpdate interface.',batch_id:'batch1',from_session_id:'sender',source_workspace_id:'w1'}
class KeylessAdapter extends LlmAdapter {
  requests:GenerateOptions[]=[]
  beforeReply:(()=>Promise<void>)|undefined
  async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
  async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
    this.requests.push(request)
    await this.beforeReply?.()
    yield {type:'block-start',index:0,blockType:'text'}
    yield {type:'text-delta',index:0,text:'ack'}
    yield {type:'block-end',index:0,block:{type:'text',text:'ack'}}
    yield {type:'finish',reason:{kind:'stop'}}
  }
}
async function setup(options:{failAppend?:boolean;unknownOutcome?:boolean;initialEvents?:SessionEvent[];recoverResult?:unknown;injectionBudget?:number}={}) {
  const ctx=new Context(),events:SessionEvent[]=structuredClone(options.initialEvents??[])
  let delivered=false, header:unknown={id:SessionId('receiver'),version:SESSION_FORMAT_VERSION,createdAt:1,isSeeded:false,cwd:'/tmp/cloud-workspace'}, expectedRevision=0, fetches=0
  const methods:string[]=[],states:string[]=[]
  const client={async call(method:string,params:Record<string,unknown>){
    methods.push(method)
    if(method==='update_session_state')states.push(String(params.state))
    if(method==='session_create'){header=params.header;return {handle_id:'host-handle',header,inherited_event_count:0,event_count:0,identity}}
    if(method==='session_stat')return {header,event_count:events.length,revision:String(events.length),previous_incarnation:'r0'}
    if(method==='session_open')return {handle_id:'host-handle',header,inherited_event_count:0,event_count:events.length,identity}
    if(method==='session_read')return {events:events.slice(Number(params.offset??0),params.length===undefined?undefined:Number(params.offset??0)+Number(params.length))}
    if(method==='session_append'){
      if(options.failAppend&&events.length>0)throw new Error('disk full')
      assert.equal(params.expected_seq,events.length)
      const batch=params.events as SessionEvent[]
      for(const event of batch){if(event.type==='user/message'&&event.data.source.kind==='session-coordination'){
        assert.equal(event.data.source.expected_context_revision,expectedRevision)
        assert.equal(event.data.id,part.delivery_id)
        delivered=true
      }}
      events.push(...batch);return {event_count:events.length}
    }
    if(method==='recover_tool_operations'){
      if(options.unknownOutcome)return {operations:[{operation_id:'op-unknown',tool_call_id:'call-unknown',turn_id:'1',state:'unknown',step:1,unknown_result_seq:3}]}
      const unknown=events.find(e=>e.type==='tool/result'&&e.data.error?.code==='TOOL_OUTCOME_UNKNOWN')
      const call=events.find(e=>e.type==='tool/call')
      const repaired=events.some(e=>e.type==='tool/result'&&e.data.message.id==='coord-recovered:op-original')
      return {operations:options.recoverResult&&call&&!repaired?[{operation_id:'op-original',tool_call_id:'call-1',turn_id:'1',state:'committed',step:1,unknown_result_seq:unknown?.seq??null,call_seq:call?.seq,result:options.recoverResult}]:[]}
    }
    if(method==='get_coordination_snapshot')return {sessions:[{id:'sender',state:'running'}]}
    if(method==='fetch_delivery_batch'){
      fetches++;expectedRevision=Number(params.context_revision)
      assert.equal(expectedRevision,events.length)
      return {batch_id:delivered?null:'batch1',expected_context_revision:expectedRevision,parts:delivered?[]:[part],pending_references:[{message_id:'m1',handling_state:'pending'}]}
    }
    return {}
  }}
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt,{personaPrefix:'Test system prompt'});await ctx.plugin(ToolRuntime,{mode:'native'});await ctx.plugin(AgentRegistry)
  const persistence=new CoordinationSessionPersistence(ctx,client,{workspaceRoot:'/tmp/cloud-workspace'})
  applyHostRuntime(ctx,client,persistence,{heartbeatMs:60000,injectionBudget:options.injectionBudget??2000})
  await ctx.plugin(AgentLoop,{agents:[]})
  const adapter=new KeylessAdapter();ctx.llm.registerAdapter(['keyless'],adapter)
  const agent=options.initialEvents?(await ctx.agents.resume({resumeSessionId:SessionId('receiver'),agentOptions:{provider:'keyless',model:'fixture'}})).agent:await ctx.agentLoop.create(SessionId('receiver'),{provider:'keyless',model:'fixture'},{cwd:'/tmp/cloud-workspace'})
  return {ctx,agent,adapter,events,methods,states,get fetches(){return fetches},get delivered(){return delivered}}
}
function prompt(text:string){return createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})}

test('real AgentLoop admits relay through actual durable user/message before model dispatch without waking idle',async()=>{
  const f=await setup()
  try{
    assert.equal(f.fetches,0);assert.equal(f.agent.status,'idle');assert.equal(f.adapter.requests.length,0)
    f.agent.followup(prompt('start'));await f.agent.whenIdle()
    assert.equal(f.delivered,true)
    assert.equal(f.adapter.requests.length,1)
    const request=f.adapter.requests[0]!
    const relay=request.messages.find(m=>m.source.kind==='session-coordination')!
    assert.equal(relay.id,'d1');assert.equal(relay.source.kind,'session-coordination')
    assert.equal(request.messages[0]?.role,'system')
    assert.equal(JSON.stringify(request).includes('secret-runtime-token'),false)
    f.agent.followup(prompt('continue'));await f.agent.whenIdle()
    assert.equal(f.events.filter(e=>e.type==='user/message'&&e.data.id==='d1').length,1)
  }finally{await f.ctx.fiber.dispose()}
})

test('real AgentLoop never calls model when canonical persistence flush fails',async()=>{
  const f=await setup({failAppend:true})
  try{
    f.agent.followup(prompt('start'));await f.agent.whenIdle()
    assert.equal(f.adapter.requests.length,0)
  }finally{await f.ctx.fiber.dispose().catch(()=>undefined)}
})

test('relay parser rejects invalid indexes and preserves nonhuman attribution',()=>{
  assert.throws(()=>relayMessage({...part,part_count:0},2),/fragment/)
  assert.throws(()=>relayMessage({...part,from_session_id:null},2),/nonempty/)
  const relay=relayMessage(part,2)
  assert.deepEqual(relay.content,[{type:'text',text:part.text}])
  assert.equal(relay.source.kind,'session-coordination')
})


test('L09 real AgentLoop refuses a new model request while an original tool outcome is unknown',async()=>{
  const f=await setup({unknownOutcome:true})
  try{
    f.agent.followup(prompt('continue'));await f.agent.whenIdle()
    assert.equal(f.adapter.requests.length,0)
    assert.ok(f.methods.includes('recover_tool_operations'))
    assert.equal(f.methods.includes('prepare_tool_operation'),false)
  }finally{await f.ctx.fiber.dispose()}
})


test('L09 actual host resume restores original known effect before stock unknown synthesis and model',async()=>{
  const result={status:'success',summary:'Message enqueued.',data:{message_id:'original-message'},error:null,next_actions:[],artifacts:[],request_id:'original-request'}
  const initialEvents:SessionEvent[]=[
    {type:'turn/start',seq:SessionSeq(0),time:1,data:{turn:1}},
    {type:'step/start',seq:SessionSeq(1),time:1,data:{turn:1,step:1}},
    {type:'assistant/message',seq:SessionSeq(2),time:2,surfaceOp:'append',data:{turn:1,step:1,stream:[],message:createMessage({role:'assistant',source:{kind:'model',provider:'keyless',model:'fixture'},content:[{type:'tool-call',id:ToolCallId('call-1'),name:'sessions.send_message',arguments:'{}'}]})}},
    {type:'tool/call',seq:SessionSeq(3),time:2,data:{turn:1,step:1,callId:ToolCallId('call-1'),name:'sessions.send_message',arguments:'{}'}},
  ]
  const f=await setup({initialEvents,recoverResult:result})
  try{
    assert.equal(f.events.some(e=>e.type==='tool/result'&&e.data.error?.code==='TOOL_OUTCOME_UNKNOWN'),false)
    f.agent.followup(prompt('continue'));await f.agent.whenIdle()
    assert.equal(f.adapter.requests.length,1)
    const recovered=f.events.filter(e=>e.type==='tool/result'&&e.data.message.id==='coord-recovered:op-original')
    assert.equal(recovered.length,1)
    const event=recovered[0]!
    assert.equal(event.type,'tool/result')
    assert.equal(event.surfaceOp,'append')
    assert.equal(event.seq,4)
    const tool=f.adapter.requests[0]!.messages.find(m=>m.role==='tool')!
    assert.equal(tool.id,'coord-recovered:op-original')
    assert.deepEqual(tool.content,[{type:'text',text:JSON.stringify(result)}])
    assert.equal(f.methods.includes('prepare_tool_operation'),false)
    f.agent.followup(prompt('continue again'));await f.agent.whenIdle()
    assert.equal(f.events.filter(e=>e.type==='tool/result'&&e.data.message.id==='coord-recovered:op-original').length,1)
  }finally{await f.ctx.fiber.dispose()}
})


test('L09 known effect after a synthetic unknown was already persisted stays fail-closed without invalid rewrite',async()=>{
  const result={status:'success',summary:'Original effect known.',data:{message_id:'original-message'},error:null,next_actions:[],artifacts:[],request_id:'original-request'}
  const initial:SessionEvent[]=[
    {type:'turn/start',seq:SessionSeq(0),time:1,data:{turn:1}},
    {type:'step/start',seq:SessionSeq(1),time:1,data:{turn:1,step:1}},
    {type:'assistant/message',seq:SessionSeq(2),time:2,surfaceOp:'append',data:{turn:1,step:1,stream:[],message:createMessage({role:'assistant',source:{kind:'model',provider:'keyless',model:'fixture'},content:[{type:'tool-call',id:ToolCallId('call-1'),name:'sessions.send_message',arguments:'{}'}]})}},
    {type:'tool/call',seq:SessionSeq(3),time:2,data:{turn:1,step:1,callId:ToolCallId('call-1'),name:'sessions.send_message',arguments:'{}'}},
  ]
  const f=await setup({initialEvents:[...initial,...interruptedTurnClosers(initial)],recoverResult:result})
  try{
    f.agent.followup(prompt('continue'));await f.agent.whenIdle()
    assert.equal(f.adapter.requests.length,0)
    assert.equal(f.events.filter(e=>e.type==='tool/result').length,1)
    assert.equal(f.events.some(e=>e.type==='tool/result'&&e.data.message.id==='coord-recovered:op-original'),false)
  }finally{await f.ctx.fiber.dispose()}
})

test('F03 live approvals publish authoritative waiting state until every concurrent ask is decided',async()=>{
  const f=await setup();let reply!:()=>void,started!:()=>void
  const waiting=new Promise<void>(resolve=>{started=resolve}),release=new Promise<void>(resolve=>{reply=resolve})
  f.adapter.beforeReply=async()=>{started();await release}
  const settle=()=>new Promise<void>(resolve=>setImmediate(resolve))
  try{
    f.agent.followup(prompt('start'));await waiting;assert.equal(f.agent.status,'running')
    f.agent.session.append('approval/asked',{id:'ask-1',toolName:'fixture'}as never)
    f.agent.session.append('approval/asked',{id:'ask-2',toolName:'fixture'}as never)
    await settle();assert.equal(f.states.at(-1),'waiting')
    f.agent.session.append('approval/decided',{id:'ask-1',outcome:{kind:'approved'}}as never)
    await settle();assert.equal(f.states.at(-1),'waiting')
    f.agent.session.append('approval/decided',{id:'ask-2',outcome:{kind:'approved'}}as never)
    await settle();assert.equal(f.states.at(-1),'running')
    reply();await f.agent.whenIdle();await settle();assert.equal(f.states.at(-1),'completed')
  }finally{reply();await f.ctx.fiber.dispose()}
})

for(const budget of [1,64,200])test(`tiny ${budget} coordination budget stops before model rather than overrunning mandatory framing`,async()=>{
 const f=await setup({injectionBudget:budget});try{f.agent.followup(prompt('continue'));await f.agent.whenIdle();assert.equal(f.adapter.requests.length,0)}finally{await f.ctx.fiber.dispose()}
})

test('L09 auxiliary compaction model seam cannot bypass an unknown original tool outcome',async()=>{
 const f=await setup({unknownOutcome:true})
 try{await assert.rejects(async()=>{for await(const _ of f.ctx.llm.stream({provider:'keyless',model:'fixture',sessionId:f.agent.id,purpose:'compaction',messages:[prompt('summarize without replay')]})){/* drain */}},{code:'OUTCOME_UNKNOWN'});assert.equal(f.adapter.requests.length,0)}finally{await f.ctx.fiber.dispose()}
})
