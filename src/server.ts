import { createServer } from 'node:net'
import type { Server,Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { Coordinator } from './coordinator.ts'
import { CoordinatorInstanceLock } from './instance-lock.ts'
import {coordinatorEndpoint,prepareCoordinatorEndpoint,secureCoordinatorEndpoint,removeCoordinatorEndpoint} from './platform/ipc.ts'
import { failure, success, CoordinationError } from './errors.ts'
import { equalSecret, record, string, integer, noExtra } from './util.ts'
import type { Config, RuntimeIdentity } from './types.ts'
export interface RunningCoordinator {coordinator:Coordinator;socket_path:string;close():Promise<void>}
function parseIdentity(value:unknown):RuntimeIdentity|undefined {if(value===undefined)return;const v=record(value);noExtra(v,['session_id','incarnation_id','execution_epoch','coordinator_epoch','coordinator_domain','runtime_token']);return{session_id:string(v.session_id,'session_id'),incarnation_id:string(v.incarnation_id,'incarnation_id'),execution_epoch:integer(v.execution_epoch,'execution_epoch',1,Number.MAX_SAFE_INTEGER),coordinator_epoch:integer(v.coordinator_epoch,'coordinator_epoch',1,Number.MAX_SAFE_INTEGER),coordinator_domain:string(v.coordinator_domain,'coordinator_domain'),runtime_token:string(v.runtime_token,'runtime_token')}}
/** Bind only after lifetime SQLite election, epoch transition and durable recovery. */
export async function startCoordinator(config:Config,adminToken:string):Promise<RunningCoordinator> {
  const lock=await CoordinatorInstanceLock.acquire(config.data_dir)
  let coordinator:Coordinator
  try{coordinator=new Coordinator(config)}catch(error){await lock.close();throw error}
  const endpoint=coordinatorEndpoint(config.data_dir),socket_path=endpoint.path
  const sockets=new Set<Socket>(),inflight=new Set<Promise<void>>()
  try{await prepareCoordinatorEndpoint(endpoint)}catch(error){try{coordinator.close()}finally{await lock.close()}throw error}
  const server:Server=createServer(socket=>{
    sockets.add(socket);const connection=randomUUID();let input='';let closed=false;const requests=new Set<Promise<void>>()
    socket.setEncoding('utf8')
    socket.on('data',(chunk:string)=>{
      input+=chunk;if(Buffer.byteLength(input)>32*1024*1024){socket.destroy(new Error('Request exceeds private transport bound.'));return}
      let newline:number
      while((newline=input.indexOf('\n'))>=0){const line=input.slice(0,newline);input=input.slice(newline+1);if(closed)break
        const work=(async()=>{
          let id='invalid'
          try{
            const req=record(JSON.parse(line));noExtra(req,['id','method','params','identity','admin_token']);id=string(req.id,'id',128)
            if(typeof req.admin_token!=='string'||!equalSecret(req.admin_token,adminToken))throw new CoordinationError('PERMISSION_REQUIRED','Private runtime authentication required.')
            const method=string(req.method,'method',128),params=record(req.params),identity=parseIdentity(req.identity)
            if(requests.size>128)throw new CoordinationError('MAILBOX_FULL','Too many in-flight private requests on this connection.')
            const wait=method==='poll_events'?integer(params.wait_ms??0,'wait_ms',0,30000):0
            let result=await coordinator.dispatch(connection,method,params,identity)
            if(wait>0){const deadline=performance.now()+wait;while(!closed&&performance.now()<deadline&&record(result).events instanceof Array&&(record(result).events as unknown[]).length===0){await new Promise<void>(resolve=>setTimeout(resolve,Math.min(25,Math.max(1,deadline-performance.now()))));result=await coordinator.dispatch(connection,method,params,identity)}}
            if(!closed)socket.write(JSON.stringify(success(result,id))+'\n')
          }catch(error){if(!closed)socket.write(JSON.stringify(failure(error,id))+'\n')}
        })();requests.add(work);inflight.add(work);void work.finally(()=>{requests.delete(work);inflight.delete(work)}).catch(()=>undefined)
      }
    })
    socket.on('error',()=>{/* The close handler invalidates this connection only after accepted work settles. */})
    socket.on('close',()=>{closed=true;sockets.delete(socket);const clean=Promise.allSettled([...requests]).then(()=>coordinator.disconnect(connection));inflight.add(clean);void clean.finally(()=>inflight.delete(clean)).catch(()=>undefined)})
  })
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket_path,resolve)});await secureCoordinatorEndpoint(endpoint)}catch(error){await new Promise<void>(resolve=>server.close(()=>resolve()));try{coordinator.close()}finally{await lock.close()}throw error}
  let closing:Promise<void>|undefined
  return{coordinator,socket_path,close(){return closing??=(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await Promise.allSettled([...inflight]);try{coordinator.close();await removeCoordinatorEndpoint(endpoint)}finally{await lock.close()}})()}}
}
