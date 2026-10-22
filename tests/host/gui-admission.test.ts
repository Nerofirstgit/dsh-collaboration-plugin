/** Real local paths/Git/Loader metadata; no GUI, listeners or model requests. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {Context} from '@deepseek-ai/cordis'
import {Loader,Entry} from '@deepseek-ai/cordis-plugin-loader'
import type {SessionHeader} from '@deepseek-ai/dsh-session'
import {createGuiStateRootsGuard} from '../../src/host/gui-state-roots.ts'
import {createGuiSessionAdmission} from '../../src/host/gui-admission.ts'
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'dsh-gui-admission-')),home=join(dir,'home'),project=join(dir,'project');mkdirSync(home);mkdirSync(project)
  const ctx=new Context();await ctx.plugin(Loader,{})
  ctx.provide('profileContext',{name:'web',home,dir:join(home,'profiles','web'),patchPath:join(home,'profiles','web','cordis.patch.yml'),cwd:home,installAnchor:join(home,'profiles','web','package.json'),startedBundles:[],overlays:[],telemetryDisabledEnv:undefined})
  for(const [id,name,config]of [
    ['storage-json','@deepseek-ai/dsh-storage-json',{root:join(home,'storages')}],
    ['storage-domain','@deepseek-ai/dsh-storage-domain',{backend:'json',routes:{}}],
    ['attachment-local','@deepseek-ai/dsh-attachment-local',{dshHome:home}],
    ['credentials','@deepseek-ai/dsh-credentials-local',{dshHome:home}],
    ['session-query-sqlite','@deepseek-ai/dsh-session-query-sqlite',{path:':memory:',openAt:'never'}],
  ]as const){const entry=new Entry(ctx.loader);entry.options={id,name,config};entry.parent=ctx.loader.root;ctx.loader.store[id]=entry}
  const admit=createGuiSessionAdmission(createGuiStateRootsGuard(ctx))
  return{dir,home,project,admit,async close(){await ctx.fiber.dispose();rmSync(dir,{recursive:true,force:true})}}
}
function header(cwd?:string):SessionHeader{return{cwd}as SessionHeader}
const denied={code:'UNMEDIATED_WRITE_DENIED'}
test('trusted session cwd, not Desktop backend profile cwd, selects ordinary independent project',async()=>{
  const f=await fixture();try{f.admit({operation:'create',header:header(f.project)})}finally{await f.close()}
})
test('full Git root is checked even when the session cwd itself does not contain Harness state',async()=>{
  const f=await fixture();try{
    const git=spawnSync('git',['-C',f.dir,'init','--quiet'],{encoding:'utf8'});assert.equal(git.status,0,git.stderr)
    assert.throws(()=>f.admit({operation:'create',header:header(f.project)}),denied)
  }finally{await f.close()}
})
test('reopen uses original nonGit workspace root rather than narrowing to child cwd',async()=>{
  const f=await fixture();try{assert.throws(()=>f.admit({operation:'open',header:header(f.project),workspaceRoot:f.dir}),denied)}finally{await f.close()}
})
test('missing or relative header cwd cannot fall back to launcher cwd or explicit root',async()=>{
  const f=await fixture();try{
    for(const cwd of [undefined,'relative'])assert.throws(()=>f.admit({operation:'create',header:header(cwd),workspaceRoot:f.project}),denied)
  }finally{await f.close()}
})
