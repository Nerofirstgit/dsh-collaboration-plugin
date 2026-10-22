import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { CoordinationError, fail } from './errors.ts'
import { digest, equalSecret, secret, signed, unsign } from './util.ts'
import { systemClock } from './types.ts'
import type { Clock, RuntimeIdentity, SessionRow, WorkspaceRow } from './types.ts'
export interface EventInput { id?: string; project_id: string; workspace_id?: string; actor_session_id?: string; type: string; payload: unknown; audience?: string[] }
/** Single-daemon durable state. All transaction callbacks are synchronous; no locks span model requests. */
export class Store {
  readonly db: DatabaseSync; readonly clock: Clock; readonly epoch: number; readonly domain: string; readonly signingKey: string
  private depth=0
  private readonly deniedIncarnations=new Set<string>()
  constructor(path: string, clock: Clock=systemClock) {
    this.clock=clock
    if(path!==':memory:') {mkdirSync(dirname(path),{recursive:true,mode:0o700});chmodSync(dirname(path),0o700)}
    this.db=new DatabaseSync(path)
    try {
    // Never silently reconstruct a missing domain or coerce corrupt epoch text
    // back to 0. That could make an obsolete executor credential valid again.
    const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>String(row.name))
    if(tables.length){
      if(!tables.includes('metadata'))fail('STORAGE_ERROR','Existing database has no provable coordinator domain; refusing initialization.')
      const schema=this.meta('schema_version'),domain=this.meta('coordinator_domain'),key=this.meta('signing_key'),rawEpoch=this.meta('coordinator_epoch'),epoch=Number(rawEpoch)
      if(schema!=='1')fail('STORAGE_ERROR','Unsupported coordinator schema version; explicit migration is required.')
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(domain)||!/^[A-Za-z0-9_-]{43}$/.test(key)||!/^\d+$/.test(rawEpoch)||!Number.isSafeInteger(epoch)||epoch<1||epoch>=Number.MAX_SAFE_INTEGER)fail('STORAGE_ERROR','Corrupt coordinator domain credentials or epoch; keep the workspace stopped for recovery.')
      for(const [table,column]of [['sessions','owner_epoch'],['writer_leases','coordinator_epoch'],['file_mutations','coordinator_epoch']] as const)if(tables.includes(table)){
        const maximum=this.db.prepare(`SELECT MAX(${column}) AS maximum FROM ${table}`).get()?.maximum
        if(maximum!==null&&maximum!==undefined&&Number(maximum)>epoch)fail('STORAGE_ERROR','Coordinator epoch is older than its persisted execution evidence; refusing rollback.')
      }
    }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,root TEXT UNIQUE NOT NULL,protected INTEGER NOT NULL DEFAULT 1,recovery_state TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,workspace_id TEXT NOT NULL REFERENCES workspaces(id),incarnation_id TEXT NOT NULL,execution_epoch INTEGER NOT NULL,token_hash TEXT NOT NULL,title TEXT NOT NULL,task_summary TEXT NOT NULL,state TEXT NOT NULL,host_id TEXT NOT NULL,started_at INTEGER NOT NULL,last_heartbeat_at INTEGER NOT NULL,last_heartbeat_mono REAL NOT NULL,owner_epoch INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,context_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,project_id TEXT NOT NULL,workspace_id TEXT,actor_session_id TEXT,type TEXT NOT NULL,payload TEXT NOT NULL,audience TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY REFERENCES events(id),source_type TEXT NOT NULL,source_id TEXT NOT NULL,payload TEXT NOT NULL,published_at INTEGER);
      CREATE TABLE IF NOT EXISTS host_sessions(id TEXT PRIMARY KEY,header TEXT NOT NULL,inherited_event_count INTEGER NOT NULL,event_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS host_events(session_id TEXT NOT NULL REFERENCES host_sessions(id),seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS host_appends(session_id TEXT NOT NULL,append_id TEXT NOT NULL,fingerprint TEXT NOT NULL,event_count INTEGER NOT NULL,PRIMARY KEY(session_id,append_id));
      CREATE TABLE IF NOT EXISTS tool_calls(session_id TEXT NOT NULL,turn_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,fingerprint TEXT NOT NULL,operation_id TEXT NOT NULL,result TEXT,request TEXT NOT NULL DEFAULT '{}',tool_name TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'prepared',PRIMARY KEY(session_id,turn_id,tool_call_id));`)
    const columns=this.db.prepare('PRAGMA table_info(tool_calls)').all().map(row=>row.name)
    if(!columns.includes('request'))this.db.exec("ALTER TABLE tool_calls ADD COLUMN request TEXT NOT NULL DEFAULT '{}'")
    if(!columns.includes('tool_name'))this.db.exec("ALTER TABLE tool_calls ADD COLUMN tool_name TEXT NOT NULL DEFAULT ''")
    this.transaction(()=>{
      for(const [k,v] of [['schema_version','1'],['coordinator_domain',randomUUID()],['signing_key',secret()],['coordinator_epoch','0']]) this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run(k!,v!)
      this.db.prepare("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='coordinator_epoch'").run()
    })
    this.epoch=Number(this.meta('coordinator_epoch'));this.domain=this.meta('coordinator_domain');this.signingKey=this.meta('signing_key')
    }catch(error){this.db.close();throw error}
  }
  meta(key:string):string {const row=this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);if(!row||typeof row.value!=='string') fail('STORAGE_ERROR','Missing coordinator metadata.');return row.value}
  transaction<T>(run:()=>T):T { const nested=this.depth>0;const name='tx_'+this.depth;this.db.exec(nested?'SAVEPOINT '+name:'BEGIN IMMEDIATE');this.depth++;try{const result=run();if(result instanceof Promise) throw new Error('Async SQLite transaction callback prohibited');this.db.exec(nested?'RELEASE '+name:'COMMIT');return result}catch(error){try{this.db.exec(nested?'ROLLBACK TO '+name:'ROLLBACK');if(nested)this.db.exec('RELEASE '+name)}catch(rollbackError){throw new CoordinationError('STORAGE_ERROR','Database rollback failed; stop this coordinator.',{cause:String(rollbackError)})}throw error}finally{this.depth--} }
  session(id:string):SessionRow { const row=this.db.prepare('SELECT * FROM sessions WHERE id=? AND deleted=0').get(id);if(!row)fail('SESSION_NOT_FOUND','Session does not exist.');return row as object as SessionRow }
  workspace(id:string):WorkspaceRow {const row=this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);if(!row)fail('PATH_NOT_ALLOWED','Workspace not registered.');return row as object as WorkspaceRow}
  revokeInMemory(identity:RuntimeIdentity):void {this.deniedIncarnations.add(identity.session_id+'\0'+identity.incarnation_id)}
  assertIdentity(identity:RuntimeIdentity):SessionRow {const row=this.session(identity.session_id);if(this.deniedIncarnations.has(identity.session_id+'\0'+identity.incarnation_id)||identity.coordinator_domain!==this.domain||identity.coordinator_epoch!==this.epoch||row.owner_epoch!==this.epoch||row.incarnation_id!==identity.incarnation_id||row.execution_epoch!==identity.execution_epoch||!equalSecret(row.token_hash,digest(identity.runtime_token)))fail('STALE_INSTANCE','Runtime identity is no longer the active session owner.');return row}
  emitEvent(input:EventInput):{id:string;sequence:number} { const id=input.id??randomUUID();const existing=this.db.prepare('SELECT sequence FROM events WHERE id=?').get(id);if(existing)return{id,sequence:Number(existing.sequence)}; const result=this.db.prepare('INSERT INTO events(id,project_id,workspace_id,actor_session_id,type,payload,audience,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,input.project_id,input.workspace_id??null,input.actor_session_id??null,input.type,JSON.stringify(input.payload),input.audience?JSON.stringify(input.audience):null,this.clock.utc());this.db.prepare('INSERT INTO outbox(event_id,source_type,source_id,payload) VALUES(?,?,?,?)').run(id,input.type,id,JSON.stringify(input));return{id,sequence:Number(result.lastInsertRowid)} }
  sign(value:unknown):string {return signed(this.signingKey,value)}
  unsign(value:string):Record<string,unknown> {return unsign(this.signingKey,value)}
  close():void {this.db.close()}
}
