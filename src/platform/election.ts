import {constants,closeSync} from 'node:fs'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {CoordinationError} from '../errors.ts'
import {ensurePrivateDirectory,openPrivateFile,validatePrivateFile} from './private-state.ts'

/** A live SQLite transaction, not a time-based lease or removable lock marker.
 * The connection remains open until release. A paused owner retains its lock;
 * process death releases the OS-backed SQLite lock without a heartbeat decision.
 */
export class SqliteElectionLock {
  private closed=false
  private constructor(private readonly database:DatabaseSync){}
  static acquire(directory:string,filename:string,busyTimeoutMs=0):SqliteElectionLock {
    const canonical=ensurePrivateDirectory(directory)
    // Never open/close an unrelated fd to an existing election DB: on POSIX,
    // closing any fd for the same inode can release this process's SQLite locks.
    const path=join(canonical,filename)
    try{validatePrivateFile(path)}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
      try{closeSync(openPrivateFile(canonical,filename,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL))}
      catch(created){if((created as NodeJS.ErrnoException).code!=='EEXIST')throw created;validatePrivateFile(path)}
    }
    let database:DatabaseSync|undefined
    try{
      database=new DatabaseSync(join(canonical,filename))
      database.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; BEGIN IMMEDIATE;`)
      return new SqliteElectionLock(database)
    }catch(error){
      database?.close()
      const code=typeof error==='object'&&error!==null&&'errcode' in error?Number(error.errcode)&255:undefined
      if(code===5||code===6)throw new CoordinationError('COORDINATOR_UNAVAILABLE','Another cooperating process still holds the SQLite election transaction; no timed takeover is permitted.')
      throw new CoordinationError('STORAGE_ERROR','Cannot acquire the SQLite election transaction; ownership was not established.',{cause:error instanceof Error?error.message:String(error)})
    }
  }
  close():void {
    if(this.closed)return
    this.closed=true
    try{this.database.exec('ROLLBACK')}finally{this.database.close()}
  }
}
