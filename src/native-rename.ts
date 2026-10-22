/** One fixed Linux primitive, inside the coordinator process holding both guards. */
import koffi from 'koffi'
import {fail} from './errors.ts'
let native:((fromDirectory:number,from:string,toDirectory:number,to:string,flags:number)=>number)|undefined
/** No check-then-overwrite, helper, copy/delete or syscall fallback is permitted. */
export function renameNoReplace(fromDirectory:number,from:string,toDirectory:number,to:string):void {
 if(process.platform!=='linux')fail('UNSUPPORTED_ATOMIC_OPERATION','Ordinary rename requires Linux renameat2(RENAME_NOREPLACE).')
 if(!native){try{native=koffi.load(null).func('int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)')}catch{fail('UNSUPPORTED_ATOMIC_OPERATION','The current libc does not expose renameat2; ordinary rename is unavailable without a safe no-replace primitive.')}}
 if(native(fromDirectory,from,toDirectory,to,1)===0)return
 const errno=koffi.errno(),code=Object.entries(koffi.os.errno).find(([,number])=>number===errno)?.[0]??'UNKNOWN'
 throw Object.assign(new Error(`renameat2(RENAME_NOREPLACE) failed: ${code}`),{code,errno,syscall:'renameat2'})
}
