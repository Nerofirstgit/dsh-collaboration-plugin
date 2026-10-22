/** Configuration/Loader/provider checks only. No GUI, listener, transport or model startup. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {Context} from '@deepseek-ai/cordis'
import {Loader,Entry,EntryTree} from '@deepseek-ai/cordis-plugin-loader'
import {PluginPackages} from '@deepseek-ai/dsh-app-boot'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import {entryListSchema} from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import {GUI_ROOT_MODULES,GUI_DISABLED_ENTRIES} from '../../src/host/gui-profile-contract.ts'
import {GUI_PROFILE_MODULES,GUI_PROFILE_INJECT,GUI_BOOTSTRAP_ENTRIES,GUI_PUBLIC_CARRIERS,buildGuiOverlay,checkGuiProfileInventory,checkActiveGuiProfile,guiStateRootsGuard,type GuiBaseEntry} from '../../src/host/gui-profile.ts'
import type {ProfileEntryEvidence} from '../../src/host/profile.ts'
import {ProtectedFileSystem} from '../../src/host/filesystem.ts'
import {CoordinationSessionPersistence} from '../../src/host/persistence.ts'
import {GuiConfigEditor} from '../../src/host/gui-config-editor.ts'
import {installGuiSessionControllerGuard} from '../../src/host/gui-session-controller.ts'

const denied={code:'UNMEDIATED_WRITE_DENIED'}
function base():GuiBaseEntry[]{return Object.entries(GUI_ROOT_MODULES).filter(([id])=>id!=='preset-collaboration').map(([id,name])=>({id,name}))}
function compose(base:GuiBaseEntry[],patches:ReturnType<typeof buildGuiOverlay>):GuiBaseEntry[]{
  const rows=structuredClone(base)
  for(const patch of patches){if('insert'in patch){rows.push(...patch.insert!);continue}
    const row=rows.find(row=>row.id===patch.id)!;Object.assign(row,patch)
  }return rows
}
function inventory(home=resolve('/tmp/dsh-gui-fixture-home')):ProfileEntryEvidence[]{
  const rows=compose(base(),buildGuiOverlay({surface:'web',home,profile_dir:join(home,'profiles','web'),data_dir:join(home,'collaboration'),existing_entries:base()}))
  return rows.map(row=>({...row,disabled:Boolean(row.disabled),scoped:false,package_name:row.name.split('/').slice(0,2).join('/'),package_version:row.name.startsWith('@nerofirstgit/')?'0.1.0-dev.0':row.id==='timer'?'1.1.7':'0.2.1-rc.2'}))
}
test('separate GUI component contract has a fixed inventory and deterministic evidence without path or secret disclosure',()=>{
  const rows=inventory(),result=checkGuiProfileInventory(rows,'web')
  assert.equal(result.profile,'pinned-cooperative-gui');assert.equal(result.surface,'web')
  assert.equal(result.entry_count,Object.keys(GUI_PROFILE_MODULES).length)
  assert.deepEqual(result,checkGuiProfileInventory([...rows].reverse(),'web'))
  rows.find(row=>row.id==='llm-deepseek')!.config={apiKey:'fixture-secret'}
  assert.ok(!JSON.stringify(checkGuiProfileInventory(rows,'web')).includes('fixture-secret'))
})
for(const[label,mutate]of Object.entries({
  'unknown enabled plugin':(r:ProfileEntryEvidence[])=>r.push({...r[0]!,id:'unknown',name:'unknown',disabled:false}),
  'same id alternate module':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='tools')!.name='unreviewed'},
  'duplicate id':(r:ProfileEntryEvidence[])=>r.push({...r[0]!}),
  'package version mismatch':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='tools')!.package_version='next'},
  'package identity mismatch':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='tools')!.package_name='fake'},
  'scoped replacement':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='tools')!.scoped=true},
  'missing GUI core':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='collaboration-gui-controller-guard')!.disabled=true},
  'stock config editor':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='config-editor')!.disabled=false},
  'raw shell executor':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='subprocess')!.disabled=false},
  'job execution controller':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='job-controller')!.disabled=false},
  'job execution tool':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='tool-jobs')!.disabled=false},
  'missing lifecycle registry':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='jobs')!.disabled=true},
  'writing snapshot helper':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='workspace-changes')!.disabled=false},
  'unbarriered credentials':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='credentials')!.inject=[]},
  'unbarriered settings':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='settings')!.inject=[]},
  'barrier cycle on producer':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='session-collaboration')!.inject=['collaborationReady']},
  'custom injection interceptor':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='tools')!.inject={fs:{mode:'write'}}},
  'missing web startup dependency':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='webserver')!.inject=['collaborationReady']},
  'missing controller guard barrier on gateway':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='typert-gateway')!.inject=['collaborationReady']},
  'guard cycle through connection':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='connection')!.inject=[...GUI_PROFILE_INJECT.connection!,'collaborationGuiControllerReady']},
  'declarative early agent':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='agent-loop')!.config={agents:[{}]}},
  'alternate dispatch mode':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='tools')!.config={mode:'prompt'}},
  'nonempty preset':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='preset-collaboration')!.config={id:'collaboration',plugins:[{name:'unsafe'}]}},
  'alternate default preset':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='agent-preset-registry')!.config={default:'standard'}},
  'writing query index':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='session-query-sqlite')!.config={path:'project.db',openAt:'startup'}},
  'unknown extra RPC manifest':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='typert-loader')!.config={packages:['unreviewed']}},
  'unresolved state expression':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='storage-json')!.config={root:{__jsExpr:'ctx.profileContext.home'}}},
  'nonlocal server binding':(r:ProfileEntryEvidence[])=>{r.find(e=>e.id==='webserver')!.config={host:'0.0.0.0',port:0}},
}))test(`GUI inventory refuses ${label}`,()=>{const rows=inventory();mutate(rows);assert.throws(()=>checkGuiProfileInventory(rows,'web'),denied)})

test('all retained consumers including state writers wait for readiness; bootstrap contains only producer dependencies',()=>{
  for(const id of Object.keys(GUI_PROFILE_MODULES))assert.equal(GUI_PROFILE_INJECT[id]!.includes('collaborationReady'),!GUI_BOOTSTRAP_ENTRIES.includes(id),id)
  for(const id of ['office-to-pdf','workspace-changes','ui-deliverables','otel','session-telemetry-otel','desktop-product-telemetry','product-analytics','permission','ui-permission','open-in-app','ui-open-in-app','subagent-model-selection-settings'])assert.ok(GUI_DISABLED_ENTRIES.includes(id),id)
})
test('controller prerequisites stay acyclic while actual GUI API carriers wait for its live-method guard',async()=>{
  const {inject:connectionInject}=await import('@deepseek-ai/dsh-client-connection')
  const {default:FileUploads}=await import('@deepseek-ai/dsh-client-file-upload')
  assert.ok(SessionController.inject.includes('fileUploads'))
  assert.ok(FileUploads.inject.includes('connection'))
  assert.deepEqual(connectionInject,['credentials'])
  for(const id of GUI_PUBLIC_CARRIERS)assert.ok(GUI_PROFILE_INJECT[id]!.includes('collaborationGuiControllerReady'),id)
  for(const id of ['session-controller','file-upload','connection','credentials','collaboration-gui-controller-guard'])assert.ok(!GUI_PROFILE_INJECT[id]!.includes('collaborationGuiControllerReady'),id)
  const rows=inventory()
  assert.equal(rows.find(row=>row.id==='session-controller')!.disabled,false)
  assert.equal(rows.find(row=>row.id==='session-controller')!.name,'@deepseek-ai/dsh-api-session-controller')
  assert.deepEqual(rows.find(row=>row.id==='typert-loader')!.config,{packages:[]})
})
test('builder updates installed bundle rows and never duplicates inserts on a second pass',()=>{
  const home=resolve('/tmp/dsh-gui-builder'),input={surface:'web' as const,home,profile_dir:join(home,'profiles','web'),data_dir:join(home,'collaboration')}
  const first=compose(base(),buildGuiOverlay({...input,existing_entries:base()}))
  const second=compose(first,buildGuiOverlay({...input,existing_entries:first}))
  assert.deepEqual(first,second);assert.equal(new Set(second.map(row=>row.id)).size,second.length)
  for(const id of ['session-collaboration','collaboration-filesystem','collaboration-config-editor','collaboration-gui-controller-guard','preset-collaboration'])assert.equal(second.filter(row=>row.id===id).length,1)
  const settings=second.find(row=>row.id==='session-collaboration')!.config as Record<string,unknown>
  assert.equal(settings.profile_mode,'gui');assert.equal(settings.gui_surface,'web');assert.equal(settings.communication_policy,'explicit_only')
})
test('builder refuses missing bundle, duplicate rows, wrong identities and relative state paths',()=>{
  const home=resolve('/tmp/dsh-gui-builder'),input={surface:'web' as const,home,profile_dir:join(home,'profiles','web'),data_dir:join(home,'collaboration'),existing_entries:base()}
  assert.throws(()=>buildGuiOverlay({...input,existing_entries:base().filter(row=>row.id!=='session-collaboration')}),denied)
  assert.throws(()=>buildGuiOverlay({...input,existing_entries:[...base(),base()[0]!]}),denied)
  assert.throws(()=>buildGuiOverlay({...input,home:'relative'}),denied)
  const rows=base();rows.find(row=>row.id==='tools')!.name='wrong';assert.throws(()=>buildGuiOverlay({...input,existing_entries:rows}),denied)
})

/** Real framework objects and provider classes; unrelated GUI rows are metadata only. RPC is an inert fixture. */
async function loaderFixture(){
  const dir=mkdtempSync(join(tmpdir(),'dsh-active-gui-')),home=join(dir,'home');mkdirSync(home)
  mkdirSync(join(dir,'node_modules','@nerofirstgit'),{recursive:true})
  const linkType=process.platform==='win32'?'junction':'dir'
  symlinkSync(resolve('node_modules/@deepseek-ai'),join(dir,'node_modules','@deepseek-ai'),linkType)
  symlinkSync(resolve('.'),join(dir,'node_modules','@nerofirstgit','dsh-collaboration'),linkType)
  const ctx=new Context();ctx.baseUrl=pathToFileURL(join(dir,'anchor.js')).href
  await ctx.plugin(Loader,{baseUrl:ctx.baseUrl});await ctx.plugin(PluginPackages)
  ctx.provide('profileContext',{name:'web',home,dir:join(home,'profiles','web'),patchPath:join(home,'profiles','web','cordis.patch.yml'),cwd:dir,installAnchor:join(home,'profiles','web','package.json'),startedBundles:[],overlays:[],telemetryDisabledEnv:undefined})
  await ctx.plugin(ProtectedFileSystem,{cwd:dir});new CoordinationSessionPersistence(ctx,{async call(){return{}}},{workspaceRoot:dir})
  class DetachedTree extends EntryTree{write(){}}
  const include=new Entry(ctx.loader);include.options={id:'include',name:'cordis:include'};include.parent=ctx.loader.root
  const tree=new DetachedTree(ctx);include.subtree=tree;ctx.loader.store.include=include
  for(const row of inventory(home)){
    const entry=new Entry(ctx.loader);entry.options={id:row.id,name:row.name,disabled:row.disabled,config:row.config,inject:row.inject as string[]|undefined};entry.parent=tree.root;tree.store[row.id]=entry
  }
  async function controller(kind:typeof SessionController=SessionController){
    await ctx.plugin(TypertRegistry);await ctx.plugin(SessionStore);await ctx.plugin(AgentRegistry)
    if(!ctx.get('sessionProjections'))await ctx.plugin(SessionProjections)
    // Unused request dependencies are explicit stubs. The controller itself is real;
    // no create/page command, model, GUI server or file upload is executed here.
    ctx.provide('fileUploads',{registerAgentResolver:()=>()=>{}} as never)
    ctx.provide('workspaceRegistry',{get:()=>undefined,list:()=>[],archivedSessionIds:[]} as never)
    ctx.provide('agentDefaultModel',{currentSelection:()=>undefined,saveSelection:async()=>{}} as never)
    return new kind(ctx,{nativeOpen:false})
  }
  async function ready(plugins:unknown[]=[],installControllerGuard=true,installJobs=true){
    checkActiveGuiProfile(ctx)
    await ctx.plugin(GuiConfigEditor);await controller()
    if(installJobs)await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(AgentPresets,tree.store['agent-preset-registry']!.options.config)
    await ctx.plugin(AgentPreset,{...(tree.store['preset-collaboration']!.options.config as Record<string,unknown>),plugins})
    const guard=guiStateRootsGuard(ctx)
    ctx.provide('collaborationReady',{ready:true,gui:{state_fingerprint:guard.evidence.fingerprint,assertWorkspacePathAllowed:path=>guard.assertWorkspacePathAllowed(path)}})
    if(installControllerGuard)installGuiSessionControllerGuard(ctx)
  }
  return{ctx,tree,include,home,dir,ready,controller,async close(){await ctx.fiber.dispose();rmSync(dir,{recursive:true,force:true})}}
}
test('actual Loader/installed manifests/real providers allow pending editor only before readiness, and real empty preset after readiness',async()=>{
  const f=await loaderFixture();try{
    const before=checkActiveGuiProfile(f.ctx);assert.equal(before.phase,'initial');assert.equal(before.state_roots_fingerprint.length,64)
    const guard=guiStateRootsGuard(f.ctx);assert.equal(guard.evidence.home,f.home)
    await f.ready();const after=checkActiveGuiProfile(f.ctx);assert.equal(after.phase,'ready');assert.equal(after.fingerprint,before.fingerprint)
    assert.equal(guiStateRootsGuard(f.ctx),guard)
  }finally{await f.close()}
})
test('after-ready cannot authorize metadata-only providers or missing registry',async()=>{
  const f=await loaderFixture();try{checkActiveGuiProfile(f.ctx);f.ctx.provide('collaborationReady',{ready:true});assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)}finally{await f.close()}
})
test('ready-time checker requires the real inspection-only jobs registry, not just its declared row',async()=>{
  const f=await loaderFixture();try{
    await f.ready([],true,false)
    assert.throws(()=>checkActiveGuiProfile(f.ctx),/actual pinned jobs registry/)
    f.ctx.provide('jobs',{list:()=>[]} as never)
    assert.throws(()=>checkActiveGuiProfile(f.ctx),/actual pinned jobs registry/)
  }finally{await f.close()}
})
test('real registry with extra empty preset is refused, not merely modules hidden by the UI',async()=>{
  const f=await loaderFixture();try{
    await f.ready();const dispose=await f.ctx.agentPresets.register({id:'other',plugins:[]});f.ctx.effect(()=>dispose)
    assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)
  }finally{await f.close()}
})
test('after-ready refuses missing actual preset registry even with the actual editor',async()=>{
  const f=await loaderFixture();try{await f.ctx.plugin(GuiConfigEditor);await f.controller();f.ctx.provide('collaborationReady',{ready:true});assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)}finally{await f.close()}
})
test('stock controller may initialize before guard, but cannot authorize ready-time execution unguarded',async()=>{
  const f=await loaderFixture();try{await f.controller();assert.equal(checkActiveGuiProfile(f.ctx).phase,'initial');f.ctx.provide('collaborationReady',{ready:true});assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)}finally{await f.close()}
})
test('claimed guard capability cannot substitute for the owned live method proof',async()=>{
  const f=await loaderFixture();try{
    await f.ready([],false);f.ctx.provide('collaborationGuiControllerReady',{ready:true})
    assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)
  }finally{await f.close()}
})
test('ready-time checker rejects replacement of the guarded public create method',async()=>{
  const f=await loaderFixture();try{
    await f.ready();assert.equal(checkActiveGuiProfile(f.ctx).phase,'ready')
    Object.defineProperty(f.ctx.sessionController,'create',{value:SessionController.prototype.create,configurable:true})
    assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)
  }finally{await f.close()}
})
test('before-ready refuses an already mounted unreviewed config-editor provider',async()=>{
  const f=await loaderFixture();try{f.ctx.provide('configEditor',{} as never);assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)}finally{await f.close()}
})
test('actual registry default and active module revisions are rechecked',async()=>{
  const f=await loaderFixture();try{
    await f.ready();checkActiveGuiProfile(f.ctx)
    f.ctx.agentPresets.config.default='other';assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)
    f.ctx.agentPresets.config.default='collaboration'
    const marker=join(f.dir,'marker.mjs');writeFileSync(marker,'export function apply() {}\n')
    const dispose=await f.ctx.agentPresets.register({id:'another',plugins:[{name:pathToFileURL(marker).href}]});f.ctx.effect(()=>dispose)
    assert.equal(f.ctx.agentPresets.inspectCompositions().find(row=>row.id==='another')!.modules.length,1)
    assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)
  }finally{await f.close()}
})
test('one actual same-id preset with an extra active module is refused despite empty declared metadata',async()=>{
  const f=await loaderFixture();try{
    const marker=join(f.dir,'same-id-marker.mjs');writeFileSync(marker,'export function apply() {}\n')
    await f.ready([{name:pathToFileURL(marker).href}])
    const [actual]=f.ctx.agentPresets.inspectCompositions();assert.equal(actual!.id,'collaboration');assert.equal(actual!.modules.length,1)
    assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)
  }finally{await f.close()}
})
test('state-root guard persists across rechecks and refuses an in-home root change',async()=>{
  const f=await loaderFixture();try{
    checkActiveGuiProfile(f.ctx);f.tree.store['storage-json']!.options.config={root:join(f.home,'different-storages')}
    assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)
  }finally{await f.close()}
})
test('actual nested include and scoped service interception are rejected',async()=>{
  const f=await loaderFixture();try{
    ;(f.tree.store.tools!.options as unknown as Record<string,unknown>).intercept={fs:{write:true}}
    assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)
    delete(f.tree.store.tools!.options as unknown as Record<string,unknown>).intercept
    f.include.parent=f.tree.root;assert.throws(()=>checkActiveGuiProfile(f.ctx),denied)
  }finally{await f.close()}
})
test('no caller boolean can replace actual host providers and profile context',()=>{
  const ctx=new Context();ctx.provide('collaborationReady',{ready:true});assert.throws(()=>checkActiveGuiProfile(ctx),denied)
})

test('every declared retained browser dependency has an enabled actual package identity',()=>{
  // Static npm declarations only: this is not a browser runtime/visual acceptance test.
  const activePackages=new Set(Object.values(GUI_PROFILE_MODULES).map(name=>name.split('/').slice(0,2).join('/')))
  let checked=0
  for(const[id,name]of Object.entries(GUI_PROFILE_MODULES)){
    if(!name.startsWith('@deepseek-ai/'))continue
    const path=join('node_modules',name.split('/').slice(0,2).join('/'),'package.json')
    const meta=JSON.parse(readFileSync(path,'utf8')) as {dsh?:{client?:{inject?:string[]}}}
    for(const dependency of meta.dsh?.client?.inject??[]){checked++;assert.ok(activePackages.has(dependency),`${id} requests missing ${dependency}`)}
  }
  assert.equal(checked,207,'pinned browser dependency inventory changed; review before updating the count')
})
test('retained pinned host modules have no literal mandatory dependency on removed executor services',()=>{
  // Bounded static closure check; optional/dynamic injection and GUI activation remain separate gates.
  const removed=new Set(['subprocess','shell','subagents','workspaceChanges','sandbox'])
  for(const[id,name]of Object.entries(GUI_PROFILE_MODULES)){
    if(!name.startsWith('@deepseek-ai/'))continue
    const source=readFileSync(new URL(import.meta.resolve(name)),'utf8')
    for(const match of source.matchAll(/(?:static|const|var|let)\s+inject\s*=\s*(\[[\s\S]*?\])/g)){
      for(const quoted of match[1]!.matchAll(/["']([^"']+)["']/g))assert.ok(!removed.has(quoted[1]!),`${id} requires removed ${quoted[1]}`)
    }
  }
})
test('official dump-config composes installed bundle plus generated GUI overlay without activating any plugin',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dsh-gui-overlay-')),home=join(dir,'home');mkdirSync(home)
  const args=['node_modules/@deepseek-ai/dsh/lib/bin.js','--profile','web','--patch',resolve('cordis.patch.yml'),'--dump-config']
  const options={cwd:resolve('.'),env:{...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'},encoding:'utf8' as const}
  try{
    const first=spawnSync(process.execPath,args,options);assert.equal(first.status,0,first.stderr)
    const rows=yaml.load(first.stdout,{schema:entryListSchema}) as GuiBaseEntry[]
    const patches=buildGuiOverlay({surface:'web',home,profile_dir:join(home,'profiles','web'),data_dir:join(home,'collaboration'),existing_entries:rows})
    const patchPath=join(dir,'gui.patch.yml');writeFileSync(patchPath,yaml.dump(patches,{schema:entryListSchema}))
    const result=spawnSync(process.execPath,[...args.slice(0,-1),'--patch',patchPath,'--dump-config'],options);assert.equal(result.status,0,result.stderr)
    const composed=yaml.load(result.stdout,{schema:entryListSchema}) as GuiBaseEntry[]
    const metadata=new Map(inventory(home).map(row=>[row.id,row]))
    const evidence=composed.map(row=>({...metadata.get(row.id)!,...row,disabled:Boolean(row.disabled)}))
    assert.equal(checkGuiProfileInventory(evidence,'web').entry_count,Object.keys(GUI_PROFILE_MODULES).length)
    assert.equal(new Set(composed.map(row=>row.id)).size,composed.length)
  }finally{rmSync(dir,{recursive:true,force:true})}
})
