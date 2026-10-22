import {createHash} from 'node:crypto'
import {join,win32} from 'node:path'
import {userInfo} from 'node:os'
import {chmod,lstat,unlink} from 'node:fs/promises'
import {CoordinationError} from '../errors.ts'

export interface CoordinatorEndpoint {kind:'unix'|'named-pipe';path:string}
/** dataDirectory is the canonical prepared state directory in production.
 * Windows uses the same Node net framing over a local named pipe, never TCP.
 */
export function coordinatorEndpoint(dataDirectory:string,platform:NodeJS.Platform=process.platform):CoordinatorEndpoint {
  if(platform!=='win32')return{kind:'unix',path:join(dataDirectory,'coordinator.sock')}
  const domain=win32.normalize(dataDirectory)
  const account=win32.normalize(userInfo().homedir)
  const hash=createHash('sha256').update(JSON.stringify([account,domain])).digest('hex')
  return{kind:'named-pipe',path:`\\\\.\\pipe\\dsh-collaboration-${hash}`}
}

interface EndpointFileOperations {
  lstat(path:string):Promise<{isSocket():boolean}>
  unlink(path:string):Promise<unknown>
  chmod(path:string,mode:number):Promise<unknown>
}
const fileOperations:EndpointFileOperations={lstat,unlink,chmod}
/** A Windows named pipe is a kernel endpoint, not an ordinary filesystem entry. */
export async function prepareCoordinatorEndpoint(endpoint:CoordinatorEndpoint,operations:EndpointFileOperations=fileOperations):Promise<void> {
  if(endpoint.kind==='named-pipe')return
  try{
    const old=await operations.lstat(endpoint.path)
    if(!old.isSocket())throw new CoordinationError('PATH_NOT_ALLOWED','Coordinator socket path contains a non-socket entry.')
    await operations.unlink(endpoint.path)
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
}
export async function secureCoordinatorEndpoint(endpoint:CoordinatorEndpoint,operations:EndpointFileOperations=fileOperations):Promise<void> {
  if(endpoint.kind==='unix')await operations.chmod(endpoint.path,0o600)
}
export async function removeCoordinatorEndpoint(endpoint:CoordinatorEndpoint,operations:EndpointFileOperations=fileOperations):Promise<void> {
  if(endpoint.kind==='named-pipe')return
  try{await operations.unlink(endpoint.path)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
}
