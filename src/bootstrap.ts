import { mkdirSync, readFileSync, writeFileSync, lstatSync, fstatSync, fsyncSync, openSync, closeSync, constants, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { CoordinatorClient } from './client.ts'
import { CoordinationError } from './errors.ts'
import { canonical, secret } from './util.ts'
import type { Config } from './types.ts'
/** Open every directory component without following aliases; create only missing owned components. */
function privateDirectory(directory:string):{path:string;fd:number} {
  const path=resolve(directory)
  let fd=openSync('/',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
  try {
    for(const component of path.split('/').filter(Boolean)) {
      const child=`/proc/self/fd/${fd}/${component}`
      let next:number
      try { next=openSync(child,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW) }
      catch(error) {
        const code=(error as NodeJS.ErrnoException).code
        if(code!=='ENOENT')throw new CoordinationError('PATH_NOT_ALLOWED','Coordinator directory has an unsupported alias or non-directory component.')
        try {mkdirSync(child,{mode:0o700})}catch(created){if((created as NodeJS.ErrnoException).code!=='EEXIST')throw created}
        try {next=openSync(child,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)}catch(opened){throw new CoordinationError('PATH_NOT_ALLOWED','Coordinator directory changed while being created.')}
      }
      closeSync(fd);fd=next
    }
    const info=fstatSync(fd),named=lstatSync(path)
    if(!info.isDirectory()||named.isSymbolicLink()||info.dev!==named.dev||info.ino!==named.ino||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||realpathSync(`/proc/self/fd/${fd}`)!==path)throw new CoordinationError('PATH_NOT_ALLOWED','Coordinator directory must be private, owned, stable and free of symlink aliases.')
    return {path,fd}
  } catch(error) {closeSync(fd);throw error}
}
function checkedPrivateFile(directory:number,name:string,flags:number):number {
  const path=`/proc/self/fd/${directory}/${name}`
  let fd:number
  try {fd=openSync(path,flags|constants.O_NOFOLLOW,0o600)}
  catch(error) {if(['ELOOP','EISDIR'].includes((error as NodeJS.ErrnoException).code??''))throw new CoordinationError('PATH_NOT_ALLOWED','Private coordinator file has an unsupported alias or type.');throw error}
  try {
    const info=fstatSync(fd),named=lstatSync(path)
    if(!info.isFile()||named.isSymbolicLink()||info.dev!==named.dev||info.ino!==named.ino||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new CoordinationError('PATH_NOT_ALLOWED','Private coordinator file has unsafe ownership, permissions or aliases.')
    return fd
  } catch(error) {closeSync(fd);throw error}
}
function privateFile(directory:number,name:string,content:string):string {
  let fd:number,created=false
  try {fd=checkedPrivateFile(directory,name,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL);created=true}
  catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;fd=checkedPrivateFile(directory,name,constants.O_RDONLY)}
  try {
    if(created){writeFileSync(fd,content);fsyncSync(fd);fsyncSync(directory);return content}
    if(fstatSync(fd).size>65536)throw new CoordinationError('PATH_NOT_ALLOWED','Private coordinator configuration is unexpectedly large.')
    return readFileSync(fd,'utf8')
  } finally {closeSync(fd)}
}
/** Prepare local private state only; never opens a transport or starts a process. */
export function preparePrivateState(input:Config):{config:Config;admin_token:string} {
  if(process.platform!=='linux')throw new CoordinationError('UNSUPPORTED_PLATFORM','This protected plugin build has been verified only on Linux.')
  const directory=privateDirectory(input.data_dir)
  try {
    const config={...input,data_dir:directory.path},serialized=canonical(config)
    const stored=privateFile(directory.fd,'config.json',serialized)
    if(stored!==serialized)throw new CoordinationError('PERMISSION_REQUIRED','Coordinator settings differ from the existing shared domain. Stop all participants and migrate configuration explicitly; do not silently change active protection.')
    const admin_token=privateFile(directory.fd,'runtime.key',secret()).trim()
    if(!/^[A-Za-z0-9_-]{43}$/.test(admin_token))throw new CoordinationError('PATH_NOT_ALLOWED','Existing coordinator credential is invalid; do not overwrite it or silently create a new domain.')
    return {config,admin_token}
  } finally {closeSync(directory.fd)}
}
/** Connect all host processes to one kernel-locked service; never infer takeover from a heartbeat. */
export async function connectCoordinator(input:Config):Promise<CoordinatorClient> {
  const {config,admin_token}=preparePrivateState(input)
  const client=new CoordinatorClient({socket_path:join(config.data_dir,'coordinator.sock'),admin_token})
  try{await client.call('ping');return client}catch(error){client.close()}
  const filename=fileURLToPath(new URL('./daemon-entry.js',import.meta.url))
  const directory=privateDirectory(config.data_dir)
  let log:number
  try {log=checkedPrivateFile(directory.fd,'daemon.log',constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND)}finally{closeSync(directory.fd)}
  let child:ReturnType<typeof spawn>
  try {child=spawn(process.execPath,[filename,config.data_dir],{detached:true,stdio:['ignore',log,log],env:{...process.env}})}finally{closeSync(log)}
  let spawnError:Error|undefined;child.once('error',error=>{spawnError=error});child.unref()
  const deadline=performance.now()+5000
  while(performance.now()<deadline){if(spawnError)throw spawnError;try{await client.call('ping');return client}catch(error){await new Promise<void>(resolve=>setTimeout(resolve,25))}}
  client.close();throw new CoordinationError('COORDINATOR_UNAVAILABLE','No coordinator became available. A paused lock owner is not replaced; inspect the private daemon log.')
}
