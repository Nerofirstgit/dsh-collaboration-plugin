/**
 * Historical filename retained for package compatibility. No native dependency.
 * Requires the single participating-dsh writer to own BOTH path resources.
 * The absent-target check excludes cooperating writers, not other programs.
 */
import {lstatSync,renameSync} from 'node:fs'
import {join} from 'node:path'

export function renameNoReplace(fromDirectory:string,from:string,toDirectory:string,to:string):void {
 const source=join(fromDirectory,from),target=join(toDirectory,to)
 try {
  lstatSync(target)
  throw Object.assign(new Error('Rename destination already exists.'),{code:'EEXIST',syscall:'rename',beforePublication:true})
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 renameSync(source,target)
}
