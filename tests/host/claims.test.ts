import test from 'node:test'
import assert from 'node:assert/strict'
import {ClaimManager,mountClaimManager} from '../../src/host/claims.ts'
import {Context} from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type {ManagedClaim} from '../../src/host/claims.ts'
import type {RuntimeIdentity,SessionState} from '../../src/types.ts'

const identity:RuntimeIdentity={session_id:'s',incarnation_id:'i',execution_epoch:1,coordinator_epoch:1,coordinator_domain:'d',runtime_token:'private'}
const lease=(path='one',id='lease-one'):ManagedClaim=>({path,lease_id:id,coordinator_epoch:1,fencing_token:1})
function fixture(autoRenew=true,ctx?:Context){
 let now=0,current={...identity},nextTimer=0
 const scheduled=new Map<number,{at:number;run:()=>void}>(),calls:{params:Record<string,unknown>;identity:RuntimeIdentity}[]=[],errors:unknown[]=[]
 const rows=new Map<string,ManagedClaim>([['lease-one',lease()],['lease-two',lease('two','lease-two')]])
 let pending:Promise<void>|undefined
 const client={async call(method:string,params:Record<string,unknown>,id?:RuntimeIdentity){assert.equal(method,'renew_claims');assert.ok(id);calls.push({params,identity:id});await pending;return {claims:(params.lease_ids as string[]).map(id=>rows.get(id))}}}
 const options={autoRenew,heartbeatMs:100,leaseTtlMs:90,identityFor:()=>current,onError:(_id:string,error:unknown)=>errors.push(error),now:()=>now,scheduler:{set(run:()=>void,delay:number){const id=++nextTimer;scheduled.set(id,{at:now+delay,run});return id},clear(id:unknown){scheduled.delete(id as number)}}}
 const manager=ctx?mountClaimManager(ctx,client,options):new ClaimManager(client,options)
 manager.state('s','running')
 return {manager,calls,errors,scheduled,advance:(ms:number)=>{now+=ms},identity:(id:RuntimeIdentity)=>{current=id},pending:(p:Promise<void>|undefined)=>{pending=p}}
}
test('F21 controlled monotonic renewal runs at TTL/3 only for actual running owned claims',async()=>{
 const f=fixture();try{f.manager.record(identity,[lease()]);assert.equal([...f.scheduled.values()][0]!.at,30);await f.manager.tick();assert.equal(f.calls.length,0);f.advance(30);await f.manager.tick();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0]!.params.lease_ids,['lease-one']);assert.equal(f.calls[0]!.params.ttl_ms,90);assert.equal(f.calls[0]!.identity.runtime_token,'private');await f.manager.tick();assert.equal(f.calls.length,1);f.advance(30);await f.manager.tick();assert.equal(f.calls.length,2);assert.notEqual(f.calls[1]!.params.request_id,f.calls[0]!.params.request_id)}finally{await f.manager.close()}
})
for(const state of ['idle','waiting','completed','failed','interrupted'] as SessionState[])test(`F21 ${state} stops renewal and cannot silently revive old task claims`,async()=>{
 const f=fixture();try{f.manager.record(identity,[lease()]);f.manager.state('s',state);f.advance(300);await f.manager.tick();assert.equal(f.calls.length,0);assert.equal(f.manager.get('s','one'),undefined);f.manager.state('s','running');await f.manager.tick();assert.equal(f.calls.length,0)}finally{await f.manager.close()}
})
test('F23 incremental FILE_BUSY pauses renewal until an explicit successful claim',async()=>{
 const f=fixture();try{f.manager.record(identity,[lease()]);f.manager.conflict('s');f.advance(30);await f.manager.tick();assert.equal(f.calls.length,0);f.manager.record(identity,[lease()],{explicit:false});f.advance(30);await f.manager.tick();assert.equal(f.calls.length,0);f.manager.record(identity,[lease()],{explicit:true});f.advance(30);await f.manager.tick();assert.equal(f.calls.length,1)}finally{await f.manager.close()}
})
test('auto_renew=false honors configuration without scheduling or renewing',async()=>{
 const f=fixture(false);try{f.manager.record(identity,[lease()]);f.advance(500);await f.manager.tick();assert.equal(f.scheduled.size,0);assert.equal(f.calls.length,0)}finally{await f.manager.close()}
})
test('D07 an old runtime claim is discarded before a new incarnation can renew it',async()=>{
 const f=fixture();try{f.manager.record(identity,[lease()]);f.identity({...identity,incarnation_id:'new',execution_epoch:2});f.advance(30);await f.manager.tick();assert.equal(f.calls.length,0);assert.equal(f.manager.get('s','one'),undefined);assert.equal(f.errors.length,1)}finally{await f.manager.close()}
})
test('F21 pending renewal is not duplicated and a late response cannot revive stopped work',async()=>{
 const f=fixture(),gate=Promise.withResolvers<void>();try{f.pending(gate.promise);f.manager.record(identity,[lease()]);f.advance(30);const first=f.manager.tick(),second=f.manager.tick();assert.equal(f.calls.length,1);f.manager.state('s','waiting');gate.resolve();await Promise.all([first,second]);assert.equal(f.manager.get('s','one'),undefined);f.advance(100);await f.manager.tick();assert.equal(f.calls.length,1)}finally{gate.resolve();await f.manager.close()}
})
test('explicit release forgets only its selected leases; custom short TTL controls scheduling',async()=>{
 const f=fixture();try{f.manager.record(identity,[lease(),lease('two','lease-two')],{ttlMs:30});assert.equal([...f.scheduled.values()][0]!.at,10);f.manager.forget('s',['lease-one']);f.advance(10);await f.manager.tick();assert.deepEqual(f.calls[0]!.params.lease_ids,['lease-two']);assert.equal(f.calls[0]!.params.ttl_ms,30);assert.equal(f.manager.get('s','one'),undefined)}finally{await f.manager.close()}
})

test('late explicit claim response after task stopped is not retained for a later task',async()=>{
 const f=fixture();try{f.manager.state('s','waiting');f.manager.record(identity,[lease()]);assert.equal(f.manager.get('s','one'),undefined);f.manager.state('s','running');f.advance(100);await f.manager.tick();assert.equal(f.calls.length,0)}finally{await f.manager.close()}
})
test('renewal failure pauses instead of retrying indefinitely or inventing a new lease',async()=>{
 const f=fixture();try{f.manager.record(identity,[lease()]);f.pending(Promise.reject(new Error('connection closed')));f.advance(30);await f.manager.tick();assert.equal(f.errors.length,1);f.pending(undefined);f.advance(300);await f.manager.tick();assert.equal(f.calls.length,1);assert.equal(f.scheduled.size,0)}finally{await f.manager.close()}
})
test('real Cordis lifecycle wiring stops renewal during approval and after disposal',async()=>{
 const ctx=new Context();await ctx.plugin(AgentRegistry);const f=fixture(true,ctx)
 try{f.manager.record(identity,[lease()]);ctx.emit('session/event',{id:'s'} as never,{type:'approval/asked',data:{}} as never);f.advance(30);await f.manager.tick();assert.equal(f.calls.length,0);assert.equal(f.manager.get('s','one'),undefined);ctx.emit('session/event',{id:'s'} as never,{type:'approval/decided',data:{}} as never);ctx.emit('agent/status',{agent:{id:'s'},status:'running'} as never);f.manager.record(identity,[lease()]);f.advance(30);await f.manager.tick();assert.equal(f.calls.length,1);ctx.emit('agent/disposed',{agent:{id:'s'}} as never);f.advance(30);await f.manager.tick();assert.equal(f.calls.length,1)}finally{await ctx.fiber.dispose()}
})

test('overlapping human approvals never resume lease renewal after only one answer',async()=>{
 const ctx=new Context();await ctx.plugin(AgentRegistry);const f=fixture(true,ctx)
 try{f.manager.record(identity,[lease()]);for(const id of ['first','second'])ctx.emit('session/event',{id:'s'} as never,{type:'approval/asked',data:{id}} as never);ctx.emit('session/event',{id:'s'} as never,{type:'approval/decided',data:{id:'first'}} as never);ctx.emit('agent/status',{agent:{id:'s'},status:'running'} as never);f.manager.record(identity,[lease()]);f.advance(100);await f.manager.tick();assert.equal(f.calls.length,0);assert.equal(f.manager.get('s','one'),undefined);ctx.emit('session/event',{id:'s'} as never,{type:'approval/decided',data:{id:'second'}} as never);ctx.emit('agent/status',{agent:{id:'s'},status:'running'} as never);f.manager.record(identity,[lease()]);f.advance(30);await f.manager.tick();assert.equal(f.calls.length,1)}finally{await ctx.fiber.dispose()}
})
