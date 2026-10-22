/**
 * Filesystem-aware component spelling, not a stable inode resource key.
 * Production callers use real Node APIs; the adapter is an internal fixture seam.
 * This does not certify every Windows filesystem's file-ID uniqueness or ACLs.
 */
import {lstatSync,opendirSync,realpathSync} from 'node:fs'
import {posix,win32} from 'node:path'
import {CoordinationError} from '../errors.ts'

export interface ResourcePathStat {dev:bigint;ino:bigint;kind:'directory'|'file'|'symlink'|'other'}
export interface ResourcePathFileSystem {
  realpath(path:string):string
  lstat(path:string):ResourcePathStat
  readDirectory(path:string,maximum:number):{entries:readonly string[];complete:boolean}
}
export interface ResourcePathOptions {
  platform?:NodeJS.Platform
  filesystem?:ResourcePathFileSystem
  maxDirectoryEntries?:number
  allowMissingLeaf?:boolean
}
export interface ResourceObjectIdentity {dev:string;ino:string}
export interface ResolvedResourcePath {
  root:string
  /** Canonical component spellings joined by '/', not an inode-derived ID. */
  relative:string
  path:string
  parent:string
  parentIdentity:ResourceObjectIdentity
  exists:boolean
  objectIdentity?:ResourceObjectIdentity
}
const nodeFileSystem:ResourcePathFileSystem={
  realpath(path){return realpathSync.native(path)},
  lstat(path){
    const stat=lstatSync(path,{bigint:true})
    return{dev:stat.dev,ino:stat.ino,kind:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':stat.isFile()?'file':'other'}
  },
  readDirectory(path,maximum){
    const directory=opendirSync(path),entries:string[]=[]
    try{
      for(let index=0;index<=maximum;index++){
        const entry=directory.readSync()
        if(entry===null)return{entries,complete:true}
        if(index===maximum)return{entries,complete:false}
        entries.push(entry.name)
      }
      return{entries,complete:false}
    }finally{directory.closeSync()}
  },
}
function denied(message:string):never {throw new CoordinationError('PATH_NOT_ALLOWED',message)}
function checked<T>(run:()=>T):T {
  try{return run()}catch(error){
    if(error instanceof CoordinationError)throw error
    return denied('Cannot resolve an ordinary managed path completely; no alternative spelling was assumed.')
  }
}
function identity(info:ResourcePathStat):ResourceObjectIdentity {
  if(typeof info.dev!=='bigint'||typeof info.ino!=='bigint'||info.dev<=0n||info.ino<=0n)denied('Filesystem object identifiers are unavailable or unsupported.')
  return{dev:info.dev.toString(),ino:info.ino.toString()}
}
function same(a:ResourcePathStat,b:ResourcePathStat):boolean{return a.kind===b.kind&&a.dev===b.dev&&a.ino===b.ino}
function ordinary(info:ResourcePathStat,directory=false):ResourcePathStat {
  identity(info)
  if(directory?info.kind!=='directory':info.kind!=='directory'&&info.kind!=='file')denied('Managed path components must be ordinary files or directories, not links or special entries.')
  return info
}
function wellFormed(path:string):void {if(typeof path!=='string'||!path||!path.isWellFormed()||path.includes('\0'))denied('Invalid managed path.')}

class Resolver {
  readonly windows:boolean
  readonly api:typeof posix
  readonly filesystem:ResourcePathFileSystem
  readonly maximum:number
  readonly options:ResourcePathOptions
  constructor(options:ResourcePathOptions){
    this.options=options
    this.windows=(options.platform??process.platform)==='win32'
    this.api=this.windows?win32:posix
    this.filesystem=options.filesystem??nodeFileSystem
    this.maximum=options.maxDirectoryEntries??10000
    if(!Number.isSafeInteger(this.maximum)||this.maximum<1||this.maximum>100000)denied('Directory enumeration limit must be between 1 and 100000.')
  }
  absolute(path:string):string {
    wellFormed(path)
    if(!this.api.isAbsolute(path))denied('An absolute local path is required.')
    if(this.windows&&(!/^[a-z]:[\\/]/i.test(path)||/^\\\\/.test(path)))denied('UNC, device and drive-relative paths are not supported.')
    const normalized=this.api.normalize(path)
    return this.windows?normalized[0]!.toUpperCase()+normalized.slice(1):normalized
  }
  components(path:string):{base:string;parts:string[]} {
    const absolute=this.absolute(path),base=this.api.parse(absolute).root,parts=absolute.slice(base.length).split(this.api.sep).filter(Boolean)
    if(parts.length>256)denied('Managed path has too many components.')
    return{base,parts}
  }
  metadata(path:string,directory=false):ResourcePathStat{return ordinary(this.filesystem.lstat(path),directory)}
  directoryNames(parent:string):readonly string[]{
    const listing=this.filesystem.readDirectory(parent,this.maximum)
    if(!listing.complete||listing.entries.length>this.maximum)denied('Directory enumeration is incomplete or exceeds the configured bound.')
    const unique=new Set<string>()
    for(const name of listing.entries){
      if(!name||!name.isWellFormed()||name==='.'||name==='..'||/[\\/\0]/.test(name)||unique.has(name))denied('Directory enumeration contains an unsupported or duplicate entry name.')
      unique.add(name)
    }
    return listing.entries
  }
  /** No realpath call here: a link within the managed path must not disappear. */
  child(parent:string,name:string,parentInfo:ResourcePathStat,allowMissing:boolean):{path:string;info?:ResourcePathStat} {
    const requested=this.api.join(parent,name)
    let requestedInfo:ResourcePathStat
    try{requestedInfo=this.metadata(requested)}catch(error){
      if(allowMissing&&(error as NodeJS.ErrnoException).code==='ENOENT'){
        if(this.windows&&this.directoryNames(parent).includes(name))denied('An apparently absent leaf is present in the directory listing.')
        this.revalidate(parent,parentInfo)
        return{path:requested}
      }
      throw error
    }
    if(!this.windows){this.revalidate(parent,parentInfo);return{path:requested,info:requestedInfo}}
    const names=this.directoryNames(parent)
    let chosen:string|undefined
    if(names.includes(name)){
      const exact=this.metadata(this.api.join(parent,name))
      if(!same(exact,requestedInfo))denied('Exact directory entry changed during resolution.')
      chosen=name
    }else{
      for(const candidate of names){
        const candidateInfo=this.filesystem.lstat(this.api.join(parent,candidate))
        identity(candidateInfo)
        if(!same(candidateInfo,requestedInfo))continue
        if(chosen!==undefined)denied('More than one directory entry matches the requested object identity.')
        ordinary(candidateInfo);chosen=candidate
      }
      if(chosen===undefined)denied('Requested alias has no unique ordinary directory entry.')
    }
    const path=this.api.join(parent,chosen),final=this.metadata(path)
    if(!same(final,requestedInfo))denied('Directory entry changed during resolution.')
    this.revalidate(parent,parentInfo)
    return{path,info:final}
  }
  revalidate(path:string,info:ResourcePathStat):void {
    if(!same(this.metadata(path,true),info))denied('Parent directory identity changed during resolution.')
  }
  /** Trusted workspace roots may use a realpath alias; inside-root paths may not. */
  directory(path:string):string {
    const input=this.absolute(path),real=this.absolute(this.filesystem.realpath(input))
    if(!this.windows){this.metadata(real,true);return real}
    const {base,parts}=this.components(real)
    let current=base,info=this.metadata(base,true)
    for(const name of parts){
      const child=this.child(current,name,info,false)
      current=child.path;info=ordinary(child.info!,true)
    }
    return current
  }
  relativeComponents(root:string,path:string):string[] {
    wellFormed(path)
    const segments=path.split(this.windows?/[\\/]/:/\//)
    if(segments.some(segment=>segment==='.'||segment==='..'))denied('Dot traversal is not a managed resource path.')
    if(!this.api.isAbsolute(path)){
      if(this.windows&&/^[a-z]:/i.test(path))denied('Drive-relative paths are not supported.')
      const parts=segments.filter(Boolean)
      if(!parts.length||parts.length>256)denied('A bounded non-empty resource path is required.')
      return parts
    }
    const {base,parts}=this.components(path)
    // Resolve only prefixes before entering the protected root. This supports a
    // trusted root alias but never realpaths away a link below that root.
    let prefix=base
    for(let index=0;index<=parts.length;index++){
      if(this.directory(prefix)===root){
        const remaining=parts.slice(index)
        if(!remaining.length)denied('The workspace root is not a leaf resource.')
        return remaining
      }
      if(index<parts.length)prefix=this.api.join(prefix,parts[index]!)
    }
    return denied('The requested path is not inside the resolved workspace root.')
  }
}

/** Canonical spelling for a trusted existing directory, including selected root aliases. */
export function canonicalExistingDirectory(path:string,options:ResourcePathOptions={}):string {
  return checked(()=>new Resolver(options).directory(path))
}
/**
 * An absent leaf has only an exact spelling and a canonical existing parent.
 * It is NOT evidence of case/8.3 equivalence; the writer must claim the parent
 * namespace before creating it. This function neither acquires nor grants leases.
 */
export function resolveResourcePath(root:string,path:string,options:ResourcePathOptions={}):ResolvedResourcePath {
  return checked(()=>{
    const resolver=new Resolver(options),canonicalRoot=resolver.directory(root),parts=resolver.relativeComponents(canonicalRoot,path)
    let parent=canonicalRoot,parentInfo=resolver.metadata(parent,true)
    const actual:string[]=[]
    for(const [index,name]of parts.entries()){
      const last=index===parts.length-1,child=resolver.child(parent,name,parentInfo,last&&options.allowMissingLeaf===true)
      actual.push(resolver.api.basename(child.path))
      if(last)return{root:canonicalRoot,relative:actual.join('/'),path:child.path,parent,parentIdentity:identity(parentInfo),exists:child.info!==undefined,...child.info?{objectIdentity:identity(child.info)}:{}}
      parent=child.path;parentInfo=ordinary(child.info!,true)
    }
    return denied('A resource leaf is required.')
  })
}

/** Compare already canonical component spellings; never fold filename case. */
export function withinCanonical(root:string,path:string,platform:NodeJS.Platform=process.platform):boolean {
  try{
    const resolver=new Resolver({platform}),base=resolver.components(root),candidate=resolver.components(path)
    return base.base===candidate.base&&base.parts.length<=candidate.parts.length&&base.parts.every((part,index)=>candidate.parts[index]===part)
  }catch{return false}
}
