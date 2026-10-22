/** Protocol/readiness generations use only fake sockets, never a listener or real spawn. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import net from 'node:net'
import childProcess from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CoordinatorClient,type ClientSocket} from '../src/client.ts'
import {CoordinationError,success,failure} from '../src/errors.ts'
import {connectCoordinator} from '../src/bootstrap.ts'
import {Coordinator} from '../src/coordinator.ts'
import {COOPERATION_PROTOCOL} from '../src/protocol.ts'
import {resolveConfig} from '../src/config.ts'
import {canonicalExistingDirectory} from '../src/platform/resource-paths.ts'

class FakeSocket extends EventEmitter implements ClientSocket {
 destroyed=false;writes:string[]=[];onWrite?:()=>void
 setEncoding(_value:BufferEncoding){return this}
 write(value:string,callback:(error?:Error|null)=>void){this.writes.push(value);callback();this.onWrite?.();return true}
 destroy(){this.destroyed=true;return this}
 connected(){this.emit('connect')}
 closed(){this.destroyed=true;this.emit('close')}
 request(index:number){return JSON.parse(this.writes[index]!) as {id:string;method:string;params:Record<string,unknown>}}
 respond(index:number,value:unknown){this.emit('data',JSON.stringify(success(value,this.request(index).id))+'\n')}
 reject(index:number,code:'WORKSPACE_OVERLAP'){this.emit('data',JSON.stringify(failure(new CoordinationError(code,'fixture conflict'),this.request(index).id))+'\n')}
 methods(){return this.writes.map((_,index)=>this.request(index).method)}
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
function settled(promise:Promise<unknown>){return promise.then(value=>({value,error:undefined}),error=>({value:undefined,error}))}
function fixture(protocol:number|null=2,timeout=1000){
 const dir=canonicalExistingDirectory(mkdtempSync(join(tmpdir(),'dsh-client-readiness-'))),home=join(dir,'home'),other=join(dir,'other');mkdirSync(home);mkdirSync(other)
 const sockets:FakeSocket[]=[]
 const client=new CoordinatorClient({socket_path:'/fake-never-opened',admin_token:'fixture',timeout_ms:timeout,...protocol===null?{}:{requiredProtocol:protocol}},()=>{const socket=new FakeSocket();sockets.push(socket);return socket})
 return{dir,home,other,client,sockets,close(){client.close();for(const socket of sockets)socket.closed();rmSync(dir,{recursive:true,force:true})}}
}
async function ensure(client:CoordinatorClient,roots:string[]){assert.equal(typeof client.ensureHostStateRoots,'function');return client.ensureHostStateRoots(roots)}
async function start(f:ReturnType<typeof fixture>){await tick();const socket=f.sockets.at(-1)!;socket.connected();await tick();return socket}
async function admit(f:ReturnType<typeof fixture>){const pending=settled(ensure(f.client,[f.home])),socket=await start(f);assert.deepEqual(socket.methods(),['ping']);socket.respond(0,{cooperation_protocol:2});await tick();assert.deepEqual(socket.methods(),['ping','reserve_host_state_roots']);socket.respond(1,{roots:[f.home]});assert.deepEqual((await pending).value,{roots:[f.home]});return socket}

test('concurrent ordinary calls share one protocol proof before either dispatches',async()=>{const f=fixture();const a=settled(f.client.call('session_list')),b=settled(f.client.call('session_stat',{id:'a'}));try{
 const socket=await start(f);assert.deepEqual(socket.methods(),['ping']);socket.respond(0,{cooperation_protocol:2});await tick();assert.deepEqual(socket.methods(),['ping','session_list','session_stat']);socket.respond(1,'a');socket.respond(2,'b');assert.equal((await a).value,'a');assert.equal((await b).value,'b')
}finally{f.close();await Promise.all([a,b])}})

for(const ping of [{},{cooperation_protocol:1},{cooperation_protocol:'2'}])test(`incompatible protocol ${JSON.stringify(ping)} cannot dispatch an ordinary operation`,async()=>{const f=fixture();const a=settled(f.client.call('apply_file_change',{mutation_id:'never'})),b=settled(f.client.call('session_list'));try{
 const socket=await start(f);socket.respond(0,ping);assert.equal((await a).error?.code,'UNMEDIATED_WRITE_DENIED');assert.equal((await b).error?.code,'UNMEDIATED_WRITE_DENIED');assert.deepEqual(socket.methods(),['ping']);assert.equal(f.sockets.length,1)
}finally{f.close();await Promise.all([a,b])}})

test('immutable roots and concurrent admission wait for the same durable reservation response',async()=>{const f=fixture();const roots=[f.home],ready=settled(ensure(f.client,roots));roots[0]=f.other;const call=settled(f.client.call('session_create'));try{
 const socket=await start(f);socket.respond(0,{cooperation_protocol:2});await tick();assert.deepEqual(socket.methods(),['ping','reserve_host_state_roots']);assert.deepEqual(socket.request(1).params,{roots:[f.home]});socket.respond(1,{roots:[f.home]});assert.deepEqual((await ready).value,{roots:[f.home]});await tick();assert.equal(socket.request(2).method,'session_create');socket.respond(2,'created');assert.equal((await call).value,'created')
 assert.deepEqual(await ensure(f.client,[f.home,f.home]),{roots:[f.home]});assert.equal(socket.writes.length,3)
 await assert.rejects(ensure(f.client,[f.other]),{code:'UNMEDIATED_WRITE_DENIED'});assert.equal(socket.writes.length,3)
}finally{f.close();await Promise.all([ready,call])}})

test('replacement generation repeats protocol and reservation; it never replays an unknown mutation',async()=>{const f=fixture();try{
 const old=await admit(f),mutation=settled(f.client.call('apply_file_change',{mutation_id:'original'}));await tick();old.closed();assert.equal((await mutation).error?.code,'OUTCOME_UNKNOWN')
 const next=settled(f.client.call('get_mutation_status',{mutation_id:'original'})),current=await start(f);assert.deepEqual(current.methods(),['ping']);current.respond(0,{cooperation_protocol:2});await tick();assert.deepEqual(current.methods(),['ping','reserve_host_state_roots']);current.respond(1,{roots:[f.home]});await tick();old.closed();assert.deepEqual(current.methods(),['ping','reserve_host_state_roots','get_mutation_status']);current.respond(2,'known');assert.equal((await next).value,'known');assert.equal(f.sockets.flatMap(s=>s.methods()).filter(name=>name==='apply_file_change').length,1)
}finally{f.close()}})

test('connection loss during reservation cannot authorize a waiting session call',async()=>{const f=fixture();const ready=settled(ensure(f.client,[f.home])),call=settled(f.client.call('session_create'));try{
 const socket=await start(f);socket.respond(0,{cooperation_protocol:2});await tick();socket.closed();assert.ok((await ready).error);assert.ok((await call).error);assert.deepEqual(socket.methods(),['ping','reserve_host_state_roots'])
 const retry=settled(f.client.call('session_list')),next=await start(f);next.respond(0,{cooperation_protocol:2});await tick();next.respond(1,{roots:[f.home]});await tick();assert.equal(next.request(2).method,'session_list');next.respond(2,[]);assert.deepEqual((await retry).value,[])
}finally{f.close();await Promise.all([ready,call])}})

for(const variant of ['wrong','extra','duplicate','malformed'] as const)test(`reservation ${variant} response fails readiness closed`,async()=>{const f=fixture();const ready=settled(ensure(f.client,[f.home])),call=settled(f.client.call('session_create'));try{
 const socket=await start(f);socket.respond(0,{cooperation_protocol:2});await tick();socket.respond(1,variant==='wrong'?{roots:[f.other]}:variant==='extra'?{roots:[f.home,f.other]}:variant==='duplicate'?{roots:[f.home,f.home]}:{roots:'not-an-array'});assert.equal((await ready).error?.code,'UNMEDIATED_WRITE_DENIED');assert.equal((await call).error?.code,'UNMEDIATED_WRITE_DENIED');assert.deepEqual(socket.methods(),['ping','reserve_host_state_roots'])
}finally{f.close();await Promise.all([ready,call])}})

test('known reservation refusal cannot be mistaken for successful protocol readiness',async()=>{const f=fixture();const ready=settled(ensure(f.client,[f.home])),call=settled(f.client.call('session_create'));try{
 const socket=await start(f);socket.respond(0,{cooperation_protocol:2});await tick();socket.reject(1,'WORKSPACE_OVERLAP');assert.equal((await ready).error?.code,'WORKSPACE_OVERLAP');assert.equal((await call).error?.code,'WORKSPACE_OVERLAP');assert.deepEqual(socket.methods(),['ping','reserve_host_state_roots'])
}finally{f.close();await Promise.all([ready,call])}})

test('roots added while protocol proof settles are still required before ordinary dispatch',async()=>{const f=fixture();const call=settled(f.client.call('session_create'));let ready:ReturnType<typeof settled>|undefined;try{
 const socket=await start(f);socket.respond(0,{cooperation_protocol:2});queueMicrotask(()=>{ready=settled(ensure(f.client,[f.home]))});await tick();assert.deepEqual(socket.methods(),['ping','reserve_host_state_roots']);socket.respond(1,{roots:[f.home]});await tick();socket.respond(2,'ready');assert.equal((await call).value,'ready');assert.deepEqual((await ready)?.value,{roots:[f.home]})
}finally{f.close();await call;if(ready)await ready}})

for(const compatible of [false,true])test(`production bootstrap ${compatible?'requires protocol on its client':'refuses old peer without spawning or retrying'}`,async()=>{
 const dir=canonicalExistingDirectory(mkdtempSync(join(tmpdir(),'dsh-bootstrap-protocol-'))),oldConnect=net.connect,oldSpawn=childProcess.spawn,sockets:FakeSocket[]=[];let spawns=0,client:CoordinatorClient|undefined
 Object.defineProperty(net,'connect',{value:()=>{const socket=new FakeSocket();sockets.push(socket);socket.onWrite=()=>queueMicrotask(()=>socket.respond(socket.writes.length-1,{cooperation_protocol:compatible?2:1}));queueMicrotask(()=>socket.connected());return socket}})
 Object.defineProperty(childProcess,'spawn',{value:()=>{spawns++;throw new Error('A real daemon spawn is forbidden in this component test')}});syncBuiltinESMExports()
 try{
  const promise=connectCoordinator(resolveConfig({data_dir:join(dir,'private')}))
  if(compatible){client=await promise;assert.equal(client.options.requiredProtocol,2)}else await assert.rejects(promise,{code:'UNMEDIATED_WRITE_DENIED'})
  assert.equal(spawns,0);assert.equal(sockets.length,1);assert.deepEqual(sockets[0]!.methods(),['ping'])
 }finally{client?.close();for(const socket of sockets)socket.closed();Object.defineProperty(net,'connect',{value:oldConnect});Object.defineProperty(childProcess,'spawn',{value:oldSpawn});syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true})}
})


test('the actual coordinator advertises the exact readiness protocol without opening a listener',async()=>{
 const f=fixture(),coordinator=new Coordinator(resolveConfig({data_dir:join(f.dir,'state')}))
 try{assert.equal(COOPERATION_PROTOCOL,2);const reply=await coordinator.dispatch('fixture','ping',{});assert.equal(typeof reply,'object');assert.equal(Reflect.get(reply as object,'cooperation_protocol'),COOPERATION_PROTOCOL)}finally{coordinator.close();f.close()}
})

test('a transport-only client still requires the feature protocol when GUI roots are first requested',async()=>{const f=fixture(null);try{
 assert.equal(f.client.options.requiredProtocol,undefined);await admit(f)
}finally{f.close()}})

test('invalid state roots fail before creating any connection',async()=>{const f=fixture();try{
 await assert.rejects(ensure(f.client,[]),{code:'INVALID_ARGUMENT'});await assert.rejects(ensure(f.client,['relative-path']),{code:'PATH_NOT_ALLOWED'});await assert.rejects(ensure(f.client,[join(f.dir,'missing')]),{code:'PATH_NOT_ALLOWED'});assert.equal(f.sockets.length,0)
}finally{f.close()}})

test('a failed reservation remains closed for later ordinary calls on that same connection',async()=>{const f=fixture(),ready=settled(ensure(f.client,[f.home]));try{
 const socket=await start(f);socket.respond(0,{cooperation_protocol:2});await tick();socket.reject(1,'WORKSPACE_OVERLAP');assert.equal((await ready).error?.code,'WORKSPACE_OVERLAP');await assert.rejects(f.client.call('session_create'),{code:'WORKSPACE_OVERLAP'});await assert.rejects(ensure(f.client,[f.home]),{code:'WORKSPACE_OVERLAP'});assert.deepEqual(socket.methods(),['ping','reserve_host_state_roots'])
}finally{f.close();await ready}})

test('late reservation success after timeout never resurrects readiness',async()=>{const f=fixture(2,15),ready=settled(ensure(f.client,[f.home])),call=settled(f.client.call('session_create'));try{
 const socket=await start(f);socket.respond(0,{cooperation_protocol:2});await tick();assert.equal((await ready).error?.code,'OUTCOME_UNKNOWN');assert.equal((await call).error?.details.method,'reserve_host_state_roots');socket.respond(1,{roots:[f.home]});await assert.rejects(f.client.call('session_create'),{code:'OUTCOME_UNKNOWN'});assert.deepEqual(socket.methods(),['ping','reserve_host_state_roots'])
}finally{f.close();await Promise.all([ready,call])}})

test('old peer discovered after a fake startup is not retried or replaced again',async()=>{
 const dir=canonicalExistingDirectory(mkdtempSync(join(tmpdir(),'dsh-bootstrap-retry-protocol-'))),oldConnect=net.connect,oldSpawn=childProcess.spawn,sockets:FakeSocket[]=[];let spawns=0
 Object.defineProperty(net,'connect',{value:()=>{const socket=new FakeSocket();sockets.push(socket);if(sockets.length===1)queueMicrotask(()=>socket.emit('error',new Error('fixture unavailable')));else{socket.onWrite=()=>queueMicrotask(()=>socket.respond(socket.writes.length-1,{cooperation_protocol:1}));queueMicrotask(()=>socket.connected())}return socket}})
 Object.defineProperty(childProcess,'spawn',{value:()=>{spawns++;return Object.assign(new EventEmitter(),{unref(){}})}});syncBuiltinESMExports()
 try{await assert.rejects(connectCoordinator(resolveConfig({data_dir:join(dir,'private')})),{code:'UNMEDIATED_WRITE_DENIED'});assert.equal(spawns,1);assert.equal(sockets.length,2);assert.deepEqual(sockets[0]!.methods(),[]);assert.deepEqual(sockets[1]!.methods(),['ping'])}
 finally{for(const socket of sockets)socket.closed();Object.defineProperty(net,'connect',{value:oldConnect});Object.defineProperty(childProcess,'spawn',{value:oldSpawn});syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true})}
})
