import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionHandleClosedError, SessionReadOnlyError } from '@deepseek-ai/dsh-session-persistence'
import { CoordinationSessionPersistence } from '../../src/host/persistence.ts'

const identity = {session_id:'a',incarnation_id:'one',execution_epoch:1,coordinator_epoch:1,coordinator_domain:'domain',runtime_token:'private'}
const header = {id:SessionId('a'),version:SESSION_FORMAT_VERSION,createdAt:1,isSeeded:false,cwd:'/tmp/workspace'}
function fixture() {
  let stored: SessionEvent[] = [], lost = true
  const calls: {method:string;params:Record<string,unknown>}[] = []
  const client = {async call(method:string,params:Record<string,unknown>) {
    calls.push({method,params})
    if (method === 'recover_tool_operations')return {operations:[]}
    if (method === 'session_create' || method === 'session_open') return {handle_id:'h',header,inherited_event_count:0,identity,event_count:stored.length}
    if (method === 'session_append') {
      const events = params.events as SessionEvent[]
      if (stored.length === params.expected_seq) stored.push(...events)
      if (lost) { lost=false; throw new Error('response lost after commit') }
      return {event_count:stored.length}
    }
    if (method === 'session_read') return {events:stored.slice(Number(params.offset),params.length===undefined ? undefined : Number(params.offset)+Number(params.length))}
    if (method === 'session_stat') return {header,event_count:stored.length,revision:String(stored.length)}
    if (method === 'session_list') return {sessions:[{header,event_count:stored.length,revision:String(stored.length)}]}
    return {}
  }}
  const ctx = new Context()
  const provider = new CoordinationSessionPersistence(ctx,client,{workspaceRoot:'/tmp/workspace'})
  return {provider,calls,get stored(){return stored},setLost(value:boolean){lost=value}}
}
const event: SessionEvent = {type:'turn/start',seq:SessionSeq(0),time:1,data:{turn:1}}

test('P0 host provider retains the exact append ID after a lost response',async()=>{
  const f=fixture(), h=await f.provider.create(header)
  await assert.rejects(h.append([event]),/response lost/)
  await h.append([event])
  const appends=f.calls.filter(x=>x.method==='session_append')
  assert.equal(appends.length,2)
  assert.equal(appends[0]?.params.append_id,appends[1]?.params.append_id)
  assert.equal(f.stored.length,1)
  assert.equal((await h.read()).events.length,1)
  await h.close()
})

test('P0 host provider refuses readonly mutations and closed reads',async()=>{
  const f=fixture(), h=await f.provider.open(SessionId('a'),'read')
  await assert.rejects(h.append([event]),SessionReadOnlyError)
  await assert.rejects(h.flush(),SessionReadOnlyError)
  await h.close()
  await h.close()
  await assert.rejects(h.read(),SessionHandleClosedError)
})

test('P0 host provider validates contiguous append before transport',async()=>{
  const f=fixture(), h=await f.provider.create(header,{inheritedEventCount:SessionLogOffset(0)})
  await assert.rejects(h.append([{...event,seq:SessionSeq(2)}]),/seq mismatch/)
  assert.equal(f.calls.filter(x=>x.method==='session_append').length,0)
  await h.close()
})

test('P0 host live routing buffers the actual host events and drain survives response loss',async()=>{
  const f=fixture(), h=await f.provider.create(header)
  f.provider.route(SessionId('a'),event)
  await assert.rejects(h.flush(),/response lost/)
  await h.flush()
  assert.equal(f.stored.length,1)
  assert.equal(f.provider.runtimeIdentity(SessionId('a')).runtime_token,'private')
  await h.close()
})

test('P0 host provider refuses changed contents under pending append identity',async()=>{
  const f=fixture(),h=await f.provider.create(header)
  await assert.rejects(h.append([event]),/response lost/)
  await assert.rejects(h.append([{...event,data:{turn:99}}]),/pending append/)
  await h.append([event])
  await h.close()
})

test('P0 failed explicit append cannot consume later live buffered events',async()=>{
  const f=fixture(),h=await f.provider.create(header)
  await assert.rejects(h.append([event]),/response lost/)
  f.provider.route(SessionId('a'),{...event,seq:SessionSeq(1),data:{turn:2}})
  await h.flush()
  assert.equal(f.stored.length,2)
  assert.equal(f.stored[1]?.seq,1)
  assert.equal((await f.provider.readEvents(SessionId('a'),1,1))[0]?.seq,1)
  await h.close()
})

test('P0 create accepts the host pre-materialization seeded handle contract',async()=>{
  const seeded={...header,isSeeded:true,parentSession:SessionId('parent')}
  const ctx=new Context(),provider=new CoordinationSessionPersistence(ctx,{async call(method,params){
    if(method==='session_create')return {handle_id:'seeded-h',header:seeded,inherited_event_count:2,event_count:0,identity}
    return {}
  }},{workspaceRoot:'/tmp/workspace'})
  const handle=await provider.create(seeded,{inheritedEventCount:SessionLogOffset(2)})
  assert.equal(handle.inheritedEventCount,2)
  assert.equal(handle.header.isSeeded,true)
  await handle.close()
})

test('P0 close retry after lost reply repeats close only, never flushes a closed remote handle',async()=>{
  const methods:string[]=[],ctx=new Context();let remoteClosed=false
  const provider=new CoordinationSessionPersistence(ctx,{async call(method){
    methods.push(method)
    if(method==='session_create')return {handle_id:'h',header,inherited_event_count:0,event_count:0,identity}
    if(method==='session_flush'&&remoteClosed)throw new Error('flush on remote closed handle')
    if(method==='session_close'&&!remoteClosed){remoteClosed=true;throw new Error('close response lost')}
    return {}
  }},{workspaceRoot:'/tmp/workspace'})
  const handle=await provider.create(header)
  await assert.rejects(handle.close(),/response lost/)
  await assert.rejects(handle.append([event]),SessionHandleClosedError)
  await handle.close()
  assert.deepEqual(methods,['session_create','session_flush','session_close','session_close'])
})

for(const method of ['session_open','session_create']as const)test(`P0 ${method} retries the same private request after a lost reply`,async()=>{
  const requests:Record<string,unknown>[]=[],ctx=new Context();let lost=true
  const provider=new CoordinationSessionPersistence(ctx,{async call(name,params){
    if(name==='session_stat')return {previous_incarnation:'old'}
    if(name==='recover_tool_operations')return {operations:[]}
    if(name==='session_read')return {events:[]}
    if(name===method){requests.push(params!);if(lost){lost=false;throw new Error('open response lost')}return {handle_id:'h',header,inherited_event_count:0,event_count:0,identity}}
    return {}
  }},{workspaceRoot:'/tmp/workspace'})
  const open=()=>method==='session_create'?provider.create(header):provider.open(header.id,'write')
  await assert.rejects(open(),/response lost/)
  if(method==='session_create')await assert.rejects(provider.create({...header,createdAt:2}),/pending session open/)
  const handle=await open()
  assert.equal(requests.length,2)
  assert.deepEqual(requests[0],requests[1])
  await handle.close()
})

test('P0 definitive missing-session response does not poison later create',async()=>{
  const ctx=new Context();let created=false
  const provider=new CoordinationSessionPersistence(ctx,{async call(method){
    if(method==='session_stat')return null
    if(method==='session_open')throw Object.assign(new Error('not found'),{code:'SESSION_NOT_FOUND'})
    if(method==='session_create'){created=true;return {handle_id:'h',header,inherited_event_count:0,event_count:0,identity}}
    return {}
  }},{workspaceRoot:'/tmp/workspace'})
  await assert.rejects(provider.open(header.id,'write'),{name:'SessionPersistenceNotFoundError'})
  const handle=await provider.create(header);assert.equal(created,true);await handle.close()
})

test('P0 disconnected uncertain open refreshes a definitive stale CAS but never takes a live owner',async()=>{
  const ctx=new Context(),requests:Record<string,unknown>[]=[];let phase=0,incarnation='old'
  const provider=new CoordinationSessionPersistence(ctx,{async call(method,params){
    if(method==='session_stat')return {previous_incarnation:incarnation}
    if(method==='session_open'){
      requests.push(params!)
      if(phase++===0){incarnation='committed-then-disconnected';throw new Error('open reply and connection lost')}
      if(params?.expected_previous_incarnation!==incarnation)throw Object.assign(new Error('stale CAS'),{code:'STALE_INSTANCE',details:{}})
      return {handle_id:'recovered',header,inherited_event_count:0,event_count:0,identity}
    }
    if(method==='recover_tool_operations')return {operations:[]}
    return {}
  }},{workspaceRoot:'/tmp/workspace'})
  await assert.rejects(provider.open(header.id,'write'),/connection lost/)
  const handle=await provider.open(header.id,'write')
  assert.equal(requests.length,3)
  assert.equal(requests[0]?.open_request_id,requests[1]?.open_request_id)
  assert.notEqual(requests[1]?.open_request_id,requests[2]?.open_request_id)
  assert.equal(requests[2]?.expected_previous_incarnation,'committed-then-disconnected')
  await handle.close()
})

test('P0 uncertain open retry reporting a connected owner does not mint a fresh takeover request',async()=>{
  const ctx=new Context();let opens=0
  const provider=new CoordinationSessionPersistence(ctx,{async call(method){
    if(method==='session_stat')return {previous_incarnation:'old'}
    if(method==='session_open'){
      if(opens++===0)throw new Error('uncertain transport')
      throw Object.assign(new Error('another owner'),{code:'STALE_INSTANCE',details:{host_error:'SessionAlreadyOwnedError'}})
    }
    return {}
  }},{workspaceRoot:'/tmp/workspace'})
  await assert.rejects(provider.open(header.id,'write'),/uncertain/)
  await assert.rejects(provider.open(header.id,'write'),{name:'SessionAlreadyOwnedError'})
  assert.equal(opens,2)
})
