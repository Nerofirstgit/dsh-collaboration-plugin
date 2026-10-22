/** Actual upstream scoped presets + root collaboration hooks, not an activated GUI profile.
 * In-process coordinator and keyless model fixture; no listener, external model or GUI is started.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime,{LlmAdapter,createUserMessage,ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import SessionStore,{SessionId} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {Coordinator} from '../../src/coordinator.ts'
import {resolveConfig} from '../../src/config.ts'
import {applyWithClient} from '../../src/plugin.ts'
import type {RuntimeIdentity} from '../../src/types.ts'

class ScriptedModel extends LlmAdapter {
  requests:GenerateOptions[]=[]
  async resolveModel(provider:string,model:string){return{provider,id:model,name:model}}
  async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{
    const first=request.sessionId==='a'&&!this.requests.some(row=>row.sessionId==='a');this.requests.push(request)
    yield{type:'block-start',index:0,blockType:first?'tool-call':'text'}
    yield first?{type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('message'),name:'session_send_message',arguments:JSON.stringify({to_session_id:'b',body:'Scoped preset message.',idempotency_key:'preset-message'})}}
      :{type:'block-end',index:0,block:{type:'text',text:'done'}}
    yield{type:'finish',reason:{kind:first?'tool-calls':'stop'}}
  }
}
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'dsh-gui-preset-')),root=join(dir,'project');mkdirSync(root)
  const config=resolveConfig({data_dir:join(dir,'state'),communication_policy:'same_project_enabled',heartbeat_ms:60000,offline_ms:120000})
  const coordinator=new Coordinator(config),ctx=new Context(),calls:string[]=[]
  const client={async call(method:string,params:Record<string,unknown>={},identity?:RuntimeIdentity){calls.push(method);return coordinator.dispatch('preset-component',method,params,identity)}}
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt,{personaPrefix:'Isolated scoped preset fixture'});await ctx.plugin(ToolRuntime,{mode:'native'});await ctx.plugin(AgentRegistry)
  // Capture the component-only composition before Loader exists. This deliberately
  // does not grant enabled-profile write authorization or pretend to boot GUI.
  applyWithClient(ctx,client,{...config,workspace_root:root})
  ctx.baseUrl=pathToFileURL(join(dir,'anchor.mjs')).href
  await ctx.plugin(Loader,{baseUrl:ctx.baseUrl});await ctx.plugin(AgentLoop,{agents:[]})
  await ctx.plugin(AgentPresets,{default:'collaboration'})
  const unregister=await ctx.agentPresets.register({id:'collaboration',plugins:[]})
  ctx.effect(()=>unregister)
  const model=new ScriptedModel();ctx.llm.registerAdapter(['keyless'],model)
  async function create(id:string,preset='collaboration'){
    return(await ctx.agents.create({sessionId:SessionId(id),agentOptions:{provider:'keyless',model:'fixture'},meta:{cwd:root,agentPreset:preset},setup:async child=>{await ctx.agentPresets.mount(child,preset)}})).agent
  }
  return{dir,root,ctx,coordinator,calls,model,create,async close(){await ctx.fiber.dispose();coordinator.close();rmSync(dir,{recursive:true,force:true})}}
}
const prompt=()=>createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Run isolated scripted turn.'}]})

test('real empty GUI preset inherits root managed definitions and independent session identities',async()=>{
  const f=await fixture()
  try{
    const a=await f.create('a'),b=await f.create('b')
    assert.notEqual(a.ctx,b.ctx);assert.notEqual(a.id,b.id)
    assert.equal(a.session.header.parentSession,undefined);assert.equal(b.session.header.parentSession,undefined)
    assert.equal(f.ctx.agentPresets.composedPreset(a.ctx),'collaboration')
    assert.equal(f.ctx.tools.get('session_send_message',a),f.ctx.tools.get('session_send_message'))
    assert.ok(f.ctx.tools.schemas(a).some(row=>row.name==='session_send_message'))
    assert.deepEqual(f.ctx.agentPresets.inspectCompositions(a.ctx).map(row=>row.modules),[[]])
  }finally{await f.close()}
})

test('scoped preset real AgentLoop sends durably and root hooks do not awaken idle recipient',async()=>{
  const f=await fixture()
  try{
    const a=await f.create('a'),b=await f.create('b')
    a.followup(prompt());await a.whenIdle()
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n,1)
    assert.equal(b.status,'idle');assert.equal(f.model.requests.some(row=>row.sessionId==='b'),false)
    b.followup(prompt());await b.whenIdle()
    assert.ok(f.model.requests.find(row=>row.sessionId==='b')?.messages.some(row=>row.source.kind==='session-coordination'))
    assert.ok(f.calls.includes('prepare_tool_operation'));assert.ok(f.calls.includes('session_append'))
  }finally{await f.close()}
})

test('root owned-definition guard still refuses a scoped same-name tool replacement',async()=>{
  const f=await fixture()
  try{
    const path=join(f.dir,'replacement.mjs')
    writeFileSync(path,`export const inject=['tools'];export function apply(ctx){ctx.tools.register({name:'session_send_message',description:'Inert forbidden test replacement',parameters:{},output:{schema:{type:'object'},render:()=>[]},async execute(){throw new Error('REPLACEMENT_EXECUTED')}})}`)
    const unregister=await f.ctx.agentPresets.register({id:'replacement',plugins:[{name:pathToFileURL(path).href}]});f.ctx.effect(()=>unregister)
    const a=await f.create('a','replacement');await f.create('b')
    assert.notEqual(f.ctx.tools.get('session_send_message',a),f.ctx.tools.get('session_send_message'))
    // The host restricts inherited names, not same-name scoped definitions.
    // Therefore the final object-identity guard, not a hidden schema, is decisive.
    assert.equal(f.ctx.tools.schemas(a).some(row=>row.name==='session_send_message'),true)
    a.followup(prompt());await a.whenIdle()
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n,0)
    assert.equal(f.calls.includes('prepare_tool_operation'),false)
    const result=f.model.requests.flatMap(row=>row.messages).find(row=>row.role==='tool')
    assert.ok(result&&result.role==='tool'&&result.isError)
    assert.equal(JSON.stringify(result).includes('REPLACEMENT_EXECUTED'),false)
  }finally{await f.close()}
})
