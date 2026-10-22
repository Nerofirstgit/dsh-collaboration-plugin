/** Closed-profile contracts. No daemon socket or model API is started here. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {Context} from '@deepseek-ai/cordis'
import {Loader,Entry,EntryTree} from '@deepseek-ai/cordis-plugin-loader'
import {PluginPackages} from '@deepseek-ai/dsh-app-boot'
import {entryListSchema} from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import {ALLOWED_PROFILE_ENTRIES,checkActiveProfile,checkProfileInventory,type ProfileEntryEvidence} from '../../src/host/profile.ts'
import {CoordinationSessionPersistence} from '../../src/host/persistence.ts'
import {ProtectedFileSystem} from '../../src/host/filesystem.ts'

function inventory():ProfileEntryEvidence[]{
  return Object.entries(ALLOWED_PROFILE_ENTRIES).map(([id,name])=>({id,name,disabled:false,scoped:false,
    package_name:name.split('/').slice(0,2).join('/'),
    package_version:name.startsWith('@nerofirstgit/')?'0.1.0-dev.0':id==='timer'?'1.1.7':'0.2.1-rc.2',
    config:id==='tools'?{mode:'native'}:id==='agent-loop'?{agents:[]}:id==='session-query-sqlite'?{path:':memory:',openAt:'never'}:{},
    inject:id==='agent-loop'?['sessionPersistence','collaborationReady']:id==='headless-runner'?['headlessStartup','collaborationReady']:undefined,
  }))
}
const denied={code:'UNMEDIATED_WRITE_DENIED'}
test('enabled-profile accepts only the pinned minimal composition and has deterministic public evidence',()=>{
  const entries=inventory(),evidence=checkProfileInventory(entries)
  assert.equal(evidence.profile,'pinned-minimal-headless');assert.equal(evidence.entry_count,20)
  assert.deepEqual(evidence,checkProfileInventory([...entries].reverse()))
  assert.equal(evidence.fingerprint.length,64)
  entries.push({id:'disabled-extra',name:'unreviewed-shell',disabled:true,package_name:'unreviewed-shell',package_version:'999',scoped:true,config:{},inject:{fs:{mode:'write'}}})
  assert.deepEqual(evidence,checkProfileInventory(entries))
})
for(const [label,mutate]of Object.entries({
  'unknown plugin':(e:ProfileEntryEvidence[])=>e.push({...e[0]!,id:'mcp-shell',name:'arbitrary'}),
  'same-name replacement':(e:ProfileEntryEvidence[])=>{e.find(x=>x.id==='tools')!.name='arbitrary'},
  'duplicate plugin identity':(e:ProfileEntryEvidence[])=>e.push({...e[0]!}),
  'wrong host package version':(e:ProfileEntryEvidence[])=>{e[0]!.package_version='999'},
  'aliased package with same version':(e:ProfileEntryEvidence[])=>{e[0]!.package_name='unreviewed-package'},
  'scoped service realm':(e:ProfileEntryEvidence[])=>{e[0]!.scoped=true},
  'enabled dynamic loader':(e:ProfileEntryEvidence[])=>e.push({...e[0]!,id:'hmr',name:'@deepseek-ai/dsh-hmr'}),
  'asynchronous timeout wrapper':(e:ProfileEntryEvidence[])=>e.push({...e[0]!,id:'timeout-policy',name:'@deepseek-ai/dsh-tool-timeout-policy'}),
  'asynchronous checkpoint wrapper':(e:ProfileEntryEvidence[])=>e.push({...e[0]!,id:'session-checkpoint-policy',name:'@deepseek-ai/dsh-session-checkpoint-policy'}),
  'alternate dispatch mode':(e:ProfileEntryEvidence[])=>{e.find(x=>x.id==='tools')!.config={mode:'prompt'}},
  'unbarriered agent':(e:ProfileEntryEvidence[])=>{e.find(x=>x.id==='agent-loop')!.inject=['sessionPersistence']},
  'unbarriered runner':(e:ProfileEntryEvidence[])=>{e.find(x=>x.id==='headless-runner')!.inject=['headlessStartup']},
  'declarative agent before readiness':(e:ProfileEntryEvidence[])=>{e.find(x=>x.id==='agent-loop')!.config={agents:[{id:'unsafe'}]}},
  'writing session index':(e:ProfileEntryEvidence[])=>{e.find(x=>x.id==='session-query-sqlite')!.config={path:'/tmp/index.sqlite',openAt:'startup'}},
  'custom injection interceptor':(e:ProfileEntryEvidence[])=>{e[0]!.inject={fs:{sandboxMode:'read-write'}}},
  'extra injected dependency':(e:ProfileEntryEvidence[])=>{e[0]!.inject=['unreviewed-service']},
  'missing provider':(e:ProfileEntryEvidence[])=>{e.find(x=>x.id==='collaboration-filesystem')!.disabled=true},
}))test(`enabled-profile refuses ${label}`,()=>{const entries=inventory();mutate(entries);assert.throws(()=>checkProfileInventory(entries),denied)})

test('profile evidence never serializes opaque model configuration or credentials',()=>{
  const entries=inventory(),config:Record<string,unknown>={secret:'not-public'};config.circular=config
  entries.find(e=>e.id==='llm-deepseek')!.config=config
  const evidence=checkProfileInventory(entries)
  assert.ok(!JSON.stringify(evidence).includes('not-public'))
})

/** Real Loader/EntryTree and installed package inventory; deliberately no plugin body activation. */
async function loaderFixture(){
  const dir=mkdtempSync(join(tmpdir(),'dsh-profile-inventory-'));mkdirSync(join(dir,'node_modules','@nerofirstgit'),{recursive:true})
  symlinkSync(resolve('node_modules/@deepseek-ai'),join(dir,'node_modules','@deepseek-ai'),'dir')
  symlinkSync(resolve('.'),join(dir,'node_modules','@nerofirstgit','dsh-collaboration'),'dir')
  const ctx=new Context();ctx.baseUrl=pathToFileURL(join(dir,'anchor.js')).href
  await ctx.plugin(Loader,{baseUrl:ctx.baseUrl});await ctx.plugin(PluginPackages)
  await ctx.plugin(ProtectedFileSystem,{cwd:dir})
  new CoordinationSessionPersistence(ctx,{async call(){return{}}},{workspaceRoot:dir})
  class DetachedTree extends EntryTree{write(){}}
  const include=new Entry(ctx.loader);include.options={id:'include',name:'cordis:include'};include.parent=ctx.loader.root
  const tree=new DetachedTree(ctx);include.subtree=tree;ctx.loader.store.include=include
  for(const row of inventory()){
    const entry=new Entry(ctx.loader);entry.options={id:row.id,name:row.name,config:row.config,inject:row.inject as string[]|undefined};entry.parent=tree.root;tree.store[row.id]=entry
  }
  return{ctx,tree,include,async close(){await ctx.fiber.dispose();rmSync(dir,{recursive:true,force:true})}}
}
test('active checker reads actual Loader topology, installed manifests and concrete service providers',async()=>{
  const f=await loaderFixture()
  try{
    assert.equal(checkActiveProfile(f.ctx).entry_count,20)
    f.tree.store.tools!.options.name='@deepseek-ai/dsh-tool-bash';assert.throws(()=>checkActiveProfile(f.ctx),denied)
    f.tree.store.tools!.options.name=ALLOWED_PROFILE_ENTRIES.tools!
    ;(f.tree.store.tools!.options as Record<string,unknown>).isolate={fs:true};assert.throws(()=>checkActiveProfile(f.ctx),denied)
    delete(f.tree.store.tools!.options as Record<string,unknown>).isolate
    f.include.parent=f.tree.root;assert.throws(()=>checkActiveProfile(f.ctx),denied)
  }finally{await f.close()}
})
test('active checker cannot be replaced by a caller supplied true boolean or missing host services',()=>{
  const ctx=new Context();ctx.provide('collaborationProtection',{verified:true} as never)
  assert.throws(()=>checkActiveProfile(ctx),denied)
})
test('official dsh --dump-config composes the shipped patch into exactly the audited profile without activating model or transport',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dsh-profile-dump-'))
  try{
    const run=spawnSync(process.execPath,['node_modules/@deepseek-ai/dsh/lib/bin.js','--profile','headless','--patch','./cordis.patch.yml','--dump-config'],{cwd:resolve('.'),env:{...process.env,DSH_HOME:dir,DSH_TELEMETRY_DISABLED:'1'},encoding:'utf8'})
    assert.equal(run.status,0,run.stderr);assert.equal(run.stderr,'')
    const rows=yaml.load(run.stdout,{schema:entryListSchema})as{ id:string;name:string;disabled?:boolean;config?:unknown;inject?:unknown }[]
    const entries=rows.filter(row=>!row.disabled).map(row=>({...inventory().find(e=>e.id===row.id)!,...row,disabled:false,scoped:false}))
    assert.equal(entries.length,20);assert.equal(checkProfileInventory(entries).entry_count,20)
    assert.deepEqual(entries.map(e=>e.id).sort(),Object.keys(ALLOWED_PROFILE_ENTRIES).sort())
  }finally{rmSync(dir,{recursive:true,force:true})}
})
