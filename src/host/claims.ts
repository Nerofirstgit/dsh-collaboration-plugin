/** Runtime-owned lease renewal; model code never maintains a heartbeat loop. */
import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {RuntimeIdentity,SessionState} from '../types.ts'
import {CoordinationError} from '../errors.ts'
import {integer,record,string} from '../util.ts'
import type {HostCoordinatorTransport} from './persistence.ts'

export interface ManagedClaim {
  path:string;lease_id:string;coordinator_epoch:number;fencing_token:number
  expires_at?:string;active?:boolean
}
export interface ClaimScheduler {
  set(run:()=>void,delayMs:number):unknown
  clear(handle:unknown):void
}
export interface ClaimManagerOptions {
  autoRenew:boolean;heartbeatMs:number;leaseTtlMs:number
  /** Must resolve the current real host runtime, not model-supplied identity. */
  identityFor(sessionId:string):RuntimeIdentity
  onError?(sessionId:string,error:unknown):void
  now?:()=>number
  scheduler?:ClaimScheduler
}
interface Entry {claim:ManagedClaim;ttlMs:number;nextRenewAt:number}
interface Owner {identity:RuntimeIdentity;entries:Map<string,Entry>;generation:number}
const defaultScheduler:ClaimScheduler={
  set(run,delay){const timer=setTimeout(run,delay);timer.unref();return timer},
  clear(handle){clearTimeout(handle as ReturnType<typeof setTimeout>)},
}
function sameIdentity(a:RuntimeIdentity,b:RuntimeIdentity):boolean {
  return a.session_id===b.session_id&&a.incarnation_id===b.incarnation_id&&a.execution_epoch===b.execution_epoch&&a.coordinator_epoch===b.coordinator_epoch&&a.coordinator_domain===b.coordinator_domain&&a.runtime_token===b.runtime_token
}
function claim(value:unknown):ManagedClaim {
  const v=record(value)
  const result:ManagedClaim={path:string(v.path,'claim.path',4096),lease_id:string(v.lease_id,'claim.lease_id',256),coordinator_epoch:integer(v.coordinator_epoch,'claim.coordinator_epoch',1,Number.MAX_SAFE_INTEGER),fencing_token:integer(v.fencing_token,'claim.fencing_token',1,Number.MAX_SAFE_INTEGER)}
  if(v.active!==undefined){if(typeof v.active!=='boolean')throw new CoordinationError('STORAGE_ERROR','Invalid claim activity response.');result.active=v.active}
  if(v.expires_at!==undefined)result.expires_at=string(v.expires_at,'claim.expires_at',64)
  return result
}

/** Short bounded renewals only while their actual task is still running. */
export class ClaimManager {
  private readonly client:HostCoordinatorTransport
  private readonly options:ClaimManagerOptions
  private readonly now:()=>number
  private readonly scheduler:ClaimScheduler
  private readonly owners=new Map<string,Owner>()
  private readonly states=new Map<string,SessionState>()
  private readonly paused=new Set<string>()
  private timer:unknown
  private ticking:Promise<void>|undefined
  private closed=false
  constructor(client:HostCoordinatorTransport,options:ClaimManagerOptions){
    integer(options.heartbeatMs,'heartbeatMs',1,3600000);integer(options.leaseTtlMs,'leaseTtlMs',1,3600000)
    this.client=client;this.options=options;this.now=options.now??(()=>performance.now());this.scheduler=options.scheduler??defaultScheduler
  }
  private interval(ttl:number):number{return Math.max(1,Math.min(this.options.heartbeatMs,Math.floor(ttl/3)))}
  private report(sessionId:string,error:unknown):void{try{this.options.onError?.(sessionId,error)}catch{/* Diagnostic callbacks cannot resume or extend a lease. */}}
  private eligible(sessionId:string):boolean{return !this.closed&&this.options.autoRenew&&this.states.get(sessionId)==='running'&&!this.paused.has(sessionId)}
  private current(sessionId:string,owner:Owner):boolean {
    try{return sameIdentity(owner.identity,this.options.identityFor(sessionId))}catch{return false}
  }
  /** Successful explicit claim clears FILE_BUSY pause; implicit write auto-claim must pass explicit:false. */
  record(identity:RuntimeIdentity,values:readonly ManagedClaim[],options:{explicit?:boolean;ttlMs?:number}={}):void {
    if(this.closed)throw new CoordinationError('COORDINATOR_UNAVAILABLE','Claim manager is closed.')
    if(!sameIdentity(identity,this.options.identityFor(identity.session_id)))throw new CoordinationError('STALE_INSTANCE','Cannot retain a claim for an obsolete runtime.')
    if(this.states.get(identity.session_id)!=='running'){this.forget(identity.session_id);return}
    const ttlMs=integer(options.ttlMs??this.options.leaseTtlMs,'ttlMs',1,3600000),validated=values.map(value=>claim(value)),id=identity.session_id
    let owner=this.owners.get(id)
    if(!owner||!sameIdentity(owner.identity,identity)){owner={identity:{...identity},entries:new Map(),generation:0};this.owners.set(id,owner)}
    owner.generation++
    let active=false
    for(const item of validated){if(item.active===false){owner.entries.delete(item.path);continue}active=true;owner.entries.set(item.path,{claim:item,ttlMs,nextRenewAt:this.now()+this.interval(ttlMs)})}
    if(active&&options.explicit!==false)this.paused.delete(id)
    if(owner.entries.size===0)this.owners.delete(id)
    this.arm()
  }
  get(sessionId:string,path:string):ManagedClaim|undefined {
    const owner=this.owners.get(sessionId)
    if(!owner)return undefined
    if(!this.current(sessionId,owner)){this.forget(sessionId);return undefined}
    const value=owner.entries.get(path)?.claim
    return value?{...value}:undefined
  }
  /** Forget is local bookkeeping. The authoritative lifecycle/release RPC still releases server leases. */
  forget(sessionId:string,leaseIds?:readonly string[]):void {
    const owner=this.owners.get(sessionId)
    if(owner){owner.generation++;if(leaseIds===undefined)this.owners.delete(sessionId);else{const ids=new Set(leaseIds);for(const [path,entry] of owner.entries)if(ids.has(entry.claim.lease_id))owner.entries.delete(path);if(owner.entries.size===0)this.owners.delete(sessionId)}}
    if(leaseIds===undefined)this.paused.delete(sessionId)
    this.arm()
  }
  conflict(sessionId:string):void{this.paused.add(sessionId);this.arm()}
  /** No old task lease is silently resumed when an idle/waiting Agent later runs again. */
  state(sessionId:string,state:SessionState):void {
    this.states.set(sessionId,state)
    if(state!=='running')this.forget(sessionId)
    this.arm()
  }
  private clearTimer():void{if(this.timer!==undefined){this.scheduler.clear(this.timer);this.timer=undefined}}
  private arm():void {
    this.clearTimer()
    if(this.closed||!this.options.autoRenew||this.ticking)return
    let due=Infinity
    for(const [id,owner] of this.owners)if(this.eligible(id))for(const entry of owner.entries.values())due=Math.min(due,entry.nextRenewAt)
    if(Number.isFinite(due))this.timer=this.scheduler.set(()=>{this.timer=undefined;void this.tick()},Math.max(1,due-this.now()))
  }
  /** Public for deterministic clock tests; production uses the bounded adaptive timer. */
  tick():Promise<void> {
    if(this.ticking)return this.ticking
    if(this.closed||!this.options.autoRenew)return Promise.resolve()
    this.clearTimer()
    const work=[...this.owners].filter(([id])=>this.eligible(id)).map(([id,owner])=>this.renew(id,owner))
    const pending=Promise.all(work).then(()=>undefined)
    this.ticking=pending.finally(()=>{this.ticking=undefined;this.arm()})
    return this.ticking
  }
  private async renew(id:string,owner:Owner):Promise<void> {
    try{
      if(!this.current(id,owner)){this.forget(id);throw new CoordinationError('STALE_INSTANCE','The claim owner is no longer the active runtime.')}
      const generation=owner.generation,groups=new Map<number,Entry[]>()
      for(const entry of owner.entries.values())if(entry.nextRenewAt<=this.now()){const group=groups.get(entry.ttlMs)??[];group.push(entry);groups.set(entry.ttlMs,group)}
      for(const [ttlMs,entries] of groups)for(let start=0;start<entries.length;start+=100){
        if(!this.eligible(id)||this.owners.get(id)!==owner||owner.generation!==generation)return
        if(!this.current(id,owner))throw new CoordinationError('STALE_INSTANCE','Runtime changed before lease renewal.')
        const batch=entries.slice(start,start+100),ids=batch.map(entry=>entry.claim.lease_id)
        const response=record(await this.client.call('renew_claims',{lease_ids:ids,request_id:'runtime-renew:'+randomUUID(),ttl_ms:ttlMs},owner.identity))
        if(!this.eligible(id)||this.owners.get(id)!==owner||owner.generation!==generation)return
        if(!this.current(id,owner))throw new CoordinationError('STALE_INSTANCE','Runtime changed during lease renewal.')
        if(!Array.isArray(response.claims)||response.claims.length!==batch.length)throw new CoordinationError('STORAGE_ERROR','Renewal response lacks the exact requested claim set.')
        const renewed=response.claims.map(value=>claim(value)),byId=new Map(renewed.map(value=>[value.lease_id,value]))
        if(byId.size!==batch.length)throw new CoordinationError('STORAGE_ERROR','Renewal response duplicates a lease.')
        for(const entry of batch){const value=byId.get(entry.claim.lease_id);if(!value||value.active===false||value.path!==entry.claim.path||value.coordinator_epoch!==entry.claim.coordinator_epoch||value.fencing_token!==entry.claim.fencing_token)throw new CoordinationError('STALE_FENCING_TOKEN','Renewal response changed the admitted lease authority.')}
        for(const entry of batch){entry.claim=byId.get(entry.claim.lease_id)!;entry.nextRenewAt=this.now()+this.interval(ttlMs)}
      }
    }catch(error){this.paused.add(id);this.report(id,error)}
  }
  async close():Promise<void>{this.closed=true;this.clearTimer();this.owners.clear();this.states.clear();this.paused.clear();await this.ticking}
}

/** Wire real lifecycle events without editing AgentLoop or sharing model credentials. */
export function mountClaimManager(ctx:Context,client:HostCoordinatorTransport,options:ClaimManagerOptions):ClaimManager {
  const manager=new ClaimManager(client,options)
  const pendingApprovals=new Map<string,Set<string>>()
  ctx.on('agent/status',({agent,status})=>manager.state(agent.id,pendingApprovals.get(agent.id)?.size?'waiting':status==='running'?'running':'idle'))
  ctx.on('session/event',(session,event)=>{
    if(event.type==='turn/end'){
      pendingApprovals.delete(session.id)
      const kind=event.data.reason.kind
      manager.state(session.id,kind==='completed'?'completed':kind==='error'?'failed':kind==='aborted'||kind==='interrupted'?'interrupted':'waiting')
    }else if(event.type==='approval/asked'){const pending=pendingApprovals.get(session.id)??new Set<string>();pending.add(event.data.id);pendingApprovals.set(session.id,pending);manager.state(session.id,'waiting')}
    else if(event.type==='approval/decided'){const pending=pendingApprovals.get(session.id);pending?.delete(event.data.id);manager.state(session.id,pending?.size?'waiting':ctx.agents.get(session.id)?.status==='running'?'running':'idle')}
  })
  ctx.on('agent/disposed',({agent})=>{pendingApprovals.delete(agent.id);manager.forget(agent.id)})
  ctx.effect(()=>()=>manager.close())
  return manager
}
