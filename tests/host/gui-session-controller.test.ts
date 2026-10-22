/** Actual pinned SessionController + Typert Gateway in process. No listener or model request. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {Entry,Loader} from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionController,{type SessionCreateRequest} from '@deepseek-ai/dsh-api-session-controller'
import {TYPERT as sessionControllerManifest} from '@deepseek-ai/dsh-api-session-controller/typert'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore,{SessionId} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {remoteMethods,type PeerId,type PeerScope} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry,{type TypertContribution} from '@deepseek-ai/dsh-typert-registry'
import type {Workspace,WorkspaceId} from '@deepseek-ai/dsh-workspace'
import {Coordinator} from '../../src/coordinator.ts'
import {resolveConfig} from '../../src/config.ts'
import {CoordinationSessionPersistence} from '../../src/host/persistence.ts'
import {createGuiStateRootsGuard} from '../../src/host/gui-state-roots.ts'
import type {} from '../../src/host/readiness.ts'
import type {RuntimeIdentity} from '../../src/types.ts'
import GuardPlugin,{installGuiSessionControllerGuard,assertGuiSessionControllerGuard} from '../../src/host/gui-session-controller.ts'

function guardedController(ctx:Context){const controller=new SessionController(ctx,{nativeOpen:false});installGuiSessionControllerGuard(ctx);return controller}

class PointQuery extends SessionQueryEngine {
  override searchSessions():Promise<never>{return Promise.reject(new Error('No search in controller admission fixture'))}
  override searchEvents():Promise<never>{return Promise.reject(new Error('No search in controller admission fixture'))}
}

async function fixture(options:{guiReady?:boolean}={}){
  const dir=mkdtempSync(join(tmpdir(),'dsh-gui-controller-')),home=join(dir,'harness'),project=join(dir,'project')
  mkdirSync(home);mkdirSync(project)
  const ctx=new Context(),coordinator=new Coordinator(resolveConfig({data_dir:join(home,'coordination')}))
  const calls:string[]=[],workspaces=new Map<WorkspaceId,Workspace>(),archived:SessionId[]=[]
  ctx.baseUrl=pathToFileURL(join(dir,'anchor.mjs')).href
  await ctx.plugin(Loader,{baseUrl:ctx.baseUrl})
  ctx.provide('profileContext',{name:'web',home,dir:join(home,'profiles','web'),patchPath:join(home,'profiles','web','cordis.patch.yml'),
    cwd:home,installAnchor:join(home,'profiles','web','package.json'),startedBundles:[],overlays:[],telemetryDisabledEnv:undefined})
  function add(id:string,name:string,config:unknown){const entry=new Entry(ctx.loader);entry.options={id,name,config};entry.parent=ctx.loader.root;ctx.loader.store[id]=entry;return entry}
  const storage=add('storage-json','@deepseek-ai/dsh-storage-json',{root:join(home,'storages')})
  add('storage-domain','@deepseek-ai/dsh-storage-domain',{backend:'json',routes:{}})
  add('attachment-local','@deepseek-ai/dsh-attachment-local',{dshHome:home})
  add('credentials','@deepseek-ai/dsh-credentials-local',{dshHome:home})
  add('session-query-sqlite','@deepseek-ai/dsh-session-query-sqlite',{path:':memory:',openAt:'never'})
  const guard=createGuiStateRootsGuard(ctx)
  ctx.provide('collaborationReady',{ready:true,...options.guiReady===false?{}:{gui:{state_fingerprint:guard.evidence.fingerprint,
    assertWorkspacePathAllowed:(path:string)=>guard.assertWorkspacePathAllowed(path)}}})
  await ctx.plugin(TypertRegistry);await ctx.plugin(RemoteAccess);await ctx.plugin(TypertGateway,{})
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt,{personaPrefix:'Controller admission fixture, never prompted'})
  await ctx.plugin(ToolRuntime,{mode:'native'});await ctx.plugin(AgentRegistry)
  const client={async call(method:string,params:Record<string,unknown>={},identity?:RuntimeIdentity){
    calls.push(method);return coordinator.dispatch('controller-fixture',method,params,identity)
  }}
  new CoordinationSessionPersistence(ctx,client,{})
  await ctx.plugin(AgentLoop,{agents:[]})
  new PointQuery(ctx)
  ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'never-requested',model:'none'}),saveSelection:async()=>{}} as never)
  ctx.provide('fileUploads',{registerAgentResolver:()=>()=>{}} as never)
  ctx.provide('workspaceRegistry',{get:(id:WorkspaceId)=>workspaces.get(id),list:()=>[...workspaces.values()],archivedSessionIds:archived} as never)
  const peer:PeerScope={id:'controller-peer' as PeerId,ctx,principal:{kind:'owner'},interactions:'answer',
    signal:new AbortController().signal,dispose:async()=>{}}
  async function invoke(request:SessionCreateRequest){return ctx.typertGateway.invoke({peer,namespace:'session',method:'create',args:{request}}) as Promise<{sessionId:SessionId}>}
  function workspace(path:string,id='workspace'){
    const sessionIds:SessionId[]=[]
    const row={id:id as WorkspaceId,path,sessionIds,async attachSession(sessionId:SessionId){if(!sessionIds.includes(sessionId))sessionIds.push(sessionId)}} as Workspace
    workspaces.set(row.id,row);return row
  }
  return{dir,home,project,ctx,coordinator,calls,guard,storage,workspace,archived,invoke,async close(){
    await ctx.fiber.dispose();coordinator.disconnect('controller-fixture');coordinator.close();rmSync(dir,{recursive:true,force:true})
  }}
}

test('pinned Gateway dynamically dispatches an instance guard on the exact stock controller and preserves Remote markers',async()=>{
  const f=await fixture();try{
    const original=SessionController.prototype.create,controller=guardedController(f.ctx)
    assert.equal(Object.getPrototypeOf(controller),SessionController.prototype)
    assert.notEqual(controller.create,original);assert.equal(SessionController.prototype.create,original)
    assert.ok(remoteMethods(controller).some(marker=>marker.method==='create'))
    assert.ok(remoteMethods(controller).some(marker=>marker.method==='page'))
    assertGuiSessionControllerGuard(f.ctx)
    await assert.rejects(f.invoke({cwd:join(f.home,'live-instance-guard')}),{code:'UNMEDIATED_WRITE_DENIED'})
    assert.equal(f.calls.includes('session_create'),false)
    const created=await f.invoke({cwd:f.project})
    assert.equal(f.ctx.agents.get(created.sessionId)?.session.header.cwd,f.project)
    assert.equal(f.calls.filter(call=>call==='session_create').length,1)
  }finally{await f.close()}
})

test('GUI session.create rejects a directory inside Harness state before stock mkdir or canonical session creation',async()=>{
  const f=await fixture();try{
    guardedController(f.ctx)
    const target=join(f.home,'must-not-be-created')
    await assert.rejects(f.invoke({cwd:target}),{code:'UNMEDIATED_WRITE_DENIED'})
    assert.equal(existsSync(target),false)
    assert.equal(f.calls.includes('session_create'),false)
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM host_sessions').get()!.n,0)
  }finally{await f.close()}
})

test('GUI session.create requires a chosen project, never the controller process.cwd fallback',async()=>{
  const f=await fixture();try{
    const previous=process.cwd()
    try{process.chdir(f.home);guardedController(f.ctx)}finally{process.chdir(previous)}
    await assert.rejects(f.invoke({}),{code:'gateway/bad-request',message:/[Cc]hoose a project folder/})
    assert.equal(f.calls.includes('session_create'),false)
  }finally{await f.close()}
})

test('GUI workspaceId uses the registry path and rejects placement in Harness state before mkdir',async()=>{
  const f=await fixture();try{
    guardedController(f.ctx)
    const target=join(f.home,'registry-child'),workspace=f.workspace(target)
    await assert.rejects(f.invoke({workspaceId:workspace.id}),{code:'UNMEDIATED_WRITE_DENIED'})
    assert.equal(existsSync(target),false);assert.equal(workspace.sessionIds.length,0)
    assert.equal(f.calls.includes('session_create'),false)
  }finally{await f.close()}
})

test('GUI contradictory targets retain the stock bad-request error before location checks',async()=>{
  const f=await fixture();try{
    guardedController(f.ctx)
    await assert.rejects(f.invoke({workspaceId:'unknown' as WorkspaceId,cwd:join(f.home,'conflicting')}),
      {code:'gateway/bad-request',message:'session.create accepts workspaceId or cwd, not both'})
    assert.equal(f.calls.includes('session_create'),false)
  }finally{await f.close()}
})

test('GUI missing Workspace retains the stock workspace/not-found error without session creation',async()=>{
  const f=await fixture();try{
    guardedController(f.ctx)
    await assert.rejects(f.invoke({workspaceId:'unknown' as WorkspaceId}),{code:'workspace/not-found',message:'workspace "unknown" not found'})
    assert.equal(f.calls.includes('session_create'),false)
  }finally{await f.close()}
})

test('headless-only readiness cannot admit human GUI creation',async()=>{
  const f=await fixture({guiReady:false});try{
    new SessionController(f.ctx,{nativeOpen:false})
    assert.throws(()=>installGuiSessionControllerGuard(f.ctx),{code:'UNMEDIATED_WRITE_DENIED'})
    assert.equal(f.ctx.get('collaborationGuiControllerReady'),undefined)
    assert.equal(f.calls.includes('session_create'),false)
  }finally{await f.close()}
})

test('admitted explicit cwd delegates the stock mkdir and canonical session creation unchanged',async()=>{
  const f=await fixture();try{
    guardedController(f.ctx)
    const target=join(f.dir,'new-project','child')
    assert.equal(existsSync(target),false)
    const created=await f.invoke({cwd:target,sessionId:SessionId('human-selected')})
    assert.equal(created.sessionId,'human-selected');assert.equal(existsSync(target),true)
    const agent=f.ctx.agents.get(created.sessionId)
    assert.ok(agent);assert.equal(agent.status,'idle');assert.equal(agent.session.header.cwd,target)
    assert.equal(f.calls.filter(call=>call==='session_create').length,1)
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM host_sessions').get()!.n,1)
  }finally{await f.close()}
})

test('admitted registered Workspace keeps stock attachment and blank-session reuse without a second session row',async()=>{
  const f=await fixture();try{
    guardedController(f.ctx)
    const workspace=f.workspace(f.project)
    const first=await f.invoke({workspaceId:workspace.id})
    const reused=await f.invoke({workspaceId:workspace.id,sessionId:first.sessionId})
    assert.deepEqual(reused,first);assert.deepEqual(workspace.sessionIds,[first.sessionId])
    assert.equal(f.ctx.agents.get(first.sessionId)?.session.header.cwd,f.project)
    assert.equal(f.calls.filter(call=>call==='session_create').length,1)
  }finally{await f.close()}
})

test('stock archived-session reuse refusal remains intact and mints a new ordinary session',async()=>{
  const f=await fixture();try{
    guardedController(f.ctx)
    const workspace=f.workspace(f.project)
    const first=await f.invoke({workspaceId:workspace.id});f.archived.push(first.sessionId)
    const fresh=await f.invoke({workspaceId:workspace.id,sessionId:first.sessionId})
    assert.notEqual(fresh.sessionId,first.sessionId)
    assert.deepEqual(workspace.sessionIds,[first.sessionId,fresh.sessionId])
    assert.equal(f.calls.filter(call=>call==='session_create').length,2)
  }finally{await f.close()}
})

test('stock preset selection and blank-session reuse are preserved through the real preset registry',async()=>{
  const f=await fixture();try{
    await f.ctx.plugin(AgentPresets,{default:'collaboration'})
    const unregister=await f.ctx.agentPresets.register({id:'collaboration',plugins:[]});f.ctx.effect(()=>unregister)
    guardedController(f.ctx)
    const first=await f.invoke({cwd:f.project,agentPreset:'collaboration'})
    assert.deepEqual(first,{sessionId:first.sessionId,agentPreset:'collaboration'})
    assert.equal(f.ctx.agents.get(first.sessionId)?.session.header.agentPreset,'collaboration')
    const reused=await f.invoke({cwd:f.project,sessionId:first.sessionId,agentPreset:'collaboration'})
    assert.deepEqual(reused,first);assert.equal(f.calls.filter(call=>call==='session_create').length,1)
  }finally{await f.close()}
})

test('GUI re-derives actual state configuration on each creation instead of trusting stale readiness',async()=>{
  const f=await fixture();try{
    guardedController(f.ctx)
    await f.invoke({cwd:f.project})
    f.storage.options.config={root:join(f.home,'other-storage')}
    const target=join(f.dir,'not-created-after-config-change')
    await assert.rejects(f.invoke({cwd:target}),{code:'UNMEDIATED_WRITE_DENIED'})
    assert.equal(existsSync(target),false);assert.equal(f.calls.filter(call=>call==='session_create').length,1)
  }finally{await f.close()}
})

test('official generated strict Typert session/create schema still dispatches the guarded stock instance',async()=>{
  const f=await fixture();try{
    // Supported manual manifest registration: exact official artifact, not a
    // hand-made schema. Production TypertLoader discovers it from the retained stock row.
    f.ctx.typert.register(sessionControllerManifest as TypertContribution)
    assert.equal(f.ctx.typert.local.get('session/create')?.parameters[0]?.codec.mode,'strict')
    guardedController(f.ctx)
    const denied=join(f.home,'strict-rejected')
    await assert.rejects(f.invoke({cwd:denied}),{code:'UNMEDIATED_WRITE_DENIED'})
    assert.equal(existsSync(denied),false);assert.equal(f.calls.includes('session_create'),false)
    const created=await f.invoke({cwd:f.project})
    assert.equal(f.ctx.agents.get(created.sessionId)?.session.header.cwd,f.project)
    assert.equal(f.calls.filter(call=>call==='session_create').length,1)
  }finally{await f.close()}
})


test('active guard duplicate installation rejects without replacing the current wrapper or readiness',async()=>{
  const f=await fixture();try{
    const controller=new SessionController(f.ctx,{nativeOpen:false})
    const fork=f.ctx.plugin(GuardPlugin);await fork
    const wrapper=controller.create,capability=f.ctx.collaborationGuiControllerReady
    assert.throws(()=>installGuiSessionControllerGuard(f.ctx),{code:'UNMEDIATED_WRITE_DENIED'})
    assert.equal(controller.create,wrapper);assert.equal(f.ctx.collaborationGuiControllerReady,capability)
    assertGuiSessionControllerGuard(f.ctx)
    assert.ok((await f.invoke({cwd:f.project})).sessionId)
  }finally{await f.close()}
})

test('guard teardown closes only the existing instance; known inactive reinstall delegates once without nesting',async()=>{
  const f=await fixture();try{
    f.ctx.typert.register(sessionControllerManifest as TypertContribution)
    const gui=f.ctx.collaborationReady.gui!,preflight=gui.assertWorkspacePathAllowed
    let preflights=0
    gui.assertWorkspacePathAllowed=path=>{preflights++;return preflight(path)}
    const controller=new SessionController(f.ctx,{nativeOpen:false}),original=SessionController.prototype.create
    const first=f.ctx.plugin(GuardPlugin);await first
    const retained=controller.create
    await first.dispose()
    assert.equal(f.ctx.get('collaborationGuiControllerReady'),undefined)
    assert.equal(controller.create,retained);assert.notEqual(controller.create,original)
    assert.throws(()=>assertGuiSessionControllerGuard(f.ctx),{code:'UNMEDIATED_WRITE_DENIED'})
    const denied=join(f.dir,'closed-instance')
    await assert.rejects(f.invoke({cwd:denied}),{code:'UNMEDIATED_WRITE_DENIED'})
    assert.equal(existsSync(denied),false);assert.equal(preflights,0)
    const second=f.ctx.plugin(GuardPlugin);await second
    assert.notEqual(controller.create,retained)
    await assert.rejects(retained.call(controller,{cwd:f.project}),{code:'UNMEDIATED_WRITE_DENIED'})
    assertGuiSessionControllerGuard(f.ctx)
    assert.ok((await f.invoke({cwd:f.project})).sessionId)
    assert.equal(preflights,1);assert.equal(f.calls.filter(call=>call==='session_create').length,1)
    assert.equal(SessionController.prototype.create,original)
  }finally{await f.close()}
})

test('fresh unguarded stock controller after profile restart retains its original ordinary create behavior',async()=>{
  const original=SessionController.prototype.create,first=await fixture()
  try{
    const controller=new SessionController(first.ctx,{nativeOpen:false}),guard=first.ctx.plugin(GuardPlugin);await guard
    await guard.dispose();assert.notEqual(controller.create,original)
  }finally{await first.close()}
  const fresh=await fixture();try{
    const controller=new SessionController(fresh.ctx,{nativeOpen:false})
    assert.equal(controller.create,original);assert.equal(SessionController.prototype.create,original)
    assert.equal(fresh.ctx.get('collaborationGuiControllerReady'),undefined)
    fresh.ctx.typert.register(sessionControllerManifest as TypertContribution)
    assert.ok((await fresh.invoke({cwd:fresh.project})).sessionId)
    assert.equal(fresh.calls.filter(call=>call==='session_create').length,1)
  }finally{await fresh.close()}
})

test('live guard proof refuses a changed instance method instead of trusting its surviving ready marker',async()=>{
  const f=await fixture();try{
    const controller=guardedController(f.ctx)
    Object.defineProperty(controller,'create',{value:SessionController.prototype.create,configurable:true})
    assert.equal(f.ctx.collaborationGuiControllerReady.ready,true)
    assert.throws(()=>assertGuiSessionControllerGuard(f.ctx),{code:'UNMEDIATED_WRITE_DENIED'})
    assert.equal(f.calls.includes('session_create'),false)
  }finally{await f.close()}
})

test('live guard refuses changed general readiness even while its private installation remains active',async()=>{
  const f=await fixture();try{
    guardedController(f.ctx)
    Reflect.deleteProperty(f.ctx.collaborationReady,'gui')
    const target=join(f.dir,'no-longer-ready')
    await assert.rejects(f.invoke({cwd:target}),{code:'UNMEDIATED_WRITE_DENIED'})
    assert.equal(existsSync(target),false);assert.equal(f.calls.includes('session_create'),false)
  }finally{await f.close()}
})
