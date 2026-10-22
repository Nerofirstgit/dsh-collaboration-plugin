/** Actual pinned Desktop inspectors in-process; no Electron/listener/update/shutdown. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync,readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import {GUI_PROFILE_MODULES,GUI_PROFILE_INJECT} from '../../src/host/gui-profile.ts'
import {GUI_DISABLED_ENTRIES} from '../../src/host/gui-profile-contract.ts'

const hashes={
  'update-tasks.ts':'ace98160f307323fd04055dc990ab1d52faeb848a0a03ec9cf43c475fad9972b',
  'quit-inspection.ts':'d732d8706a6fe5eb993c4dfd90fdec7203889507b0b13b957cfebebd80cd16e2',
}
const original=resolve('upstream/apps/desktop-host/src'),snapshot=resolve('tests/fixtures/pinned-desktop-host')
const source=existsSync(join(original,'update-tasks.ts'))?original:snapshot
for(const[file,hash]of Object.entries(hashes)){
  for(const dir of new Set([snapshot,source]))assert.equal(createHash('sha256').update(readFileSync(join(dir,file))).digest('hex'),hash,`pinned source changed: ${dir}/${file}`)
}
const {installDesktopUpdateTaskControl,hasDesktopActiveTasks}=await import(pathToFileURL(join(source,'update-tasks.ts')).href) as typeof import('../fixtures/pinned-desktop-host/update-tasks.ts')
const {installDesktopQuitInspection}=await import(pathToFileURL(join(source,'quit-inspection.ts')).href) as typeof import('../fixtures/pinned-desktop-host/quit-inspection.ts')
async function fixture(){
  const ctx=new Context();await ctx.plugin(SessionStore);await ctx.plugin(AgentRegistry)
  // Follow the production composition, not an unconditional mock that hides its omission.
  if(GUI_PROFILE_MODULES.jobs==='@deepseek-ai/dsh-jobs-local')await ctx.plugin(LocalJobRegistry)
  return{ctx,update:installDesktopUpdateTaskControl(ctx),quit:installDesktopQuitInspection(ctx)}
}
test('official Desktop quit/update inspection remains usable with the actual retained registry',async()=>{
  const f=await fixture();try{
    assert.deepEqual(await f.quit(),{activeTasks:false,scheduledTasks:false})
    assert.equal(await f.update('inspect'),false)
    assert.equal(await f.update('lock'),false)
    assert.equal(await f.update('unlock'),false)
    assert.ok(f.ctx.jobs instanceof LocalJobRegistry)
  }finally{await f.ctx.fiber.dispose()}
})
test('only registry inspection is retained, never job controllers/producers or raw writer tools',async()=>{
  const f=await fixture();try{
    assert.ok(f.ctx.jobs instanceof LocalJobRegistry)
    assert.ok(GUI_PROFILE_INJECT.jobs!.includes('collaborationReady'))
    for(const id of ['tool-jobs','job-controller','tool-bash','tool-pwsh','subprocess','tool-workflow','workflow-ptc','subagent','schedule'])assert.ok(GUI_DISABLED_ENTRIES.includes(id),id)
    let started=false
    assert.throws(()=>f.ctx.jobs.start({kind:'bash',label:'never executed',run(){started=true;throw new Error('must not execute')}}),/no job controller serves/)
    assert.equal(started,false);assert.deepEqual(f.ctx.jobs.list(),[])
  }finally{await f.ctx.fiber.dispose()}
})
test('retained pinned modules contain no literal job-controller registration or job-start call outside the registry',()=>{
  // Bounded source audit, not an assertion about dynamically mounted Desktop Office children.
  for(const[id,name]of Object.entries(GUI_PROFILE_MODULES)){
    if(id==='jobs'||!name.startsWith('@deepseek-ai/'))continue
    const code=readFileSync(new URL(import.meta.resolve(name)),'utf8')
    assert.ok(!code.includes('.attachController('),`${id} attaches job execution control`)
    assert.ok(!code.includes('.jobs.start('),`${id} starts a background job`)
  }
})
test('official update lock drains admitted requests and refuses new requests until unlock',async()=>{
  const f=await fixture(),release=Promise.withResolvers<void>();try{
    assert.ok(f.ctx.jobs instanceof LocalJobRegistry)
    let entered=false,locked=false,blockedStatus=0,ended=false
    const request={} as never
    const ignoredResponse={} as never
    const admitted=f.ctx.waterfall('connection/request',request,ignoredResponse,async()=>{entered=true;await release.promise})
    assert.equal(entered,true)
    const lock=f.update('lock').then(value=>{locked=true;return value})
    await Promise.resolve();assert.equal(locked,false)
    const blocked={writeHead(status:number){blockedStatus=status},end(){ended=true}} as never
    await f.ctx.waterfall('connection/request',request,blocked,async()=>{assert.fail('request passed a locked admission')})
    assert.equal(blockedStatus,503);assert.equal(ended,true)
    release.resolve();await admitted;assert.equal(await lock,false)
    await f.update('unlock')
    let resumed=false;await f.ctx.waterfall('connection/request',request,ignoredResponse,async()=>{resumed=true})
    assert.equal(resumed,true)
  }finally{release.resolve();await f.ctx.fiber.dispose()}
})
test('official inspectors refuse use after context disposal rather than reporting idle',async()=>{
  const f=await fixture();await f.ctx.fiber.dispose()
  await assert.rejects(f.quit(),/Host is stopping/)
  await assert.rejects(f.update('inspect'),/Host is stopping/)
})
test('official active-task classifier preserves running and queued-turn/step semantics',async()=>{
  const f=await fixture();try{
    // Pure snapshot inputs only. No claim these are booted Agents or executed turns.
    for(const active of ['running','nextTurn','nextStep'] as const){
      const roster=[{id:'fixture',status:active==='running'?'running':'idle',inbox:{nextTurn:active==='nextTurn'?[{}]:[],nextStep:active==='nextStep'?[{}]:[]}}] as unknown as ReturnType<Context['agents']['list']>
      assert.equal(hasDesktopActiveTasks(roster,f.ctx.jobs),true,active)
    }
    assert.equal(hasDesktopActiveTasks([],f.ctx.jobs),false)
  }finally{await f.ctx.fiber.dispose()}
})
