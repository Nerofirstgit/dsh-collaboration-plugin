/** Real Loader records + ordinary filesystem; no provider/server/model is started. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {Entry,Loader} from '@deepseek-ai/cordis-plugin-loader'
import {createGuiStateRootsGuard} from '../../src/host/gui-state-roots.ts'

const denied={code:'UNMEDIATED_WRITE_DENIED'}
async function fixture(){
  const base=mkdtempSync(join(tmpdir(),'dsh-gui-roots-'))
  const home=join(base,'harness'),workspaceA=join(base,'project-a'),workspaceB=join(base,'project-b')
  for(const path of [home,workspaceA,workspaceB])mkdirSync(path)
  const profile={name:'web',home,dir:join(home,'profiles','web'),patchPath:join(home,'profiles','web','cordis.patch.yml'),cwd:workspaceA,
    installAnchor:join(home,'profiles','web','package.json'),startedBundles:[],overlays:[],telemetryDisabledEnv:undefined}
  const ctx=new Context();await ctx.plugin(Loader,{})
  ctx.provide('profileContext',profile)
  function add(id:string,name:string,config:unknown={}){const entry=new Entry(ctx.loader);entry.options={id,name,config};entry.parent=ctx.loader.root;ctx.loader.store[id]=entry;return entry}
  const entries={
    storage:add('storage-json','@deepseek-ai/dsh-storage-json',{root:join(home,'storages')}),
    domain:add('storage-domain','@deepseek-ai/dsh-storage-domain',{backend:'json',routes:{}}),
    attachment:add('attachment-local','@deepseek-ai/dsh-attachment-local',{dshHome:home}),
    credentials:add('credentials','@deepseek-ai/dsh-credentials-local',{dshHome:home}),
    query:add('session-query-sqlite','@deepseek-ai/dsh-session-query-sqlite',{path:':memory:',openAt:'never'}),
  }
  return{base,home,workspaceA,workspaceB,profile,ctx,entries,add,async close(){await ctx.fiber.dispose();rmSync(base,{recursive:true,force:true})}}
}

test('derives pinned provider roots from actual Loader/profile and admits two separate projects without creating state',async()=>{
  const f=await fixture();try{
    const guard=createGuiStateRootsGuard(f.ctx),e=guard.evidence
    assert.equal(e.home,f.home);assert.equal(e.storage_root,join(f.home,'storages'))
    assert.equal(e.attachment_root,join(f.home,'attachments','v1'));assert.equal(e.attachment_cache_root,join(f.home,'cache','attachments'))
    assert.equal(e.credentials_file,join(f.home,'.credentials.yaml'));assert.equal(e.query_database,null)
    assert.equal(e.profile_patch,f.profile.patchPath);assert.equal(e.fingerprint.length,64)
    guard.assertSessionAllowed({cwd:f.workspaceA,workspace_root:f.workspaceA})
    guard.assertSessionAllowed({cwd:f.workspaceB,workspace_root:f.workspaceB})
    guard.assertUnchanged()
    for(const path of [e.storage_root,e.attachment_root,e.profile_root,e.credentials_file])assert.equal(existsSync(path),false)
    assert.ok(Object.isFrozen(e));assert.ok(Object.isFrozen(e.roots))
  }finally{await f.close()}
})

test('rejects Harness home inside the actual resolved workspace, even when session cwd is a sibling subdirectory',async()=>{
  const f=await fixture();try{
    const cwd=join(f.base,'src');mkdirSync(cwd)
    const guard=createGuiStateRootsGuard(f.ctx)
    assert.throws(()=>guard.assertSessionAllowed({cwd,workspace_root:f.base}),denied)
    assert.throws(()=>guard.assertSessionAllowed({cwd:f.home,workspace_root:f.home}),denied)
    assert.equal(existsSync(f.profile.dir),false)
  }finally{await f.close()}
})

test('rejects provider state configured inside a project before any parent/leaf is made',async()=>{
  const f=await fixture();try{
    const path=join(f.workspaceA,'not-created','storages');f.entries.storage.options.config={root:path}
    assert.throws(()=>createGuiStateRootsGuard(f.ctx),denied);assert.equal(existsSync(join(f.workspaceA,'not-created')),false)
  }finally{await f.close()}
})

test('canonicalizes state and project directory aliases before the overlap decision',async()=>{
  const f=await fixture();try{
    const alias=join(f.base,'home-alias');symlinkSync(f.home,alias,'dir')
    f.entries.storage.options.config={root:join(alias,'storages')}
    const guard=createGuiStateRootsGuard(f.ctx);assert.equal(guard.evidence.storage_root,join(f.home,'storages'))
    assert.throws(()=>guard.assertSessionAllowed({cwd:alias,workspace_root:alias}),denied)
    const linked=join(f.home,'linked-project');symlinkSync(f.workspaceA,linked,'dir')
    f.entries.storage.options.config={root:join(linked,'cache')}
    assert.throws(()=>createGuiStateRootsGuard(f.ctx),denied)
  }finally{await f.close()}
})

test('changed effective storage config or profile patch invalidates prior approval, including still-outside-project roots',async()=>{
  const f=await fixture();try{
    const guard=createGuiStateRootsGuard(f.ctx)
    f.entries.storage.options.config={root:join(f.home,'other-storage')}
    assert.throws(()=>guard.assertUnchanged(),denied)
    assert.throws(()=>guard.assertSessionAllowed({cwd:f.workspaceA,workspace_root:f.workspaceA}),denied)
    f.entries.storage.options.config={root:join(f.home,'storages')}
    guard.assertUnchanged();f.profile.patchPath=join(f.profile.dir,'changed.yml')
    assert.throws(()=>guard.assertUnchanged(),denied)
  }finally{await f.close()}
})

test('only JSON domain routes are allowed; credentials filename and SQLite sidecar parents are derived',async()=>{
  const f=await fixture();try{
    f.entries.domain.options.config={backend:'json',routes:{workspace:'json',session_projcache:'json'}}
    f.entries.credentials.options.config={path:join(f.home,'secrets','credentials.yml')}
    f.entries.query.options.config={path:join(f.home,'cache','query','index.sqlite'),openAt:'first-search'}
    const guard=createGuiStateRootsGuard(f.ctx),e=guard.evidence
    assert.equal(e.credentials_file,join(f.home,'secrets','credentials.yml'));assert.equal(e.query_database,join(f.home,'cache','query','index.sqlite'))
    assert.equal(e.roots.find(r=>r.id==='credentials')?.path,join(f.home,'secrets'))
    assert.equal(e.roots.find(r=>r.id==='session-query')?.path,join(f.home,'cache','query'))
    f.entries.domain.options.config={backend:'json',routes:{workspace:'other'}}
    assert.throws(()=>guard.assertUnchanged(),denied)
  }finally{await f.close()}
})

test('unused query path is not a writable root when never-open or in-memory',async()=>{
  const f=await fixture();try{
    f.entries.query.options.config={path:join(f.workspaceA,'unused.sqlite'),openAt:'never'}
    assert.equal(createGuiStateRootsGuard(f.ctx).evidence.query_database,null)
    f.entries.query.options.config={path:':memory:',openAt:'startup'}
    assert.equal(createGuiStateRootsGuard(f.ctx).evidence.query_database,null)
    f.entries.query.options.config={path:join(f.workspaceA,'used.sqlite'),openAt:'startup'}
    assert.throws(()=>createGuiStateRootsGuard(f.ctx),denied)
  }finally{await f.close()}
})

test('provider defaults are actual DSH_HOME defaults, not an invented profileContext fallback',async()=>{
  const f=await fixture(),previous=process.env.DSH_HOME
  try{
    f.entries.credentials.options.config={};f.entries.attachment.options.config={}
    process.env.DSH_HOME=f.home
    const guard=createGuiStateRootsGuard(f.ctx);assert.equal(guard.evidence.credentials_file,join(f.home,'.credentials.yaml'))
    process.env.DSH_HOME=f.workspaceB
    assert.throws(()=>guard.assertUnchanged(),denied)
    assert.equal(existsSync(join(f.workspaceB,'attachments')),false)
  }finally{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;await f.close()}
})

test('planned workspace preflight admits a separate missing leaf but rejects state ancestry without mkdir',async()=>{
  const f=await fixture();try{
    const guard=createGuiStateRootsGuard(f.ctx),path=join(f.workspaceA,'new','workspace')
    assert.equal(guard.assertWorkspacePathAllowed(path),path);assert.equal(existsSync(path),false)
    assert.throws(()=>guard.assertWorkspacePathAllowed(join(f.home,'new-workspace')),denied)
    assert.throws(()=>guard.assertWorkspacePathAllowed(f.base),denied)
  }finally{await f.close()}
})

test('refuses unresolved path expressions, missing providers, wrong provider names and outside profile patch',async()=>{
  const f=await fixture();try{
    f.entries.storage.options.config={root:{__jsExpr:"dshHomePath('storages')"}}
    assert.throws(()=>createGuiStateRootsGuard(f.ctx),denied)
    f.entries.storage.options.config={root:join(f.home,'storages')}
    f.entries.credentials.options.name='replacement-provider';assert.throws(()=>createGuiStateRootsGuard(f.ctx),denied)
    f.entries.credentials.options.name='@deepseek-ai/dsh-credentials-local'
    f.profile.patchPath=join(f.workspaceA,'cordis.patch.yml');assert.throws(()=>createGuiStateRootsGuard(f.ctx),denied)
    f.profile.patchPath=join(f.profile.dir,'cordis.patch.yml');delete f.ctx.loader.store.credentials
    assert.throws(()=>createGuiStateRootsGuard(f.ctx),denied)
  }finally{await f.close()}
})

test('existing ordinary state files are canonicalized; non-directory planned ancestors fail closed',async()=>{
  const f=await fixture();try{
    writeFileSync(join(f.home,'.credentials.yaml'),'version: 1\n')
    assert.equal(createGuiStateRootsGuard(f.ctx).evidence.credentials_file,join(f.home,'.credentials.yaml'))
    writeFileSync(join(f.home,'not-a-directory'),'data');f.entries.storage.options.config={root:join(f.home,'not-a-directory','nested')}
    assert.throws(()=>createGuiStateRootsGuard(f.ctx),denied)
  }finally{await f.close()}
})

test('unmodeled office conversion scratch writer is not certified by otherwise valid state roots',async()=>{
  const f=await fixture();try{
    f.add('office-to-pdf','@deepseek-ai/dsh-office-to-pdf',{})
    assert.throws(()=>createGuiStateRootsGuard(f.ctx),denied)
  }finally{await f.close()}
})

test('a real readiness-gated pending Fiber has no resolved config yet: concrete raw paths work, expressions do not',async()=>{
  const f=await fixture();let bodyCalls=0
  try{
    const entry=f.entries.storage
    const plugin={inject:['guiRootsTestReady'],apply(){bodyCalls++}}
    entry.fiber=entry.ctx.registry.plugin(plugin,entry.options.config).ctx.fiber
    await Promise.resolve();await Promise.resolve()
    assert.equal(bodyCalls,0);assert.equal(entry.fiber.config,undefined)
    assert.equal(createGuiStateRootsGuard(f.ctx).evidence.storage_root,join(f.home,'storages'))
    entry.options.config={root:{__jsExpr:"dshHomePath('storages')"}}
    assert.throws(()=>createGuiStateRootsGuard(f.ctx),denied)
    assert.equal(bodyCalls,0);assert.equal(existsSync(join(f.home,'storages')),false)
  }finally{await f.close()}
})

test('normal approved provider directory creation does not invalidate stable root evidence',async()=>{
  const f=await fixture();try{
    const guard=createGuiStateRootsGuard(f.ctx)
    mkdirSync(guard.evidence.storage_root,{recursive:true})
    mkdirSync(guard.evidence.profile_root,{recursive:true})
    mkdirSync(guard.evidence.attachment_cache_root,{recursive:true})
    guard.assertUnchanged();guard.assertSessionAllowed({cwd:f.workspaceA,workspace_root:f.workspaceA})
  }finally{await f.close()}
})
