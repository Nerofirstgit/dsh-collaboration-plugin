/** Managed path syntax and canonical validation; filesystem equivalence is delegated to resource-paths. */
import {posix,win32} from 'node:path'
import {fail} from './errors.ts'
import {resolveResourcePath,type ResourcePathOptions} from './platform/resource-paths.ts'

export function normalizeManagedPath(root:string,path:string,platform:NodeJS.Platform=process.platform):string {
 if(typeof path!=='string'||!path.length||!path.isWellFormed()||path.includes('\0'))fail('PATH_NOT_ALLOWED','Invalid file path.')
 const windows=platform==='win32',api=windows?win32:posix
 if(windows&&(!api.isAbsolute(root)||/^\\\\/.test(root)||/^\\\\/.test(path)||(/^[a-z]:/i.test(path)&&!api.isAbsolute(path))))fail('PATH_NOT_ALLOWED','Drive-relative, device and UNC paths are not supported managed paths.')
 if(path.split(windows?/[\\/]/:/\//).some(segment=>segment==='.'||segment==='..'))fail('PATH_NOT_ALLOWED','Dot traversal is not a managed file path.')
 const candidate=api.isAbsolute(path)?api.relative(root,path):path,segments=candidate.split(windows?/[\\/]/:/\//)
 if(api.isAbsolute(candidate)||segments.some(segment=>!segment||segment==='.'||segment==='..'||(windows?segment.toLowerCase():segment)==='.git'||(windows?segment.toLowerCase():segment).startsWith('.dsh-collab-')))fail('PATH_NOT_ALLOWED','Path escapes the workspace or names a reserved resource.')
 if(windows&&segments.some(segment=>/[<>:"|?*\u0000-\u001f]/.test(segment)||/[. ]$/.test(segment)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)))fail('PATH_NOT_ALLOWED','Unsupported Windows filename, stream or device alias.')
 return segments.join('/')
}

/** Syntax checks only: an existing absolute root alias is not lexical containment. */
export function validateManagedPathInput(path:string,platform:NodeJS.Platform=process.platform):void {
 if(typeof path!=='string'||!path.length||!path.isWellFormed()||path.includes('\0'))fail('PATH_NOT_ALLOWED','Invalid file path.')
 const windows=platform==='win32',api=windows?win32:posix,absolute=api.isAbsolute(path)
 if(windows&&((absolute&&!/^[a-z]:[\\/]/i.test(path))||(/^[a-z]:/i.test(path)&&!absolute)))fail('PATH_NOT_ALLOWED','Drive-relative, rooted-current-drive, device and UNC paths are not supported.')
 const segments=path.split(windows?/[\\/]/:/\//)
 if(absolute)segments.shift()
 if(segments.some(segment=>!segment||segment==='.'||segment==='..'))fail('PATH_NOT_ALLOWED','Empty components and dot traversal are not managed file paths.')
 if(windows&&segments.some(segment=>/[<>:"|?*\u0000-\u001f]/.test(segment)||/[. ]$/.test(segment)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)))fail('PATH_NOT_ALLOWED','Unsupported Windows filename, stream or device alias.')
 if(!absolute&&segments.some(segment=>(windows?segment.toLowerCase():segment)==='.git'||(windows?segment.toLowerCase():segment).startsWith('.dsh-collab-')))fail('PATH_NOT_ALLOWED','Path names a reserved resource.')
}

/** Resolve actual identity/spelling first, then check canonical relative containment and reserved entries. */
export function resolveManagedPath(root:string,path:string,options:ResourcePathOptions={}) {
 const platform=options.platform??process.platform
 validateManagedPathInput(path,platform)
 const resolved=resolveResourcePath(root,path,options)
 normalizeManagedPath(resolved.root,resolved.relative,platform)
 return resolved
}
