import { constants } from 'node:fs'
import { mkdir, open, lstat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { CoordinationError, fail } from './errors.ts'
import { machineInstanceDirectory } from './config.ts'
/** The writer process itself holds this kernel lock; no PID/heartbeat takeover is allowed. */
export class InstanceLock {
  private constructor(private readonly handle:FileHandle){}
  static async acquire(directory:string):Promise<InstanceLock> {
    if(process.platform!=='linux')fail('UNSUPPORTED_PLATFORM','Protected coordination is initially supported and tested on Linux only.')
    await mkdir(directory,{recursive:true,mode:0o700})
    const info=await lstat(directory)
    if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)fail('PATH_NOT_ALLOWED','Coordinator directory must be a private owned directory without symlinks.')
    const path=join(directory,'coordinator.lock')
    const handle=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600)
    try {
      try {await tryLockExclusive(handle.fd)}catch(error){const code=(error as NodeJS.ErrnoException).code;if(code==='EAGAIN'||code==='EWOULDBLOCK')throw new CoordinationError('COORDINATOR_UNAVAILABLE','Another writer still holds the kernel instance lock.');throw error}
      const a=await handle.stat(),b=await lstat(path)
      if(!a.isFile()||b.isSymbolicLink()||a.dev!==b.dev||a.ino!==b.ino||a.nlink!==1)fail('PATH_NOT_ALLOWED','Coordinator lock pathname changed or has an unsupported alias.')
      return new InstanceLock(handle)
    }catch(error){await handle.close();throw error}
  }
  async close():Promise<void>{await this.handle.close()}
}

/**
 * One writer per OS user/mount namespace, even if two profiles accidentally
 * choose different state directories. This is a second kernel flock, not IPC.
 * TMPDIR/XDG/HOME cannot silently select another live-writer namespace.
 * Cross-user or separate-container writers are outside the supported profile.
 */
export class CoordinatorInstanceLock {
  private constructor(private readonly machine:InstanceLock,private readonly domain:InstanceLock){}
  static async acquire(dataDirectory:string):Promise<CoordinatorInstanceLock>{
    const machine=await InstanceLock.acquire(machineInstanceDirectory())
    try{return new CoordinatorInstanceLock(machine,await InstanceLock.acquire(dataDirectory))}
    catch(error){await machine.close();throw error}
  }
  async close():Promise<void>{try{await this.domain.close()}finally{await this.machine.close()}}
}
