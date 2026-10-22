/** Session workspace routing evidence only; no GUI, socket or model activation. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionId,SESSION_FORMAT_VERSION} from '@deepseek-ai/dsh-session'
import {Config as PluginConfig} from '../../src/plugin.ts'
import {CoordinationSessionPersistence} from '../../src/host/persistence.ts'
import {Coordinator} from '../../src/coordinator.ts'
import {resolveConfig} from '../../src/config.ts'

test('GUI prerequisite: omitted workspace_root never silently binds every session to host process cwd',()=>{
  assert.equal(PluginConfig({}).workspace_root,undefined)
})

test('one actual persistence provider admits independent SessionHeader.cwd projects without a host-global root',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dsh-session-roots-')),a=join(dir,'a'),b=join(dir,'b');mkdirSync(a);mkdirSync(b)
  const coordinator=new Coordinator(resolveConfig({data_dir:join(dir,'state')})),ctx=new Context()
  const calls:{method:string;params:Record<string,unknown>}[]=[]
  const provider=new CoordinationSessionPersistence(ctx,{async call(method,params={},identity){calls.push({method,params});return coordinator.dispatch('per-session-fixture',method,params,identity)}},{})
  try{
    const first=await provider.create({id:SessionId('a'),version:SESSION_FORMAT_VERSION,createdAt:1,isSeeded:false,cwd:a})
    const second=await provider.create({id:SessionId('b'),version:SESSION_FORMAT_VERSION,createdAt:1,isSeeded:false,cwd:b})
    const ar=coordinator.store.session('a'),br=coordinator.store.session('b')
    assert.notEqual(ar.workspace_id,br.workspace_id);assert.notEqual(ar.project_id,br.project_id)
    assert.equal(coordinator.store.workspace(ar.workspace_id).root,a);assert.equal(coordinator.store.workspace(br.workspace_id).root,b)
    for(const call of calls.filter(c=>c.method==='session_create'))assert.equal(Object.hasOwn(call.params,'workspace_root'),false)
    await first.close();await second.close()
  }finally{await ctx.fiber.dispose();coordinator.close();rmSync(dir,{recursive:true,force:true})}
})

test('explicit single-workspace deployment keeps its root and rejects a foreign cwd',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dsh-explicit-root-')),root=join(dir,'project'),child=join(root,'sub'),other=join(dir,'other');mkdirSync(child,{recursive:true});mkdirSync(other)
  const coordinator=new Coordinator(resolveConfig({data_dir:join(dir,'state')})),ctx=new Context()
  const provider=new CoordinationSessionPersistence(ctx,{async call(method,params={},identity){return coordinator.dispatch('explicit-root-fixture',method,params,identity)}},{workspaceRoot:root})
  try{
    const first=await provider.create({id:SessionId('a'),version:SESSION_FORMAT_VERSION,createdAt:1,isSeeded:false,cwd:child})
    assert.equal(coordinator.store.workspace(coordinator.store.session('a').workspace_id).root,root)
    await assert.rejects(provider.create({id:SessionId('foreign'),version:SESSION_FORMAT_VERSION,createdAt:1,isSeeded:false,cwd:other}),{code:'PATH_NOT_ALLOWED'})
    await first.close()
  }finally{await ctx.fiber.dispose();coordinator.close();rmSync(dir,{recursive:true,force:true})}
})
