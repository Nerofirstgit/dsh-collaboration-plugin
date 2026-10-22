/**
 * R01 feature-absent baseline over the pinned stock host components. This mounts
 * real ordinary filesystem tools and stock JSONL persistence, not the collaboration
 * bundle. The model is a keyless in-process fixture; --dump-config checks composition
 * only. No listener, coordinator, external endpoint, or install/remove command runs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,existsSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime,{LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import SessionStore,{SessionId,type SessionEvent} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import * as ObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as CheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import {entryListSchema} from '@deepseek-ai/cordis-plugin-include'
// The pinned host ships js-yaml without declarations. Keep this test-only
// adapter narrow and retain unknown at the parser boundary rather than pulling
// an unpinned type package into the production dependency graph.
const yaml=createRequire(import.meta.url)('js-yaml') as {load(source:string,options:{schema:unknown}):unknown}

interface Action{name:string;arguments:Record<string,unknown>}
class StockAdapter extends LlmAdapter{
  readonly requests:GenerateOptions[]=[]
  constructor(readonly callPrefix:string,readonly actions:readonly Action[]){super()}
  async resolveModel(provider:string,model:string){return{provider,id:model,name:model}}
  async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
    const action=this.actions[this.requests.length];this.requests.push(request)
    if(action){
      yield{type:'block-start',index:0,blockType:'tool-call'}
      yield{type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(`${this.callPrefix}-${this.requests.length}`),name:action.name,arguments:JSON.stringify(action.arguments)}}
      yield{type:'finish',reason:{kind:'tool-calls'}}
    }else{
      yield{type:'block-start',index:0,blockType:'text'}
      yield{type:'block-end',index:0,block:{type:'text',text:'Stock host task finished.'}}
      yield{type:'finish',reason:{kind:'stop'}}
    }
  }
}
async function stockHost(root:string,storage:string,prefix:string,actions:readonly Action[]){
  const ctx=new Context()
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt,{personaPrefix:'Pinned stock host component fixture'})
  await ctx.plugin(ToolRuntime,{mode:'native'});await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem,{cwd:root})
  await ctx.plugin(WorkingDirectory,{defaultDirectory:root})
  await ctx.plugin(ObservationPolicy);await ctx.plugin(FileTools,{readImage:false})
  await ctx.plugin(JsonlPersistence,{root:storage,compression:'none'})
  await ctx.plugin(CheckpointPolicy)
  // Preserve the stock backend's documented ownership/consumer teardown order.
  await ctx.inject(['sessionPersistence'],async owner=>{await owner.plugin(AgentLoop,{agents:[]})})
  const adapter=new StockAdapter(prefix,actions);ctx.llm.registerAdapter(['keyless-stock'],adapter)
  assert.ok(ctx.fs instanceof LocalFileSystem)
  assert.equal(ctx.fs.constructor.name,'LocalFileSystem')
  assert.equal(ctx.sessionPersistence.constructor.name,'JsonlSessionPersistence')
  for(const name of ['read','write','edit'])assert.ok(ctx.tools.get(name),`missing stock ${name} tool`)
  for(const name of ['session_collaboration_status','session_send_message','session_list_sessions','claim_files','apply_file_change'])assert.equal(ctx.tools.get(name),undefined)
  assert.equal(ctx.get('collaborationReady'),undefined)
  return{ctx,adapter}
}
function prompt(text:string){return createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})}
async function persisted(ctx:Context):Promise<readonly SessionEvent[]>{
  const handle=await ctx.sessionPersistence.open(SessionId('stock-baseline'),'read')
  try{return(await handle.read()).events}finally{await handle.close()}
}
function assertOrdinaryRequests(requests:readonly GenerateOptions[]){
  for(const request of requests){
    assert.ok(!request.tools?.some(tool=>tool.name.startsWith('session_')||tool.name==='claim_files'))
    assert.ok(!request.messages.some(message=>message.source?.kind==='session-coordination'||message.source?.kind==='session-coordination-state'))
  }
}

test('R01 without collaboration, stock read/write/edit and JSONL create-close-reopen retain ordinary host behavior',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dsh-disabled-baseline-')),root=join(dir,'project'),storage=join(dir,'stock-sessions');mkdirSync(root)
  let original:Awaited<ReturnType<typeof stockHost>>|undefined,resumed:Awaited<ReturnType<typeof stockHost>>|undefined
  try{
    original=await stockHost(root,storage,'initial',[
      {name:'write',arguments:{file_path:'normal.txt',content:'alpha\nbeta\n'}},
      {name:'read',arguments:{file_path:'normal.txt'}},
      {name:'edit',arguments:{file_path:'normal.txt',old_string:'beta',new_string:'gamma'}},
    ])
    const agent=await original.ctx.agentLoop.create(SessionId('stock-baseline'),{provider:'keyless-stock',model:'fixture'},{cwd:root})
    agent.followup(prompt('Run the ordinary filesystem operations.'));await agent.whenIdle();await original.ctx.sessions.flush(agent.session)
    assert.equal(readFileSync(join(root,'normal.txt'),'utf8'),'alpha\ngamma\n')
    assert.equal(original.adapter.requests.length,4);assertOrdinaryRequests(original.adapter.requests)
    const events=await persisted(original.ctx),results=events.filter(event=>event.type==='tool/result')
    assert.equal(results.length,3)
    for(const result of results)assert.equal(result.data.message.isError,false,JSON.stringify(result.data))
    assert.deepEqual(events.filter(event=>event.type==='tool/call').map(event=>event.data.name),['write','read','edit'])
    assert.ok(!JSON.stringify(events).includes('session-coordination'))
    const before=agent.session.deriveMessages(),header=(await original.ctx.sessionPersistence.stat(agent.id))!.header
    // Stock JSONL materializes delegationDepth=0 when the live header omits it.
    assert.deepEqual(header,{...agent.session.header,delegationDepth:agent.session.header.delegationDepth??0})
    const logFiles=readdirSync(storage,{recursive:true}).filter(path=>typeof path==='string'&&path.endsWith('.jsonl'))
    assert.equal(logFiles.length,1,'stock JSONL must actually materialize, not use an in-memory substitute')
    const disk=readFileSync(join(storage,String(logFiles[0])),'utf8')
    assert.ok(disk.includes('stock-baseline'));assert.ok(disk.includes('tool/result'))
    await original.ctx.fiber.dispose()
    resumed=await stockHost(root,storage,'resumed',[
      {name:'read',arguments:{file_path:'normal.txt'}},
      {name:'edit',arguments:{file_path:'normal.txt',old_string:'gamma',new_string:'delta'}},
    ])
    const restored=(await resumed.ctx.agents.resume({resumeSessionId:SessionId('stock-baseline'),agentOptions:{provider:'keyless-stock',model:'fixture'}})).agent
    assert.deepEqual(restored.session.header,header)
    assert.deepEqual(restored.session.deriveMessages(),before)
    assert.equal(resumed.adapter.requests.length,0,'restoring a stock session must not start the model')
    restored.followup(prompt('Continue using the stock tools.'));await restored.whenIdle();await resumed.ctx.sessions.flush(restored.session)
    assert.equal(readFileSync(join(root,'normal.txt'),'utf8'),'alpha\ndelta\n')
    assert.equal(resumed.adapter.requests.length,3);assertOrdinaryRequests(resumed.adapter.requests)
    const reopenedEvents=await persisted(resumed.ctx)
    assert.deepEqual(reopenedEvents.slice(0,events.length),events,'the original canonical JSONL prefix must be preserved')
    assert.equal(reopenedEvents.filter(event=>event.type==='tool/result').length,5)
  }finally{await resumed?.ctx.fiber.dispose();await original?.ctx.fiber.dispose();rmSync(dir,{recursive:true,force:true})}
})

interface ConfigRow{id:string;name:string;disabled?:boolean;inject?:unknown;config?:unknown}
function dump(home:string,withBundle:boolean):ConfigRow[]{
  const args=['node_modules/@deepseek-ai/dsh/lib/bin.js','--profile','headless',...(withBundle?['--patch','./cordis.patch.yml']:[]),'--dump-config']
  const run=spawnSync(process.execPath,args,{cwd:resolve('.'),env:{...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'},encoding:'utf8'})
  assert.equal(run.status,0,run.stderr);assert.equal(run.stderr,'')
  return yaml.load(run.stdout,{schema:entryListSchema})as ConfigRow[]
}
test('R01 official CLI composition returns to unchanged stock profile when the complete collaboration overlay is omitted',()=>{
  const home=mkdtempSync(join(tmpdir(),'dsh-disabled-profile-'))
  try{
    const before=dump(home,false),enabled=dump(home,true),after=dump(home,false)
    assert.deepEqual(after,before,'transient bundle overlay must not rewrite the stock profile')
    const rows=new Map(before.map(row=>[row.id,row]))
    for(const id of ['session-persistence-jsonl','fs-sandbox','tool-fs','fs-observation-policy'])assert.notEqual(rows.get(id)?.disabled,true,`${id} must be enabled in stock configuration`)
    assert.equal(rows.get('session-persistence-jsonl')?.name,'@deepseek-ai/dsh-session-persistence-jsonl')
    assert.equal(rows.get('fs-sandbox')?.name,'@deepseek-ai/dsh-fs-sandbox')
    assert.ok(!before.some(row=>row.name.startsWith('@nerofirstgit/dsh-collaboration')))
    assert.ok(!JSON.stringify(before).includes('collaborationReady'))
    assert.equal(enabled.find(row=>row.id==='session-persistence-jsonl')?.disabled,true)
    assert.equal(enabled.find(row=>row.id==='fs-sandbox')?.disabled,true)
    assert.ok(enabled.some(row=>row.id==='session-collaboration'&&row.name==='@nerofirstgit/dsh-collaboration'))
    const manifest=JSON.parse(readFileSync('package.json','utf8'))
    assert.equal(manifest.dsh.bundle.patch,'./cordis.patch.yml','the inspected overlay is the package-declared complete bundle patch')
  }finally{rmSync(home,{recursive:true,force:true})}
})

test('R01 partial enabled:false is a clear pre-bootstrap refusal, not a silent stock-mode transition',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dsh-partial-disable-')),data=join(dir,'must-not-bootstrap'),ctx=new Context()
  try{
    const {apply}=await import('../../src/plugin.ts')
    await assert.rejects(apply(ctx,{enabled:false,data_dir:data}),error=>{
      assert.equal((error as{code:string}).code,'UNMEDIATED_WRITE_DENIED')
      assert.match(String(error),/deselect the complete bundle/)
      return true
    })
    assert.equal(existsSync(data),false)
    assert.equal(ctx.get('sessionPersistence'),undefined)
    assert.equal(ctx.get('collaborationReady'),undefined)
  }finally{await ctx.fiber.dispose();rmSync(dir,{recursive:true,force:true})}
})
