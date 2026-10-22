/**
 * Production root-plugin component wiring, NOT a fully activated GUI profile.
 * Actual Loader Include topology and installed package metadata; unrelated GUI
 * rows are explicitly detached metadata (no webserver/connection/UI provider).
 * Real core/guarded editor/preset/controller/Gateway, root-created persistence
 * and readiness, actual coordinator SQLite behind an in-process call seam.
 * No listener, transport substitution in product code, model adapter or request.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,mkdtempSync,mkdirSync,rmSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {Entry,EntryTree,Loader} from '@deepseek-ai/cordis-plugin-loader'
import {PluginPackages} from '@deepseek-ai/dsh-app-boot'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import {TYPERT as sessionManifest} from '@deepseek-ai/dsh-api-session-controller/typert'
import SessionController,{type SessionCreateRequest} from '@deepseek-ai/dsh-api-session-controller'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore,{SESSION_FORMAT_VERSION,SessionId,type SessionHeader} from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type {PeerId,PeerScope} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry,{type TypertContribution} from '@deepseek-ai/dsh-typert-registry'
import {Coordinator} from '../../src/coordinator.ts'
import {resolveConfig} from '../../src/config.ts'
import {CoordinationError} from '../../src/errors.ts'
import {applyWithClient} from '../../src/plugin.ts'
import {ProtectedFileSystem} from '../../src/host/filesystem.ts'
import {GuiConfigEditor} from '../../src/host/gui-config-editor.ts'
import GuardPlugin,{assertGuiSessionControllerGuard} from '../../src/host/gui-session-controller.ts'
import {CoordinationSessionPersistence} from '../../src/host/persistence.ts'
import {GUI_ROOT_MODULES} from '../../src/host/gui-profile-contract.ts'
import {buildGuiOverlay,checkActiveGuiProfile,type GuiBaseEntry} from '../../src/host/gui-profile.ts'
import type {RuntimeIdentity} from '../../src/types.ts'

class DetachedTree extends EntryTree {write(){}}
class PointQuery extends SessionQueryEngine {
  override searchSessions():Promise<never>{return Promise.reject(new Error('No search in mounted controller fixture'))}
  override searchEvents():Promise<never>{return Promise.reject(new Error('No search in mounted controller fixture'))}
}
function header(id:string,cwd:string):SessionHeader{return{id:SessionId(id),cwd,version:SESSION_FORMAT_VERSION,createdAt:1,isSeeded:false}}
const denied={code:'UNMEDIATED_WRITE_DENIED'}

async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'dsh-mounted-gui-')),home=join(dir,'home'),project=join(dir,'project'),data=join(home,'coordination')
  mkdirSync(home);mkdirSync(project);mkdirSync(join(dir,'node_modules','@nerofirstgit'),{recursive:true})
  // Real installed manifests, not asserted package-name/version strings.
  symlinkSync(resolve('node_modules/@deepseek-ai'),join(dir,'node_modules','@deepseek-ai'),process.platform==='win32'?'junction':'dir')
  symlinkSync(resolve('.'),join(dir,'node_modules','@nerofirstgit','dsh-collaboration'),process.platform==='win32'?'junction':'dir')
  const ctx=new Context(),config=resolveConfig({data_dir:data,heartbeat_ms:60000,offline_ms:120000}),coordinator=new Coordinator(config)
  ctx.baseUrl=pathToFileURL(join(dir,'anchor.js')).href
  await ctx.plugin(Loader,{baseUrl:ctx.baseUrl});await ctx.plugin(PluginPackages)
  ctx.provide('profileContext',{name:'web',home,dir:join(home,'profiles','web'),patchPath:join(home,'profiles','web','cordis.patch.yml'),cwd:home,
    installAnchor:join(home,'profiles','web','package.json'),startedBundles:[],overlays:[],telemetryDisabledEnv:undefined})
  const base:GuiBaseEntry[]=Object.entries(GUI_ROOT_MODULES).filter(([id])=>id!=='preset-collaboration').map(([id,name])=>({id,name}))
  const rows=structuredClone(base)
  for(const patch of buildGuiOverlay({surface:'web',home,profile_dir:join(home,'profiles','web'),data_dir:data,existing_entries:base})){
    if('insert'in patch)rows.push(...patch.insert);else Object.assign(rows.find(row=>row.id===patch.id)!,patch)
  }
  const include=new Entry(ctx.loader);include.options={id:'include',name:'cordis:include'};include.parent=ctx.loader.root
  const tree=new DetachedTree(ctx);include.subtree=tree;ctx.loader.store.include=include
  for(const row of rows){const entry=new Entry(ctx.loader);entry.options=row;entry.parent=tree.root;tree.store[row.id]=entry}
  // Only these real runtime services are mounted. Detached inventory rows do
  // not imply real GUI boot, provider startup ordering or browser acceptance.
  await ctx.plugin(ProtectedFileSystem,{cwd:home})
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt,{personaPrefix:'Mounted controller fixture; no model adapter installed'})
  await ctx.plugin(ToolRuntime,{mode:'native'});await ctx.plugin(AgentRegistry)
  await ctx.plugin(TypertRegistry);await ctx.plugin(RemoteAccess)
  // Actual carrier dependency gate, without mounting an HTTP/WebSocket carrier.
  const gatewayGate=ctx.inject(['collaborationGuiControllerReady'],async inner=>{await inner.plugin(TypertGateway,{})})
  const jobsGate=ctx.inject(['collaborationReady'],async inner=>{await inner.plugin(LocalJobRegistry)})
  ctx.typert.register(sessionManifest as TypertContribution)
  new PointQuery(ctx)
  let beforeSelection:()=>void=()=>{}
  ctx.provide('agentDefaultModel',{currentSelection:()=>{beforeSelection();return{provider:'never-requested',model:'none'}},saveSelection:async()=>{}} as never)
  ctx.provide('fileUploads',{registerAgentResolver:()=>()=>{}} as never)
  ctx.provide('workspaceRegistry',{get:()=>undefined,list:()=>[],archivedSessionIds:[]} as never)
  await ctx.plugin(GuiConfigEditor)
  await ctx.plugin(AgentPresets,tree.store['agent-preset-registry']!.options.config)
  await ctx.plugin(AgentPreset,tree.store['preset-collaboration']!.options.config)
  // Keep the real stock provider for its browser/strict schema package identity.
  // The guard plugin remains dependency-pending until the root publishes READY;
  // only its installed capability can then activate the actual Gateway.
  new SessionController(ctx,{nativeOpen:false})
  const guardFork=ctx.plugin(GuardPlugin)
  const calls:{method:string;params:Record<string,unknown>}[]=[]
  let reservation:(params:Record<string,unknown>)=>Promise<unknown>=async params=>coordinator.dispatch('mounted-gui','reserve_host_state_roots',params)
  const client={async call(method:string,params:Record<string,unknown>={},identity?:RuntimeIdentity):Promise<unknown>{
    calls.push({method,params:structuredClone(params)})
    return method==='reserve_host_state_roots'?reservation(params):coordinator.dispatch('mounted-gui',method,params,identity)
  }}
  const peer:PeerScope={id:'mounted-gui-peer' as PeerId,ctx,principal:{kind:'owner'},interactions:'answer',signal:new AbortController().signal,dispose:async()=>{}}
  function invoke(request:SessionCreateRequest){return ctx.typertGateway.invoke({peer,namespace:'session',method:'create',args:{request}}) as Promise<{sessionId:SessionId}>}
  function mount(){return Promise.resolve(applyWithClient(ctx,client,{...config,profile_mode:'gui',gui_surface:'web'}))}
  async function activateGuard(){await jobsGate;await guardFork;await gatewayGate;assertGuiSessionControllerGuard(ctx)}
  async function activateLoop(){await activateGuard();await ctx.plugin(AgentLoop,{agents:[]})}
  function reservedRoots():string[]{return JSON.parse(String(coordinator.store.db.prepare('SELECT snapshot FROM host_state_reservations WHERE singleton=1').get()!.snapshot)).roots}
  return{dir,home,project,ctx,coordinator,calls,tree,invoke,mount,activateGuard,activateLoop,reservedRoots,guardFork,
    beforeSelection(fn:()=>void){beforeSelection=fn},
    reservation(fn:(params:Record<string,unknown>)=>Promise<unknown>){reservation=fn},
    async close(){await ctx.fiber.dispose();coordinator.disconnect('mounted-gui');coordinator.close();rmSync(dir,{recursive:true,force:true})}}
}

test('production GUI root mount reserves state and creates the actual persistence/readiness used by Gateway → controller → idle AgentLoop',async()=>{
  const f=await fixture();try{
    assert.equal(f.ctx.get('sessionPersistence'),undefined);assert.equal(f.ctx.get('collaborationReady'),undefined)
    await f.mount();await f.activateLoop()
    assert.ok(f.ctx.sessionPersistence instanceof CoordinationSessionPersistence)
    assert.equal(f.ctx.collaborationReady.ready,true);assert.ok(f.ctx.collaborationReady.gui)
    assert.equal(checkActiveGuiProfile(f.ctx).phase,'ready')
    assert.deepEqual(f.calls[0],{method:'reserve_host_state_roots',params:{roots:[f.home]}})
    assert.deepEqual(f.reservedRoots(),[f.home])
    const target=join(f.dir,'new-project')
    const created=await f.invoke({cwd:target})
    assert.equal(existsSync(target),true)
    const agent=f.ctx.agents.get(created.sessionId);assert.ok(agent)
    assert.equal(agent.status,'idle');assert.equal(agent.session.header.cwd,target)
    assert.equal(agent.session.header.agentPreset,'collaboration')
    assert.equal(f.calls.filter(row=>row.method==='session_create').length,1)
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM host_sessions').get()!.n,1)
    const invalid=join(f.home,'must-not-be-created')
    await assert.rejects(f.invoke({cwd:invalid}),denied)
    assert.equal(existsSync(invalid),false)
    assert.equal(f.calls.filter(row=>row.method==='session_create').length,1)
    assert.equal(existsSync(join(f.home,'profiles')),false)
  }finally{await f.close()}
})

test('pending startup reservation keeps the actual Gateway unavailable and root-created write persistence closed until the exact acknowledgment',async()=>{
  const f=await fixture();let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  try{
    f.reservation(async params=>{await gate;return f.coordinator.dispatch('mounted-gui','reserve_host_state_roots',params)})
    const mounting=f.mount()
    assert.ok(f.ctx.sessionPersistence instanceof CoordinationSessionPersistence)
    assert.equal(f.ctx.get('collaborationReady'),undefined);assert.deepEqual(f.reservedRoots(),[])
    const target=join(f.dir,'pending-project')
    assert.equal(f.ctx.get('typertGateway'),undefined);assert.equal(f.ctx.get('collaborationGuiControllerReady'),undefined)
    await assert.rejects(f.ctx.sessionPersistence.create(header('early-direct',f.project)),denied)
    assert.equal(existsSync(target),false);assert.equal(f.calls.some(row=>row.method==='session_create'),false)
    release();await mounting;assert.equal(f.ctx.collaborationReady.ready,true)
    assert.deepEqual(f.reservedRoots(),[f.home])
    await f.activateLoop();assert.ok((await f.invoke({cwd:target})).sessionId)
  }finally{release();await f.close()}
})

for(const kind of ['rejected','empty-ack','wrong-root-ack','extra-root-ack','committed-reply-lost'] as const){
  test(`startup reservation ${kind} never publishes GUI readiness or admits session creation`,async()=>{
    const f=await fixture();try{
      f.reservation(async params=>{
        if(kind==='rejected')throw new CoordinationError('COORDINATOR_UNAVAILABLE','Fixture startup rejection')
        if(kind==='committed-reply-lost'){
          await f.coordinator.dispatch('mounted-gui','reserve_host_state_roots',params)
          throw new CoordinationError('OUTCOME_UNKNOWN','Fixture lost reservation reply after durable commit')
        }
        return{roots:kind==='empty-ack'?[]:kind==='wrong-root-ack'?[f.project]:[f.home,f.project]}
      })
      await assert.rejects(f.mount(),{code:kind==='rejected'?'COORDINATOR_UNAVAILABLE':kind==='committed-reply-lost'?'OUTCOME_UNKNOWN':'STORAGE_ERROR'})
      assert.equal(f.ctx.get('collaborationReady'),undefined)
      assert.deepEqual(f.reservedRoots(),kind==='committed-reply-lost'?[f.home]:[])
      const target=join(f.dir,'startup-failed-project')
      assert.equal(f.ctx.get('typertGateway'),undefined);assert.equal(f.ctx.get('collaborationGuiControllerReady'),undefined)
      await assert.rejects(f.ctx.sessionPersistence.create(header('no-startup-owner',f.project)),denied)
      assert.equal(existsSync(target),false);assert.equal(f.calls.some(row=>row.method==='session_create'),false)
      assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM host_sessions').get()!.n,0)
    }finally{await f.close()}
  })
}

test('disposing the actual root mount before a late durable reservation reply never publishes readiness',async()=>{
  const f=await fixture();let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  try{
    f.reservation(async params=>{await gate;return f.coordinator.dispatch('mounted-gui','reserve_host_state_roots',params)})
    // Whole-root disposal removes Loader/profileContext; the late continuation
    // can fail its state-root check before reaching publishReady's disposed guard.
    const mounting=f.mount(),rejected=assert.rejects(mounting,error=>error instanceof CoordinationError&&
      (error.code==='COORDINATOR_UNAVAILABLE'||error.code==='UNMEDIATED_WRITE_DENIED'))
    await f.ctx.fiber.dispose();release();await rejected
    assert.equal(f.ctx.get('collaborationReady'),undefined)
    assert.deepEqual(f.reservedRoots(),[f.home])
    assert.equal(f.calls.some(row=>row.method==='session_create'),false)
  }finally{release();await f.close()}
})

test('production-created provider rechecks roots before write-open but read-only inspection does not claim execution admission',async()=>{
  const f=await fixture();try{
    await f.mount();await f.activateGuard()
    const id=SessionId('reopen-root-check'),handle=await f.ctx.sessionPersistence.create(header(id,f.project))
    await handle.close()
    const before=f.coordinator.store.db.prepare('SELECT incarnation_id,execution_epoch FROM sessions WHERE id=?').get(id)
    f.tree.store['storage-json']!.options.config={root:join(f.home,'changed-storage')}
    const readonly=await f.ctx.sessionPersistence.open(id,'read');assert.equal(readonly.header.cwd,f.project);await readonly.close()
    const calls=f.calls.length
    await assert.rejects(f.ctx.sessionPersistence.open(id,'write'),denied)
    await assert.rejects(f.ctx.sessionPersistence.create(header('new-root-check',f.project)),denied)
    assert.equal(f.calls.slice(calls).some(row=>row.method==='session_open'||row.method==='session_create'),false)
    assert.deepEqual(f.coordinator.store.db.prepare('SELECT incarnation_id,execution_epoch FROM sessions WHERE id=?').get(id),before)
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM host_sessions').get()!.n,1)
  }finally{await f.close()}
})

test('stopping only the installed controller guard closes a stock create already past human mkdir at production persistence admission',async()=>{
  const f=await fixture();let stopping:Promise<unknown>|undefined
  try{
    await f.mount();await f.activateLoop()
    const target=join(f.dir,'human-mkdir-before-stop')
    // Existing narrow model-selection fixture is queried by pinned createAgent
    // AFTER mkdir and BEFORE agents.create. This synchronous scheduling hook
    // stops the real guard fiber without replacing stock methods/persistence.
    f.beforeSelection(()=>{
      assert.equal(existsSync(target),true)
      stopping=Promise.resolve(f.guardFork.dispose())
    })
    await assert.rejects(f.invoke({cwd:target}),{code:'gateway/internal',message:/GUI controller admission/})
    assert.ok(stopping);await stopping
    assert.equal(f.ctx.collaborationReady.ready,true,'Only the guard fiber stopped, not the root plugin')
    assert.equal(f.ctx.get('collaborationGuiControllerReady'),undefined)
    assert.equal(f.ctx.get('typertGateway'),undefined,'The real dependency-gated Gateway is withdrawn')
    assert.equal(f.calls.some(row=>row.method==='session_create'),false)
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM host_sessions').get()!.n,0)
    await assert.rejects(f.ctx.sessionPersistence.create(header('after-guard-stop',f.project)),denied)
    assert.equal(f.calls.some(row=>row.method==='session_create'),false)
  }finally{await stopping;await f.close()}
})
