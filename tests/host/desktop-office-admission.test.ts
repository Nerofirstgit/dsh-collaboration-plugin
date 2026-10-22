/**
 * Exact published Desktop Office children in the common root runtime, in process.
 * Detached audited headless inventory is metadata, NOT a Desktop launcher/GUI
 * boot. No socket, model request, dependency installation, or child executable.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime,{ToolCallId} from '@deepseek-ai/dsh-llm'
import SessionStore,{SessionId} from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as officeSkills from '@deepseek-ai/dsh-skill-office'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as workspaceDependencies from '@deepseek-ai/dsh-tool-workspace-dependencies'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {Coordinator} from '../../src/coordinator.ts'
import {resolveConfig} from '../../src/config.ts'
import {applyWithClient} from '../../src/plugin.ts'
import type {RuntimeIdentity} from '../../src/types.ts'
import {installDetachedAuditedInventory} from './audited-profile-fixture.ts'

function pinnedPackage(specifier:string){
  const path=fileURLToPath(import.meta.resolve(`${specifier}/package.json`))
  assert.equal(JSON.parse(readFileSync(path,'utf8')).version,'0.2.1-rc.2')
  return dirname(path)
}
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'dsh-desktop-office-')),project=join(dir,'project'),home=join(dir,'home')
  mkdirSync(project);mkdirSync(home)
  const ctx=new Context(),config=resolveConfig({data_dir:join(home,'coordination'),heartbeat_ms:60000,offline_ms:120000})
  const coordinator=new Coordinator(config),methods:string[]=[]
  const client={async call(method:string,params:Record<string,unknown>={},identity?:RuntimeIdentity):Promise<unknown>{
    methods.push(method);return coordinator.dispatch('office-component',method,params,identity)
  }}
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt,{personaPrefix:'Office tool admission fixture; no model adapter installed'})
  await ctx.plugin(ToolRuntime,{mode:'native'});await ctx.plugin(AgentRegistry)
  await installDetachedAuditedInventory(ctx,join(dir,'profile-metadata'),project)
  await applyWithClient(ctx,client,{...config,workspace_root:project})
  await ctx.plugin(AgentLoop,{agents:[]})
  const agent=await ctx.agentLoop.create(SessionId('office-session'),{provider:'not-used',model:'none'},{cwd:project})
  return{dir,project,home,ctx,coordinator,methods,agent,async close(){
    await ctx.fiber.dispose();coordinator.disconnect('office-component');coordinator.close();rmSync(dir,{recursive:true,force:true})
  }}
}

test('late exact Desktop load_workspace_dependencies registration is denied by owned-definition policy before its installation body',async()=>{
  pinnedPackage('@deepseek-ai/dsh-tool-workspace-dependencies')
  const f=await fixture();try{
    const source=join(f.dir,'absent-bundled-payload'),root=join(f.home,'dsh-runtimes','dsh-primary-runtime')
    // The actual package only validates absolute config and registers here.
    // An absent payload is deliberate: even a regression cannot install a real
    // runtime; entering its body would yield ENOENT instead of policy denial.
    const fork=f.ctx.plugin(workspaceDependencies,{source,root});await fork
    const definition=f.ctx.tools.get('load_workspace_dependencies')
    assert.ok(definition);assert.equal(definition.name,'load_workspace_dependencies')
    assert.equal(existsSync(source),false);assert.equal(existsSync(dirname(root)),false)
    for(const scope of [undefined,f.agent]){
      const result=await f.ctx.tools.execute({name:'load_workspace_dependencies',arguments:{},
        callId:ToolCallId(scope?'office-scoped':'office-global'),signal:new AbortController().signal,...scope?{agent:scope}:{}})
      assert.equal(result.isError,true)
      assert.match(result.error.message,scope?/UNMEDIATED_WRITE_DENIED/:/STALE_INSTANCE/)
      assert.doesNotMatch(result.error.message,/ENOENT/)
    }
    assert.equal(f.ctx.tools.get('load_workspace_dependencies'),definition,'The official definition is neither replaced nor wrapped by the test')
    assert.equal(existsSync(dirname(root)),false);assert.equal(existsSync(`${root}.previous`),false)
    assert.equal(f.methods.some(method=>['prepare_tool_operation','claim_files','apply_file_change'].includes(method)),false)
    await fork.dispose()
    assert.equal(f.ctx.tools.get('load_workspace_dependencies'),undefined)
    assert.equal(existsSync(dirname(root)),false)
  }finally{await f.close()}
})

test('exact Office skill provider mounts and serves bundled text/CLI paths without executing or writing a runtime',async()=>{
  const packageRoot=pinnedPackage('@deepseek-ai/dsh-skill-office'),f=await fixture()
  try{
    await f.ctx.plugin(SkillRegistry)
    const cli=join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))),'lib','cli.js')
    const fork=f.ctx.plugin(officeSkills,{assetRoot:join(packageRoot,'assets'),node:process.execPath,cli});await fork
    const skills=await f.ctx.skills.list()
    assert.equal(skills.length,7);assert.ok(skills.some(skill=>skill.name==='office-render'))
    const render=await f.ctx.skills.get('office-render')
    assert.ok(render);assert.match(render.content,/Installed LibreOffice Kit/)
    assert.ok(render.content.includes(JSON.stringify(cli)))
    assert.equal(existsSync(join(f.home,'dsh-runtimes')),false)
    assert.equal(f.methods.includes('apply_file_change'),false)
    await fork.dispose();assert.deepEqual(await f.ctx.skills.list(),[])
  }finally{await f.close()}
})
