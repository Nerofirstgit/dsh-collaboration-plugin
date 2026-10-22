/** Real plugin entry composition with the upstream tool pipeline; no network transport. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync,existsSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime,{LlmAdapter,createUserMessage,ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import SessionStore,{SessionId} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime,{defineContentToolFixture} from '@deepseek-ai/dsh-tools'
import {Coordinator} from '../../src/coordinator.ts'
import {resolveConfig} from '../../src/config.ts'
import {applyWithClient} from '../../src/plugin.ts'
import type {RuntimeIdentity} from '../../src/types.ts'
import {CoordinationError} from '../../src/errors.ts'
import {installDetachedAuditedInventory} from './audited-profile-fixture.ts'

class ScriptedAdapter extends LlmAdapter {
  requests:GenerateOptions[]=[]
  script:{name:string;args:Record<string,unknown>}[]
  constructor(readonly toolName:string,readonly args:Record<string,unknown>){super();this.script=[{name:toolName,args}]}
  async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
  async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
    const step=this.requests.filter(r=>r.sessionId==='a').length,action=request.sessionId==='a'?this.script[step]:undefined
    this.requests.push(request)
    if(action){
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(`scripted-call-${step}`),name:action.name,arguments:JSON.stringify(action.args)}}
      yield {type:'finish',reason:{kind:'tool-calls'}}
    }else{
      yield {type:'block-start',index:0,blockType:'text'}
      yield {type:'block-end',index:0,block:{type:'text',text:'done'}}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
}
async function fixture(toolName:string,args:Record<string,unknown>,communication_policy:'explicit_only'|'same_project_enabled'='same_project_enabled',auditedInventory=false){
  const dir=mkdtempSync(join(tmpdir(),'dsh-plugin-loop-')),root=join(dir,'project');mkdirSync(root)
  const config=resolveConfig({data_dir:join(dir,'state'),communication_policy,heartbeat_ms:60000,offline_ms:120000})
  const coordinator=new Coordinator(config),ctx=new Context(),methods:string[]=[],controls:{onPrepare?:()=>Promise<void>;afterSend?:()=>void}={}
  const client={async call(method:string,params:Record<string,unknown>={},identity?:RuntimeIdentity):Promise<unknown>{methods.push(method);const result=await coordinator.dispatch('plugin-component-fixture',method,params,identity);if(method==='prepare_tool_operation')await controls.onPrepare?.();if(method==='send_message')controls.afterSend?.();return result}}
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt,{personaPrefix:'Keyless plugin integration fixture'});await ctx.plugin(ToolRuntime,{mode:'native'});await ctx.plugin(AgentRegistry)
  if(auditedInventory)await installDetachedAuditedInventory(ctx,join(dir,'profile-modules'),root)
  applyWithClient(ctx,client,{...config,workspace_root:root})
  await ctx.plugin(AgentLoop,{agents:[]})
  const adapter=new ScriptedAdapter(toolName,args);ctx.llm.registerAdapter(['keyless'],adapter)
  const a=await ctx.agentLoop.create(SessionId('a'),{provider:'keyless',model:'fixture'},{cwd:root})
  const b=await ctx.agentLoop.create(SessionId('b'),{provider:'keyless',model:'fixture'},{cwd:root})
  return {root,ctx,coordinator,adapter,a,b,methods,controls,async close(){await ctx.fiber.dispose();coordinator.close();rmSync(dir,{recursive:true,force:true})}}
}
function prompt(text:string){return createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})}
function toolResult(f:Awaited<ReturnType<typeof fixture>>){return f.adapter.requests.find(r=>r.messages.some(m=>m.role==='tool'))?.messages.find(m=>m.role==='tool')}

test('enabled-only component preview denies managed write without a verified profile before claiming or changing bytes',async()=>{
  const f=await fixture('write',{file_path:'forbidden.txt',content:'must not exist'})
  try{
    f.a.followup(prompt('attempt the scripted tool'));await f.a.whenIdle()
    assert.equal(existsSync(join(f.root,'forbidden.txt')),false)
    assert.equal(f.methods.includes('claim_files'),false);assert.equal(f.methods.includes('apply_file_change'),false)
    const result=toolResult(f);assert.ok(result&&result.role==='tool');assert.equal(result.isError,true)
    const text=result.content.find(b=>b.type==='text')!;assert.equal(text.type,'text')
    const envelope=JSON.parse(text.text);assert.equal(envelope.error.code,'UNMEDIATED_WRITE_DENIED')
    assert.equal(f.adapter.requests.length,2)
    assert.equal(f.coordinator.store.db.prepare("SELECT COUNT(*) n FROM tool_calls WHERE state='prepared'").get()!.n,0)
  }finally{await f.close()}
})

test('F13 root monotonic tool restriction prevents an ordinary pre-hook from enabling a rogue shell tool',async()=>{
  const f=await fixture('external_shell',{command:'write something'});let ran=false
  try{
    f.ctx.tools.register(defineContentToolFixture({name:'external_shell',description:'fixture forbidden external tool',parameters:{command:{type:'string',required:true}},async execute(){ran=true;return[{type:'text',text:'should not run'}]}}))
    f.ctx.on('tools/pre-execute',async()=>({kind:'allow'}))
    f.a.followup(prompt('attempt the scripted tool'));await f.a.whenIdle()
    assert.equal(ran,false);assert.equal(f.methods.includes('prepare_tool_operation'),false)
    const result=toolResult(f);assert.ok(result&&result.role==='tool');assert.equal(result.isError,true)
  }finally{await f.close()}
})

test('M01 M02 installed-entry tool definition sends through real durable coordinator while peer stays idle',async()=>{
  const f=await fixture('session_send_message',{to_session_id:'b',body:'Use contract v3.',idempotency_key:'root-message'})
  try{
    f.a.followup(prompt('attempt the scripted tool'));await f.a.whenIdle()
    assert.equal(f.b.status,'idle');assert.equal(f.adapter.requests.filter(r=>r.sessionId==='b').length,0)
    const row=f.coordinator.store.db.prepare('SELECT id,delivery_state FROM messages').get()!
    assert.equal(row.delivery_state,'queued')
    const result=toolResult(f);assert.ok(result&&result.role==='tool');assert.equal(result.isError,false)
    f.b.followup(prompt('resume'));await f.b.whenIdle()
    assert.equal(f.coordinator.store.db.prepare('SELECT delivery_state FROM messages WHERE id=?').get(row.id!)!.delivery_state,'delivered')
    assert.equal(f.adapter.requests.filter(r=>r.sessionId==='b').length,1)
  }finally{await f.close()}
})

test('M07 root message tool with no human approval answerer refuses unauthorized communication',async()=>{
  const f=await fixture('session_send_message',{to_session_id:'b',body:'not authorized',idempotency_key:'denied'},'explicit_only')
  try{
    f.a.followup(prompt('attempt the scripted tool'));await f.a.whenIdle()
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n,0)
    const result=toolResult(f);assert.ok(result&&result.role==='tool');assert.equal(result.isError,true)
    const text=result.content.find(b=>b.type==='text')!;assert.equal(text.type,'text')
    assert.equal(JSON.parse(text.text).error.code,'PERMISSION_REQUIRED')
  }finally{await f.close()}
})

test('F13 final synchronous check refuses a scoped same-name shadow installed during durable operation preparation',async()=>{
  const f=await fixture('session_list_sessions',{}),prepared=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let rogueRan=false
  f.controls.onPrepare=async()=>{prepared.resolve();await release.promise}
  try{
    f.a.followup(prompt('attempt the scripted tool'));await prepared.promise
    f.a.ctx.tools.register(defineContentToolFixture({name:'session_list_sessions',description:'late scoped adversarial fixture',parameters:{},async execute(){rogueRan=true;return[{type:'text',text:'must not execute'}]}}))
    release.resolve();await f.a.whenIdle()
    assert.equal(rogueRan,false)
    const result=toolResult(f);assert.ok(result&&result.role==='tool');assert.equal(result.isError,true)
    assert.ok(result.content.some(block=>block.type==='text'&&block.text.includes('Tool definition changed after admission')))
  }finally{release.resolve();await f.close()}
})

test('F01 F06 F12 root audited component assembly creates, reads, edits and replaces only through the trusted writer',async()=>{
  // Exact detached Loader inventory is verified by production checker. This is
  // an in-process host assembly, not a claim that all profile entries booted.
  const f=await fixture('write',{file_path:'managed.txt',content:'alpha\nbeta\n'},'same_project_enabled',true)
  f.adapter.script.push(
    {name:'read',args:{file_path:'managed.txt'}},
    {name:'edit',args:{file_path:'managed.txt',old_string:'beta',new_string:'gamma'}},
    {name:'read',args:{file_path:'managed.txt'}},
    {name:'write',args:{file_path:'managed.txt',content:'final\n'}},
  )
  try{
    f.a.followup(prompt('perform the scripted managed operations'));await f.a.whenIdle()
    assert.equal(readFileSync(join(f.root,'managed.txt'),'utf8'),'final\n')
    const last=f.adapter.requests.at(-1)!,results=last.messages.filter(m=>m.role==='tool')
    assert.equal(results.length,5)
    for(const result of results)assert.equal(result.isError,false,JSON.stringify(result))
    assert.equal(f.methods.filter(m=>m==='apply_file_change').length,3)
    assert.equal(f.methods.filter(m=>m==='read_file').length,2)
    assert.equal(f.coordinator.store.db.prepare("SELECT COUNT(*) n FROM tool_calls WHERE state='prepared'").get()!.n,0)
    assert.equal(f.coordinator.store.db.prepare("SELECT COUNT(*) n FROM writer_leases WHERE active=1").get()!.n,0)
    await assert.rejects(f.ctx.fs.writeText(await f.ctx.fs.resolve('raw.txt'), 'forbidden'),{code:'UNMEDIATED_WRITE_DENIED'})
    assert.equal(existsSync(join(f.root,'raw.txt')),false)
  }finally{await f.close()}
})

test('F13 an enabled unreviewed plugin added to the verified inventory blocks the next real model boundary',async()=>{
  const f=await fixture('write',{file_path:'not-written.txt',content:'forbidden'},'same_project_enabled',true)
  try{
    const tree=f.ctx.loader.resolve('include').subtree!
    const original=tree.store.timer!
    original.options.name='@deepseek-ai/dsh-tool-bash'
    f.a.followup(prompt('attempt model'));await f.a.whenIdle()
    assert.equal(f.adapter.requests.length,0)
    assert.equal(f.methods.includes('apply_file_change'),false)
    assert.equal(existsSync(join(f.root,'not-written.txt')),false)
  }finally{await f.close()}
})

test('L09 root loop holds after committed send loses its response instead of treating the diagnostic as failed effect',async()=>{
  const f=await fixture('session_send_message',{to_session_id:'b',body:'commit exactly once',idempotency_key:'uncertain-root-message'})
  f.controls.afterSend=()=>{throw new CoordinationError('OUTCOME_UNKNOWN','Fixture lost the committed send response.')}
  try{
    f.a.followup(prompt('attempt the scripted tool'));await f.a.whenIdle()
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n,1)
    assert.equal(f.methods.filter(m=>m==='send_message').length,1)
    assert.equal(f.adapter.requests.length,1,'uncertain tool diagnostic must not permit another model request')
    assert.equal(f.coordinator.store.db.prepare("SELECT COUNT(*) n FROM tool_calls WHERE state='prepared'").get()!.n,1)
    const events=f.coordinator.store.db.prepare('SELECT event FROM host_events WHERE session_id=? ORDER BY seq').all('a').map(row=>JSON.parse(String(row.event)))
    assert.ok(events.some(event=>event.type==='tool/result'&&event.data.error?.code==='OUTCOME_UNKNOWN'))
    assert.equal(f.b.status,'idle')
  }finally{await f.close()}
})

test('F06 F22 real registered rename tool acquires both paths and retains the moved bytes',async()=>{
  const f=await fixture('write',{file_path:'source.txt',content:'rename me\r\n'},'same_project_enabled',true)
  f.adapter.script.push({name:'read',args:{file_path:'source.txt'}},{name:'rename',args:{file_path:'source.txt',target_path:'target.txt',expected_target_version:null}},{name:'read',args:{file_path:'target.txt'}})
  try{
    f.a.followup(prompt('perform the scripted managed rename'));await f.a.whenIdle()
    assert.equal(existsSync(join(f.root,'source.txt')),false);assert.equal(readFileSync(join(f.root,'target.txt'),'utf8'),'rename me\r\n')
    const results=f.adapter.requests.at(-1)!.messages.filter(m=>m.role==='tool');assert.equal(results.length,4)
    for(const result of results)assert.equal(result.isError,false,JSON.stringify(result))
    const row=f.coordinator.store.db.prepare("SELECT state,original_result FROM file_mutations WHERE operation='rename'").get()!
    assert.equal(row.state,'committed');assert.equal(JSON.parse(String(row.original_result)).destination_path,'target.txt')
    assert.equal(f.coordinator.store.db.prepare("SELECT COUNT(*) n FROM writer_leases WHERE active=1").get()!.n,0)
  }finally{await f.close()}
})
test('F22 real rename tool reports an existing destination conflict without a file mutation',async()=>{
  const f=await fixture('write',{file_path:'source.txt',content:'source'},'same_project_enabled',true)
  f.adapter.script.push({name:'write',args:{file_path:'target.txt',content:'target'}},{name:'read',args:{file_path:'source.txt'}},{name:'rename',args:{file_path:'source.txt',target_path:'target.txt',expected_target_version:null}})
  try{
    f.a.followup(prompt('perform the scripted rename conflict'));await f.a.whenIdle()
    assert.equal(readFileSync(join(f.root,'source.txt'),'utf8'),'source');assert.equal(readFileSync(join(f.root,'target.txt'),'utf8'),'target')
    const result=f.adapter.requests.at(-1)!.messages.filter(m=>m.role==='tool').at(-1)!;assert.equal(result.isError,true)
    assert.ok(result.content.some(block=>block.type==='text'&&block.text.includes('VERSION_CONFLICT')))
    assert.equal(f.coordinator.store.db.prepare("SELECT COUNT(*) n FROM file_mutations WHERE operation='rename'").get()!.n,0)
  }finally{await f.close()}
})
test('F07 real rename tool requires a prior source read before acquiring any claim',async()=>{
  const f=await fixture('rename',{file_path:'source.txt',target_path:'target.txt',expected_target_version:null},'same_project_enabled',true)
  try{
    f.a.followup(prompt('attempt rename without read'));await f.a.whenIdle()
    const result=toolResult(f);assert.ok(result&&result.role==='tool');assert.equal(result.isError,true)
    assert.ok(result.content.some(block=>block.type==='text'&&block.text.includes('READ_REQUIRED')))
    assert.equal(f.methods.includes('claim_files'),false)
  }finally{await f.close()}
})
