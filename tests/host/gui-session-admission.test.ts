/** Actual coordinator/SQLite/provider seam in-process; no listener or model. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionId,SESSION_FORMAT_VERSION,type SessionHeader} from '@deepseek-ai/dsh-session'
import {Coordinator} from '../../src/coordinator.ts'
import {resolveConfig} from '../../src/config.ts'
import {CoordinationError} from '../../src/errors.ts'
import {CoordinationSessionPersistence,type HostPersistenceOptions} from '../../src/host/persistence.ts'
import type {RuntimeIdentity} from '../../src/types.ts'

const denied={code:'UNMEDIATED_WRITE_DENIED'}
function deny():never{throw new CoordinationError('UNMEDIATED_WRITE_DENIED','Harness state overlaps the workspace')}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'dsh-gui-admission-')),root=join(dir,'project'),child=join(root,'subdir')
  mkdirSync(child,{recursive:true})
  const coordinator=new Coordinator(resolveConfig({data_dir:join(dir,'state')})),contexts:Context[]=[]
  const header:SessionHeader={id:SessionId('gui-session'),version:SESSION_FORMAT_VERSION,createdAt:1,isSeeded:false,cwd:child}
  const calls:{method:string;params:Record<string,unknown>}[]=[]
  const control:{connection:string;loseOpen?:'connected'|'disconnect';stat?:(value:unknown)=>unknown;afterStale?:()=>void;beforeCall?:(method:string)=>void}={connection:'loopback'}
  const client={async call(method:string,params:Record<string,unknown>={},identity?:RuntimeIdentity):Promise<unknown>{
    calls.push({method,params:structuredClone(params)})
    control.beforeCall?.(method)
    let result:unknown
    try{result=await coordinator.dispatch(control.connection,method,params,identity)}catch(error){
      if(method==='session_open'&&(error as {code?:string}).code==='STALE_INSTANCE')control.afterStale?.()
      throw error
    }
    if(method==='session_open'&&control.loseOpen){
      const mode=control.loseOpen;control.loseOpen=undefined
      if(mode==='disconnect'){coordinator.disconnect(control.connection);control.connection='reconnected'}
      throw new CoordinationError('OUTCOME_UNKNOWN','Open reply lost after commit')
    }
    return method==='session_stat'&&control.stat?control.stat(result):result
  }}
  function provider(options:HostPersistenceOptions={workspaceRoot:root}){
    const ctx=new Context();contexts.push(ctx)
    return new CoordinationSessionPersistence(ctx,client,options)
  }
  async function seed(){const initial=provider(),handle=await initial.create(header);await handle.close()}
  return{dir,root,child,coordinator,header,calls,control,provider,seed,async close(){
    for(const ctx of contexts)await ctx.fiber.dispose()
    coordinator.disconnect(control.connection);coordinator.close();rmSync(dir,{recursive:true,force:true})
  }}
}

test('GUI create admission sees the materialized header and rejects before any canonical host/session row is written',async()=>{
  const f=fixture();try{
    let checked=false
    const provider=f.provider({workspaceRoot:f.root,admitSession(request){
      checked=true;assert.equal(request.operation,'create');assert.equal(request.header.cwd,f.child)
      assert.equal(request.header.isSeeded,false);assert.equal(request.workspaceRoot,f.root);deny()
    }})
    await assert.rejects(provider.create(f.header),denied);assert.equal(checked,true)
    assert.equal(f.calls.some(call=>call.method==='session_create'),false)
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM host_sessions').get()!.n,0)
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM sessions').get()!.n,0)
  }finally{await f.close()}
})

test('GUI write-open admission happens before an owner incarnation/epoch can change',async()=>{
  const f=fixture();try{
    await f.seed();const before=f.coordinator.store.session(f.header.id),callsBefore=f.calls.length
    const provider=f.provider({admitSession(request){assert.equal(request.operation,'open');deny()}})
    await assert.rejects(provider.open(f.header.id,'write'),denied)
    const after=f.coordinator.store.session(f.header.id)
    assert.equal(after.incarnation_id,before.incarnation_id);assert.equal(after.execution_epoch,before.execution_epoch)
    assert.deepEqual(f.calls.slice(callsBefore).map(call=>call.method),['session_stat'])
    assert.equal(f.coordinator.host.writers.has(f.header.id),false)
  }finally{await f.close()}
})

test('stat and resumed admission preserve the original non-Git workspace root when cwd is its child',async()=>{
  const f=fixture();try{
    await f.seed()
    assert.equal(f.coordinator.host.stat(f.header.id)!.workspace_root,f.root)
    const original=f.coordinator.store.session(f.header.id).workspace_id;let checked=false
    const provider=f.provider({workspaceRoot:f.child,admitSession(request){
      checked=true;assert.equal(request.operation,'open');assert.equal(request.header.cwd,f.child)
      assert.equal(request.workspaceRoot,f.root,'must use persisted full root, not new options or header.cwd')
    }})
    const handle=await provider.open(f.header.id,'write');assert.equal(checked,true)
    assert.equal(f.coordinator.store.session(f.header.id).workspace_id,original)
    await handle.close()
  }finally{await f.close()}
})

test('retained uncertain write-open retry revalidates admission before replay while preserving the original request ID/CAS',async()=>{
  const f=fixture();try{
    await f.seed();let allowed=true,checks=0
    const provider=f.provider({admitSession(){checks++;if(!allowed)deny()}})
    f.control.loseOpen='connected'
    await assert.rejects(provider.open(f.header.id,'write'),{code:'OUTCOME_UNKNOWN'})
    const original=f.calls.filter(call=>call.method==='session_open')[0]!.params
    const committed=f.coordinator.store.session(f.header.id)
    allowed=false;await assert.rejects(provider.open(f.header.id,'write'),denied)
    assert.equal(checks,2);assert.equal(f.calls.filter(call=>call.method==='session_open').length,1)
    assert.equal(f.coordinator.store.session(f.header.id).incarnation_id,committed.incarnation_id)
    allowed=true;const handle=await provider.open(f.header.id,'write')
    assert.equal(checks,3)
    assert.deepEqual(f.calls.filter(call=>call.method==='session_open')[1]!.params,original)
    await handle.close()
  }finally{await f.close()}
})

test('refreshed reconnect CAS is separately admitted after definitive stale reply and before the new owner RPC',async()=>{
  const f=fixture();try{
    await f.seed();let allowed=true,checks=0
    const provider=f.provider({admitSession(){checks++;if(!allowed)deny()}})
    f.control.loseOpen='disconnect'
    await assert.rejects(provider.open(f.header.id,'write'),{code:'OUTCOME_UNKNOWN'})
    const committed=f.coordinator.store.session(f.header.id)
    f.control.afterStale=()=>{allowed=false}
    await assert.rejects(provider.open(f.header.id,'write'),denied)
    assert.equal(checks,3,'initial request, retained replay, and fresh CAS preparation each require admission')
    assert.equal(f.calls.filter(call=>call.method==='session_open').length,2)
    assert.equal(f.coordinator.store.session(f.header.id).incarnation_id,committed.incarnation_id)
    assert.equal(f.coordinator.host.writers.has(f.header.id),false)
    allowed=true;f.control.afterStale=undefined
    const handle=await provider.open(f.header.id,'write');await handle.close()
  }finally{await f.close()}
})

for(const malformed of ['missing-root','relative-root','wrong-header']as const)test(`GUI open refuses ${malformed} stat evidence instead of guessing a narrowed workspace`,async()=>{
  const f=fixture();try{
    await f.seed();let checks=0
    f.control.stat=value=>{
      const result=structuredClone(value) as Record<string,unknown>
      if(malformed==='missing-root')delete result.workspace_root
      if(malformed==='relative-root')result.workspace_root='subdir'
      if(malformed==='wrong-header')result.header={...result.header as object,id:'different-session'}
      return result
    }
    const before=f.coordinator.store.session(f.header.id)
    const provider=f.provider({workspaceRoot:f.root,admitSession(){checks++}})
    await assert.rejects(provider.open(f.header.id,'write'))
    assert.equal(checks,0);assert.equal(f.calls.filter(call=>call.method==='session_open').length,0)
    assert.equal(f.coordinator.store.session(f.header.id).incarnation_id,before.incarnation_id)
  }finally{await f.close()}
})

test('read-only open does not obtain execution admission or a new owner',async()=>{
  const f=fixture();try{
    await f.seed();const before=f.coordinator.store.session(f.header.id)
    const provider=f.provider({admitSession(){deny()}})
    const handle=await provider.open(f.header.id,'read')
    assert.equal(handle.access,'read');assert.equal(f.coordinator.store.session(f.header.id).incarnation_id,before.incarnation_id)
    await handle.close()
  }finally{await f.close()}
})

test('headless without an admission callback retains create/write-open behavior',async()=>{
  const f=fixture();try{
    const provider=f.provider(),created=await provider.create(f.header);await created.close()
    const opened=await provider.open(f.header.id,'write');assert.equal(opened.header.cwd,f.child);await opened.close()
  }finally{await f.close()}
})

test('an accidentally async admission callback cannot race ahead to canonical create',async()=>{
  const f=fixture();try{
    const provider=f.provider({workspaceRoot:f.root,admitSession:async()=>{deny()}})
    await assert.rejects(provider.create(f.header),denied)
    assert.equal(f.calls.some(call=>call.method==='session_create'),false)
    assert.equal(f.coordinator.store.db.prepare('SELECT COUNT(*) n FROM host_sessions').get()!.n,0)
  }finally{await f.close()}
})

for(const operation of ['create','open']as const)test(`final ${operation} admission has no intervening await before the write-owner RPC`,async()=>{
  const f=fixture();try{
    if(operation==='open')await f.seed()
    const order:string[]=[]
    f.control.beforeCall=method=>{if(method===`session_${operation}`)order.push('rpc')}
    const provider=f.provider({workspaceRoot:f.root,admitSession(){order.push('admission');queueMicrotask(()=>order.push('later-microtask'))}})
    const handle=operation==='create'?await provider.create(f.header):await provider.open(f.header.id,'write')
    assert.deepEqual(order,['admission','rpc','later-microtask'])
    await handle.close()
  }finally{await f.close()}
})
