import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { Store } from '../src/store.ts'
import { Identities } from '../src/identity.ts'
import { HostStore } from '../src/host-store.ts'
import { CoordinationSessionPersistence } from '../src/host/persistence.ts'
import { resolveConfig } from '../src/config.ts'
import { InstanceLock } from '../src/instance-lock.ts'
import type { RuntimeIdentity } from '../src/types.ts'

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'dsh-review-')),root=join(dir,'project');mkdirSync(root)
  const store=new Store(join(dir,'state','db.sqlite'))
  const identities=new Identities(store,resolveConfig({data_dir:join(dir,'state')}))
  const host=new HostStore(store,identities)
  let lostMethod:string|undefined
  const client={async call(method:string,params:Record<string,unknown>={},identity?:RuntimeIdentity):Promise<unknown>{
    let result:unknown
    switch(method){
      case 'session_create':result=host.create('connection',params);break
      case 'session_open':result=host.open('connection',params);break
      case 'session_read':result=host.read('connection',params,identity);break
      case 'session_append':result=host.append('connection',params,identity!);break
      case 'session_flush':result=host.flush('connection',params,identity);break
      case 'session_close':result=host.close('connection',params,identity);break
      case 'session_stat':result=host.stat(String(params.id));break
      case 'session_list':result=host.list();break
      case 'recover_tool_operations':result={operations:[]};break
      default:throw new Error(method)
    }
    if(lostMethod===method){lostMethod=undefined;throw new Error('response lost after commit')}
    return JSON.parse(JSON.stringify(result))
  }}
  const provider=new CoordinationSessionPersistence(new Context(),client,{workspaceRoot:root})
  const header={id:SessionId('review-session'),version:SESSION_FORMAT_VERSION,createdAt:1,isSeeded:false,cwd:root}
  return{dir,root,host,store,identities,provider,header,lose:(method:string)=>{lostMethod=method},close:()=>{store.close();rmSync(dir,{recursive:true,force:true})}}
}
const e0={type:'turn/start' as const,seq:SessionSeq(0),time:1,data:{turn:1}}
const e1={type:'turn/start' as const,seq:SessionSeq(1),time:2,data:{turn:2}}

test('REGRESSION: canonical provider accepts an existing-host seeded create before its seed append',async()=>{
  const f=fixture();try{
    const h=await f.provider.create({...f.header,isSeeded:true,parentSession:SessionId('parent')},{inheritedEventCount:SessionLogOffset(1)})
    await h.append([e0]);await h.close()
  }finally{f.close()}
})

test('REGRESSION: non-Git session launched in selected project subdirectory resumes',async()=>{
  const f=fixture();try{
    const child=join(f.root,'sub');mkdirSync(child)
    const h=await f.provider.create({...f.header,cwd:child});await h.close()
    const resumed=await f.provider.open(f.header.id,'write');await resumed.close()
  }finally{f.close()}
})

test('REGRESSION: draining after an explicit append lost-response does not discard a newer routed event',async()=>{
  const f=fixture();try{
    const h=await f.provider.create(f.header)
    f.lose('session_append');await assert.rejects(h.append([e0]),/response lost/)
    f.provider.route(f.header.id,e1)
    await h.flush()
    assert.deepEqual((await h.read()).events.map(e=>e.seq),[0,1])
    await h.close()
  }finally{f.close()}
})

test('REGRESSION: close retry succeeds after coordinator committed close but its response was lost',async()=>{
  const f=fixture();try{
    const h=await f.provider.create(f.header)
    f.lose('session_close');await assert.rejects(h.close(),/response lost/)
    await h.close()
  }finally{f.close()}
})

test('REGRESSION: protected registration refuses state physically inside workspace through parent symlink',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dsh-review-path-')),root=join(dir,'project'),alias=join(dir,'alias');mkdirSync(root);symlinkSync(root,alias)
  const dataDir=join(alias,'state'),store=new Store(join(dataDir,'db.sqlite'))
  let lock:InstanceLock|undefined
  try{
    lock=await InstanceLock.acquire(dataDir)
    assert.equal(realpathSync(dataDir),join(root,'state'))
    const ids=new Identities(store,resolveConfig({data_dir:dataDir}))
    assert.throws(()=>ids.register({session_id:'review-session',cwd:root}),{code:'PATH_NOT_ALLOWED'})
  }finally{await lock?.close();store.close();rmSync(dir,{recursive:true,force:true})}
})

test('REGRESSION: closed canonical write handle revokes runtime credentials',async()=>{
  const f=fixture();try{
    const h=f.host.create('connection',{header:f.header,workspace_root:f.root,open_request_id:'open'})
    f.host.close('connection',{handle_id:h.handle_id},h.identity)
    assert.throws(()=>f.identities.heartbeat(h.identity!),{code:'STALE_INSTANCE'})
    assert.throws(()=>f.host.prepareTool(h.identity!,{turn_id:'1',tool_call_id:'call',tool_name:'write',arguments:{}}),{code:'STALE_INSTANCE'})
  }finally{f.close()}
})

test('REGRESSION: lost open response does not leave an unrecoverable hidden write owner on a live connection',async()=>{
  const f=fixture();try{
    const created=await f.provider.create(f.header);await created.close()
    f.lose('session_open');await assert.rejects(f.provider.open(f.header.id,'write'),/response lost/)
    const reopened=await f.provider.open(f.header.id,'write');await reopened.close()
  }finally{f.close()}
})
