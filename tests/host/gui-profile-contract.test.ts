/** Candidate configuration only; importing this contract must never activate a profile. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {inspectGuiProfileContract,GUI_ROOT_MODULES,GUI_DISABLED_ENTRIES,GUI_REQUIRED_INJECT,type GuiProfileCandidate} from '../../src/host/gui-profile-contract.ts'

function candidate():GuiProfileCandidate {
  return {surface:'web',startup:{producer:'session-collaboration',awaits_loader_settlement:false},state:{harness_home:'C:\\Users\\Tester\\.dsh',profile_root:'C:\\Users\\Tester\\.dsh\\profiles\\web',storage_root:'C:\\Users\\Tester\\.dsh\\storages',workspace_roots:['C:\\test-project-a','C:\\test-project-b']},entries:Object.entries(GUI_ROOT_MODULES).map(([id,name])=>({id,name,disabled:GUI_DISABLED_ENTRIES.includes(id),scoped:false,package_name:name.split('/').slice(0,2).join('/'),package_version:name.startsWith('@nerofirstgit/')?'0.1.0-dev.0':id==='timer'?'1.1.7':'0.2.1-rc.2',inject:GUI_REQUIRED_INJECT[id]??[],config:id==='tools'?{mode:'native'}:id==='agent-loop'?{agents:[]}:id==='agent-preset-registry'?{default:'collaboration'}:id==='preset-collaboration'?{id:'collaboration',plugins:[]}:id==='session-query-sqlite'?{path:':memory:',openAt:'never'}:id==='storage-json'?{root:'C:\\Users\\Tester\\.dsh\\storages'}:id==='attachment-local'?{dshHome:'C:\\Users\\Tester\\.dsh'}:{}}))}
}
const denied={code:'UNMEDIATED_WRITE_DENIED'}
test('valid GUI candidate remains explicitly blocked even when inventory is exact',()=>{
  const result=inspectGuiProfileContract(candidate())
  assert.equal(result.inventory_valid,true)
  assert.equal(result.activation_allowed,false)
  assert.ok(result.blockers.some(item=>item.code==='GUI_PROVIDER_COMPATIBILITY_UNVERIFIED'))
  assert.ok(result.blockers.some(item=>item.code==='SETTINGS_ADAPTER_REQUIRED'))
  assert.ok(result.blockers.some(item=>item.code==='WINDOWS_RUNTIME_UNVERIFIED'))
})
for(const [label,mutate]of Object.entries({
  'unknown enabled row':(c:GuiProfileCandidate)=>c.entries.push({...c.entries[0]!,id:'other',name:'other'}),
  'missing UI approval':(c:GuiProfileCandidate)=>{c.entries=c.entries.filter(row=>row.id!=='ui-approval')},
  'missing attachment service':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='attachment-local')!.disabled=true},
  'unresolved dynamic disabled expression':(c:GuiProfileCandidate)=>{c.entries[0]!.disabled={}as boolean},
  'unversioned module':(c:GuiProfileCandidate)=>{c.entries[0]!.package_version='latest'},
  'duplicate entry':(c:GuiProfileCandidate)=>{c.entries.push({...c.entries[0]!})},
  'stock preset':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='preset-standard')!.disabled=false},
  'local terminal API':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='terminal-controller')!.disabled=false},
  'raw config editor':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='config-editor')!.disabled=false},
  'MCP resources':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='mcp-resources')!.disabled=false},
  'job execution controller':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='job-controller')!.disabled=false},
  'preset tool replacement':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='preset-collaboration')!.config={id:'collaboration',plugins:[{id:'write',name:'@deepseek-ai/dsh-tool-fs'}]}},
  'unbarriered session API':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='session-controller')!.inject=[]},
  'unbarriered factory':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='agent-loop')!.inject=['sessionPersistence']},
  'ready producer waits for entire loader':(c:GuiProfileCandidate)=>{c.startup.awaits_loader_settlement=true},
  'ready producer depends on downstream controller':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='session-collaboration')!.inject=['sessionController']},
  'state inside project':(c:GuiProfileCandidate)=>{c.state.workspace_roots=['c:\\USERS\\tester']},
  'project inside state':(c:GuiProfileCandidate)=>{c.state.workspace_roots=['C:\\Users\\Tester\\.dsh\\project']},
  'cwd relative state':(c:GuiProfileCandidate)=>{c.state.storage_root='.\\data'},
  'wrong state root in backend':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='storage-json')!.config={root:'C:\\test-project-a\\storage'}},
  'writing query index':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='session-query-sqlite')!.config={path:'project.sqlite',openAt:'startup'}},
  'arbitrary scoped provider':(c:GuiProfileCandidate)=>{c.entries.find(row=>row.id==='tools')!.scoped=true},
}))test(`candidate refuses ${label}`,()=>{const value=candidate();mutate(value);assert.throws(()=>inspectGuiProfileContract(value),denied)})
test('Desktop adds runtime-specific blockers rather than inheriting Web acceptance',()=>{const value=candidate();value.surface='desktop';const result=inspectGuiProfileContract(value);assert.ok(result.blockers.some(item=>item.code==='DESKTOP_RUNTIME_UNVERIFIED'));assert.equal(result.activation_allowed,false)})
test('diagnostics contain only static evidence, never supplied credential configuration or state paths',()=>{const value=candidate();value.entries.find(row=>row.id==='llm-deepseek')!.config={apiKey:'not-public'};const diagnostic=JSON.stringify(inspectGuiProfileContract(value));assert.ok(!diagnostic.includes('not-public'));assert.ok(!diagnostic.includes('Tester'))})

test('recorded official root identities match fresh pinned Web dump without activation',async()=>{
  const {mkdtempSync,rmSync}=await import('node:fs')
  const {tmpdir}=await import('node:os')
  const {join,resolve}=await import('node:path')
  const {spawnSync}=await import('node:child_process')
  const {default:yaml}=await import('js-yaml')
  const {entryListSchema}=await import('@deepseek-ai/cordis-plugin-include')
  const dir=mkdtempSync(join(tmpdir(),'dsh-gui-contract-'))
  try{
    const run=spawnSync(process.execPath,['node_modules/@deepseek-ai/dsh/lib/bin.js','--profile','web','--dump-config'],{cwd:resolve('.'),env:{...process.env,DSH_HOME:dir,DSH_TELEMETRY_DISABLED:'1'},encoding:'utf8'})
    assert.equal(run.status,0,run.stderr)
    const actual=yaml.load(run.stdout,{schema:entryListSchema})as{id:string;name:string}[]
    const expected=Object.fromEntries(Object.entries(GUI_ROOT_MODULES).filter(([id])=>!['session-collaboration','collaboration-filesystem','preset-collaboration'].includes(id)))
    assert.deepEqual(Object.fromEntries(actual.map(row=>[row.id,row.name])),expected)
  }finally{rmSync(dir,{recursive:true,force:true})}
})

test('read-only GUI workspace previews retain their required sandboxPolicy service',()=>{
  // workspace-files static inject includes sandboxPolicy; it is policy metadata, not a process executor.
  assert.equal(candidate().entries.find(row=>row.id==='sandbox-policy')!.disabled,false)
})

for(const id of ['office-to-pdf','workspace-changes','ui-deliverables','otel','session-telemetry-otel','desktop-product-telemetry','product-analytics','open-in-app','ui-open-in-app','permission','ui-permission','subagent-model-selection-settings','session-title-llm','ui-settings-plugin-inventory','ui-settings-agent-loop','ui-settings-web-search'])test(`detached candidate also refuses confirmed unsupported ${id}`,()=>{
  const value=candidate();value.entries.find(row=>row.id===id)!.disabled=false;assert.throws(()=>inspectGuiProfileContract(value),denied)
})
