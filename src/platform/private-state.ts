/** Cooperative-runtime state checks using common Node filesystem APIs.
 * POSIX modes are checked where meaningful. Windows ACL isolation is not claimed.
 * These pathname checks do not defend against unrelated processes racing edits.
 */
import {constants,closeSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync} from 'node:fs'
import type {Stats} from 'node:fs'
import {join,parse,resolve,sep} from 'node:path'
import {userInfo} from 'node:os'
import {CoordinationError} from '../errors.ts'
import {canonicalExistingDirectory} from './resource-paths.ts'

export function usesPosixPermissions(platform:NodeJS.Platform=process.platform):boolean{return platform!=='win32'}
function invalid(message:string):never{throw new CoordinationError('PATH_NOT_ALLOWED',message)}
function privateMetadata(info:Stats):void {
  if(usesPosixPermissions()&&(info.uid!==userInfo().uid||(info.mode&0o077)!==0))invalid('Coordinator state must have private POSIX permissions and belong to the current OS user.')
}
export function ensurePrivateDirectory(directory:string):string {
  const absolute=resolve(directory),root=parse(absolute).root
  let current=root
  for(const component of absolute.slice(root.length).split(sep).filter(Boolean)){
    current=join(current,component)
    let info:Stats
    try{info=lstatSync(current)}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
      try{mkdirSync(current,{mode:0o700})}catch(created){if((created as NodeJS.ErrnoException).code!=='EEXIST')throw created}
      info=lstatSync(current)
    }
    if(!info.isDirectory()||info.isSymbolicLink())invalid('Coordinator state path must contain ordinary directories, not symbolic links or junctions.')
  }
  const info=lstatSync(absolute)
  if(!info.isDirectory()||info.isSymbolicLink())invalid('Coordinator state directory is not an ordinary directory.')
  privateMetadata(info)
  return canonicalExistingDirectory(absolute)
}
export function validatePrivateFile(path:string):void {
  const info=lstatSync(path)
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)invalid('Private coordinator file has an unsupported type or alias.')
  privateMetadata(info)
}
export function openPrivateFile(directory:string,name:string,flags:number):number {
  const path=join(directory,name)
  try{validatePrivateFile(path)}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  let fd:number
  try{fd=openSync(path,flags|(usesPosixPermissions()?constants.O_NOFOLLOW:0),0o600)}
  catch(error){if(['ELOOP','EISDIR'].includes((error as NodeJS.ErrnoException).code??''))invalid('Private coordinator file has an unsupported type or alias.');throw error}
  try{
    const info=fstatSync(fd),named=lstatSync(path)
    if(!info.isFile()||named.isSymbolicLink()||info.dev!==named.dev||info.ino!==named.ino||info.nlink!==1)invalid('Private coordinator file changed while opening.')
    privateMetadata(info);return fd
  }catch(error){closeSync(fd);throw error}
}
/** Windows does not expose a portable directory-fsync guarantee through Node. */
export function syncPrivateDirectory(directory:string):void {
  if(!usesPosixPermissions())return
  const fd=openSync(directory,constants.O_RDONLY)
  try{fsyncSync(fd)}finally{closeSync(fd)}
}
