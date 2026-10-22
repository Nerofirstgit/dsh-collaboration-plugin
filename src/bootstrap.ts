import {readFileSync,writeFileSync,fstatSync,fsyncSync,closeSync,constants} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {CoordinatorClient} from './client.ts'
import {COOPERATION_PROTOCOL} from './protocol.ts'
import {CoordinationError} from './errors.ts'
import {canonical,secret} from './util.ts'
import {coordinatorEndpoint} from './config.ts'
import {ensurePrivateDirectory,openPrivateFile,syncPrivateDirectory} from './platform/private-state.ts'
import {SqliteElectionLock} from './platform/election.ts'
import type {Config} from './types.ts'
function privateFile(directory:string,name:string,content:string):string {
  let fd:number,created=false
  try {fd=openPrivateFile(directory,name,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL);created=true}
  catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;fd=openPrivateFile(directory,name,constants.O_RDONLY)}
  try {
    if(created){writeFileSync(fd,content);fsyncSync(fd);syncPrivateDirectory(directory);return content}
    if(fstatSync(fd).size>65536)throw new CoordinationError('PATH_NOT_ALLOWED','Private coordinator configuration is unexpectedly large.')
    return readFileSync(fd,'utf8')
  } finally {closeSync(fd)}
}
/** Prepare local private state only; never opens a transport or starts a process. */
export function preparePrivateState(input:Config):{config:Config;admin_token:string} {
  const directory=ensurePrivateDirectory(input.data_dir)
  // This short transaction prevents simultaneous starters reading half-written
  // config/key files. It never steals or stands in for lifetime daemon election.
  const preparation=SqliteElectionLock.acquire(directory,'bootstrap.sqlite',5000)
  try {
    const config={...input,data_dir:directory},serialized=canonical(config)
    const stored=privateFile(directory,'config.json',serialized)
    if(stored!==serialized)throw new CoordinationError('PERMISSION_REQUIRED','Coordinator settings differ from the existing shared domain. Stop all participants and migrate configuration explicitly; do not silently change active protection.')
    const admin_token=privateFile(directory,'runtime.key',secret()).trim()
    if(!/^[A-Za-z0-9_-]{43}$/.test(admin_token))throw new CoordinationError('PATH_NOT_ALLOWED','Existing coordinator credential is invalid; do not overwrite it or silently create a new domain.')
    return {config,admin_token}
  } finally {preparation.close()}
}
/** Connect all host processes to one SQLite-elected service; never infer takeover from a heartbeat. */
export async function connectCoordinator(input:Config):Promise<CoordinatorClient> {
  const {config,admin_token}=preparePrivateState(input)
  const client=new CoordinatorClient({socket_path:coordinatorEndpoint(config.data_dir).path,admin_token,requiredProtocol:COOPERATION_PROTOCOL})
  try{await client.open();return client}catch(error){client.close();if(error instanceof CoordinationError&&error.code==='UNMEDIATED_WRITE_DENIED')throw error}
  const filename=fileURLToPath(new URL('./daemon-entry.js',import.meta.url))
  const directory=ensurePrivateDirectory(config.data_dir)
  const log=openPrivateFile(directory,'daemon.log',constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND)
  let child:ReturnType<typeof spawn>
  try {child=spawn(process.execPath,[filename,config.data_dir],{detached:true,stdio:['ignore',log,log],env:{...process.env}})}finally{closeSync(log)}
  let spawnError:Error|undefined;child.once('error',error=>{spawnError=error});child.unref()
  const deadline=performance.now()+5000
  while(performance.now()<deadline){if(spawnError)throw spawnError;try{await client.open();return client}catch(error){client.close();if(error instanceof CoordinationError&&error.code==='UNMEDIATED_WRITE_DENIED')throw error;await new Promise<void>(resolve=>setTimeout(resolve,25))}}
  client.close();throw new CoordinationError('COORDINATOR_UNAVAILABLE','No coordinator became available. A paused lock owner is not replaced; inspect the private daemon log.')
}
