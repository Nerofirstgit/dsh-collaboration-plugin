import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { CoordinationError, ERROR_CODES } from './errors.ts'
import type { ErrorCode } from './errors.ts'
import type { RuntimeIdentity } from './types.ts'
import { record } from './util.ts'

export interface ClientOptions { socket_path:string; admin_token:string; timeout_ms?:number }
/** Narrow deterministic test seam. Production always uses node:net Unix sockets. */
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
}

/** Private runtime transport. It never automatically replays an unknown request. */
export class CoordinatorClient {
  private current?:Connection
  readonly options:ClientOptions
  constructor(options:ClientOptions,private readonly socketFactory:ClientSocketFactory=path=>connect(path)) { this.options=options }

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
  async open():Promise<void> { await this.acquire() }
  async call(method:string,params:Record<string,unknown>={},identity?:RuntimeIdentity):Promise<unknown> {
    let connection:Connection
    try { connection=await this.acquire() }
    catch(error) { throw new CoordinationError('COORDINATOR_UNAVAILABLE','Cannot connect to the shared coordinator; no request was dispatched and writes remain disabled.') }
    const id=randomUUID()
    // Serialization happens before adding a pending request or writing bytes.
    const wire=JSON.stringify({id,method,params,identity,admin_token:this.options.admin_token})+'\n'
    if(connection.retired||connection.socket.destroyed||this.current!==connection)throw new CoordinationError('COORDINATOR_UNAVAILABLE','Coordinator connection changed before request dispatch; no bytes were written.')
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
