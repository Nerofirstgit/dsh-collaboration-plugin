import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { CoordinationError, ERROR_CODES } from './errors.ts'
import type { ErrorCode } from './errors.ts'
import type { RuntimeIdentity } from './types.ts'
import { record } from './util.ts'
import { canonicalExistingDirectory } from './platform/resource-paths.ts'
import { COOPERATION_PROTOCOL } from './protocol.ts'

export interface ClientOptions { socket_path:string; admin_token:string; timeout_ms?:number; requiredProtocol?:number }
/** Narrow deterministic test seam. Production uses node:net over the selected Unix socket or Windows named pipe. */
export interface ClientSocket {
  readonly destroyed:boolean
  setEncoding(encoding:BufferEncoding):unknown
  once(event:'connect',listener:()=>void):unknown
  on(event:'data',listener:(data:string)=>void):unknown
  on(event:'error',listener:(error:Error)=>void):unknown
  on(event:'close',listener:()=>void):unknown
  write(data:string,callback:(error?:Error|null)=>void):boolean
  destroy(error?:Error):unknown
}
export type ClientSocketFactory = (socketPath:string)=>ClientSocket
interface PendingRequest {
  method:string; resolve:(value:unknown)=>void; reject:(error:Error)=>void; timer:NodeJS.Timeout
}
interface Connection {
  socket:ClientSocket; opening:Promise<void>; resolveOpen:()=>void; rejectOpen:(error:Error)=>void
  connected:boolean; retired:boolean; buffer:string; pending:Map<string,PendingRequest>
  verifiedProtocol?:number; reservedRootsKey?:string; preparing?:Promise<void>; preparationError?:Error
}

/** Private runtime transport. It never automatically replays an unknown request. */
export class CoordinatorClient {
  private current?:Connection
  private hostStateRoots?:readonly string[]
  private readonly socketFactory:ClientSocketFactory
  readonly options:Readonly<ClientOptions>
  constructor(options:ClientOptions,socketFactory:ClientSocketFactory=path=>connect(path)) {
    if(options.requiredProtocol!==undefined&&(!Number.isSafeInteger(options.requiredProtocol)||options.requiredProtocol<1))throw new CoordinationError('INVALID_ARGUMENT','requiredProtocol must be a positive protocol version.')
    this.options=Object.freeze({...options});this.socketFactory=socketFactory
  }

  private unknown(id:string,method:string,reason:string):CoordinationError {
    return new CoordinationError('OUTCOME_UNKNOWN',reason,{
      request_id:id,method,
      recovery_action:'Inspect the original mutation/message/tool operation ID before retrying; do not create a new operation ID.',
    })
  }
  /** Clear only this generation; a delayed old close must never touch its replacement. */
  private retire(connection:Connection):void {
    if(connection.retired)return
    connection.retired=true;connection.buffer=''
    if(this.current===connection)this.current=undefined
    if(!connection.connected)connection.rejectOpen(new CoordinationError('COORDINATOR_UNAVAILABLE','Coordinator connection closed before any request was dispatched.'))
    for(const [id,item] of connection.pending) {
      clearTimeout(item.timer)
      item.reject(this.unknown(id,item.method,'Coordinator connection closed after dispatch; the original operation may have committed.'))
    }
    connection.pending.clear()
  }
  private receive(connection:Connection,data:string):void {
    if(connection.retired)return
    connection.buffer+=data
    if(Buffer.byteLength(connection.buffer)>32*1024*1024){this.retire(connection);connection.socket.destroy(new Error('Coordinator response exceeded transport bound.'));return}
    let newline:number
    while((newline=connection.buffer.indexOf('\n'))>=0) {
      const line=connection.buffer.slice(0,newline);connection.buffer=connection.buffer.slice(newline+1)
      try {
        const result=record(JSON.parse(line))
        if(typeof result.request_id!=='string'||!['success','warning','error'].includes(String(result.status))||!('data' in result))throw new TypeError('Malformed response envelope')
        const item=connection.pending.get(result.request_id)
        if(!item)continue // A timed-out request is never resurrected by a late response.
        let error:CoordinationError|undefined
        if(result.status==='error') {
          const detail=record(result.error)
          if(typeof detail.code!=='string'||!ERROR_CODES.includes(detail.code as ErrorCode)||typeof detail.message!=='string'||typeof detail.retryable!=='boolean')throw new TypeError('Malformed response error')
          error=new CoordinationError(detail.code as ErrorCode,detail.message,record(detail.details),detail.retryable)
        }
        clearTimeout(item.timer);connection.pending.delete(result.request_id)
        if(error)item.reject(error);else item.resolve(result.data)
      } catch(error) {
        this.retire(connection);connection.socket.destroy(new Error('Invalid coordinator response.'));return
      }
    }
  }
  private async acquire():Promise<Connection> {
    let connection=this.current
    if(connection&&(connection.retired||connection.socket.destroyed)){this.retire(connection);connection=undefined}
    if(!connection) {
      const socket=this.socketFactory(this.options.socket_path)
      let resolveOpen!:()=>void,rejectOpen!:(error:Error)=>void
      const opening=new Promise<void>((resolve,reject)=>{resolveOpen=resolve;rejectOpen=reject})
      connection={socket,opening,resolveOpen,rejectOpen,connected:false,retired:false,buffer:'',pending:new Map()}
      const generation=connection
      this.current=generation;socket.setEncoding('utf8')
      socket.once('connect',()=>{if(generation.retired)return;generation.connected=true;generation.resolveOpen()})
      socket.on('data',data=>this.receive(generation,data))
      socket.on('error',()=>{this.retire(generation);socket.destroy()})
      socket.on('close',()=>this.retire(generation))
    }
    // A live socket object is not proof of a completed connection. Every caller
    // waits on this same generation's connect promise before it can dispatch.
    await connection.opening
    if(connection.retired||connection.socket.destroyed||this.current!==connection)throw new CoordinationError('COORDINATOR_UNAVAILABLE','Coordinator connection changed before request dispatch.')
    return connection
  }
  private assertLive(connection:Connection):void {
    if(connection.retired||connection.socket.destroyed||this.current!==connection)throw new CoordinationError('COORDINATOR_UNAVAILABLE','Coordinator connection changed before request dispatch; no bytes were written.')
  }
  private requiredProtocol():number|undefined { return this.options.requiredProtocol??(this.hostStateRoots?COOPERATION_PROTOCOL:undefined) }
  private rootsKey():string|undefined { return this.hostStateRoots?JSON.stringify(this.hostStateRoots):undefined }
  private prepared(connection:Connection):boolean {
    this.assertLive(connection)
    if(connection.preparationError)throw connection.preparationError
    return connection.verifiedProtocol===this.requiredProtocol()&&connection.reservedRootsKey===this.rootsKey()
  }
  private incompatible(message:string,details:Record<string,unknown>={}):CoordinationError {
    return new CoordinationError('UNMEDIATED_WRITE_DENIED',message,{
      ...details,
      recovery_action:'Keep GUI state writers and participating sessions stopped. Update the shared coordinator to the same collaboration protocol, or correct its durable host-state reservation, then explicitly reconnect. Do not spawn a competing daemon or ignore this gate.',
    })
  }
  /** Internal dispatch deliberately bypasses public call/acquire, avoiding recursive readiness waits. */
  private prepare(connection:Connection):Promise<void> {
    if(connection.preparing)return connection.preparing
    const promise=(async()=>{
      const required=this.requiredProtocol()
      if(required!==undefined&&connection.verifiedProtocol!==required) {
        const response=await this.send(connection,'ping',{},undefined,true)
        this.assertLive(connection)
        if(typeof response!=='object'||response===null||Array.isArray(response)||!('cooperation_protocol' in response)||response.cooperation_protocol!==required)throw this.incompatible('Shared coordinator does not implement the required collaboration protocol; GUI state and session writes remain disabled.',{required_protocol:required})
        connection.verifiedProtocol=required
      }
      // The initial root requirement may arrive while the protocol proof is in flight.
      const roots=this.hostStateRoots,key=this.rootsKey()
      if(roots&&connection.reservedRootsKey!==key) {
        if(roots.some(root=>canonicalExistingDirectory(root)!==root))throw this.incompatible('Canonical Harness state roots changed; readiness must be re-established explicitly.')
        const response=await this.send(connection,'reserve_host_state_roots',{roots:[...roots]},undefined,true)
        this.assertLive(connection)
        if(typeof response!=='object'||response===null||Array.isArray(response)||!('roots' in response)||!Array.isArray(response.roots)||response.roots.length!==roots.length||response.roots.some((root,index)=>typeof root!=='string'||root!==roots[index]))throw this.incompatible('Coordinator did not acknowledge exactly the retained canonical Harness state roots; GUI readiness remains blocked.')
        connection.reservedRootsKey=key
      }
    })()
    connection.preparing=promise
    // Observe failures without making a second rejected promise. A failed proof
    // poisons only this generation, until an explicit close/reconnect.
    void promise.then(()=>{if(connection.preparing===promise)connection.preparing=undefined},error=>{
      connection.preparationError=error instanceof Error?error:this.incompatible('Coordinator readiness could not be established.')
      if(connection.preparing===promise)connection.preparing=undefined
    })
    return promise
  }
  async open():Promise<void> {
    const connection=await this.acquire()
    while(!this.prepared(connection))await this.prepare(connection)
  }
  /** Trusted GUI setup: roots are immutable, and every replacement connection re-reserves them. */
  async ensureHostStateRoots(roots:string[]):Promise<{roots:string[]}> {
    if(!Array.isArray(roots)||roots.length<1||roots.length>64||roots.some(root=>typeof root!=='string'))throw new CoordinationError('INVALID_ARGUMENT','roots must contain 1–64 existing absolute Harness state directories.')
    const canonicalRoots=Object.freeze([...new Set(roots.map(root=>canonicalExistingDirectory(root)))].sort())
    if(this.options.requiredProtocol!==undefined&&this.options.requiredProtocol!==COOPERATION_PROTOCOL)throw this.incompatible('This client protocol cannot guarantee durable Harness state-root reservations.')
    if(this.hostStateRoots&&JSON.stringify(this.hostStateRoots)!==JSON.stringify(canonicalRoots))throw this.incompatible('Harness state roots cannot change for an established client; use a separately admitted profile/client.')
    // Set before the first await, so concurrent ordinary calls cannot pass this gate.
    this.hostStateRoots??=canonicalRoots
    const connection=await this.acquire()
    while(!this.prepared(connection))await this.prepare(connection)
    return{roots:[...this.hostStateRoots]}
  }
  async call(method:string,params:Record<string,unknown>={},identity?:RuntimeIdentity):Promise<unknown> {
    let connection:Connection
    try { connection=await this.acquire() }
    catch(error) { throw new CoordinationError('COORDINATOR_UNAVAILABLE','Cannot connect to the shared coordinator; no request was dispatched and writes remain disabled.') }
    while(!this.prepared(connection))await this.prepare(connection)
    return this.send(connection,method,params,identity)
  }
  private send(connection:Connection,method:string,params:Record<string,unknown>,identity?:RuntimeIdentity,setup=false):Promise<unknown> {
    const id=randomUUID()
    // Serialization happens before adding a pending request or writing bytes.
    const wire=JSON.stringify({id,method,params,identity,admin_token:this.options.admin_token})+'\n'
    this.assertLive(connection)
    // Serialization may invoke user-supplied toJSON: recheck without an await
    // immediately before dispatch, rather than using a stale readiness proof.
    if(!setup&&!this.prepared(connection))throw this.incompatible('Readiness changed during request serialization; the ordinary request was not dispatched.')
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        const item=connection.pending.get(id);if(!item)return
        connection.pending.delete(id)
        reject(this.unknown(id,method,'Coordinator response timed out; the original operation may have committed.'))
      },this.options.timeout_ms??30000)
      connection.pending.set(id,{method,resolve,reject,timer})
      const failed=()=>{
        const item=connection.pending.get(id);if(!item)return
        clearTimeout(item.timer);connection.pending.delete(id)
        reject(this.unknown(id,method,'Coordinator request write failed after dispatch was attempted; its outcome is unknown.'))
      }
      try { connection.socket.write(wire,error=>{if(error)failed()}) }
      catch(error) { failed() }
    })
  }
  close():void {
    const connection=this.current
    if(connection){this.retire(connection);connection.socket.destroy()}
  }
}
