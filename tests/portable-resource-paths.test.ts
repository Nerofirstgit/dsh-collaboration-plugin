/** Resolver fixtures are not Windows-native filesystem validation. No transport is used. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,renameSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,win32} from 'node:path'
import * as paths from '../src/platform/resource-paths.ts'
import type {ResourcePathFileSystem,ResourcePathStat} from '../src/platform/resource-paths.ts'

function fixture(){
 type Entry={name:string;kind:'directory'|'file';ino:bigint;caseSensitive?:boolean;children?:Entry[];shortName?:string}
 const root:Entry={name:'C:\\',kind:'directory',ino:1n,children:[],caseSensitive:false};let serial=10n
 const entries=(parent:Entry)=>parent.children??[]
 function locate(path:string):Entry{
  const components=win32.normalize(path).slice(3).split('\\').filter(Boolean);let entry=root
  for(const component of components){
   const next=entries(entry).find(candidate=>candidate.name===component)
     ??entries(entry).find(candidate=>!entry.caseSensitive&&(candidate.name.toUpperCase()===component.toUpperCase()||candidate.shortName?.toUpperCase()===component.toUpperCase()))
   if(!next)throw Object.assign(new Error('missing'),{code:'ENOENT'});entry=next
  }
  return entry
 }
 function add(parent:string,name:string,kind:'directory'|'file',extra:Partial<Entry>={}):Entry{
  const entry={name,kind,ino:serial++,...kind==='directory'?{children:[]}: {},...extra};locate(parent).children!.push(entry);return entry
 }
 const filesystem:ResourcePathFileSystem={
  realpath(path){locate(path);return win32.normalize(path)},
  lstat(path){const entry=locate(path);return{dev:77n,ino:entry.ino,kind:entry.kind}},
  readDirectory(path,maximum){const children=entries(locate(path));return{entries:children.slice(0,maximum).map(entry=>entry.name),complete:children.length<=maximum}},
 }
 return{filesystem,add,locate,root}
}

test('ordinary Node existing path keeps realpath spelling and stable path across replacement',()=>{
 const root=mkdtempSync(join(tmpdir(),'dsh-resource-path-'))
 try{
  mkdirSync(join(root,'Folder'));writeFileSync(join(root,'Folder','File.txt'),'one')
  const before=paths.resolveResourcePath(root,'Folder/File.txt')
  assert.equal(before.root,realpathSync(root));assert.equal(before.relative,'Folder/File.txt');assert.equal(before.path,join(realpathSync(root),'Folder','File.txt'));assert.equal(before.exists,true)
  writeFileSync(join(root,'Folder','next.txt'),'two');renameSync(join(root,'Folder','next.txt'),join(root,'Folder','File.txt'))
  const after=paths.resolveResourcePath(root,'Folder/File.txt');assert.equal(after.path,before.path);assert.notDeepEqual(after.objectIdentity,before.objectIdentity)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('ordinary Node missing leaf requires explicit permission and an existing canonical parent',()=>{
 const root=mkdtempSync(join(tmpdir(),'dsh-resource-missing-'))
 try{
  assert.throws(()=>paths.resolveResourcePath(root,'New.txt'),{code:'PATH_NOT_ALLOWED'})
  const absent=paths.resolveResourcePath(root,'New.txt',{allowMissingLeaf:true});assert.equal(absent.exists,false);assert.equal(absent.path,join(realpathSync(root),'New.txt'));assert.equal(absent.objectIdentity,undefined)
  assert.throws(()=>paths.resolveResourcePath(root,'missing/New.txt',{allowMissingLeaf:true}),{code:'PATH_NOT_ALLOWED'})
  assert.throws(()=>paths.resolveResourcePath(root,'../outside',{allowMissingLeaf:true}),{code:'PATH_NOT_ALLOWED'})
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('Windows fixture resolves case and existing 8.3 aliases by actual entry identities',()=>{
 const f=fixture();f.add('C:\\','Workspace','directory',{shortName:'WORKSP~1'});f.add('C:\\Workspace','Folder','directory');f.add('C:\\Workspace\\Folder','LongFile.txt','file',{shortName:'LONGFI~1.TXT',ino:9007199254740999n})
 const options={platform:'win32' as const,filesystem:f.filesystem}
 assert.equal(paths.canonicalExistingDirectory('c:\\worksp~1',options),'C:\\Workspace')
 const direct=paths.resolveResourcePath('C:\\Workspace','Folder/LongFile.txt',options),alias=paths.resolveResourcePath('c:\\worksp~1','folder/longfi~1.txt',options)
 assert.deepEqual(alias,direct);assert.equal(alias.objectIdentity?.ino,'9007199254740999');assert.equal(alias.relative,'Folder/LongFile.txt')
})

test('Windows fixture preserves distinct case-sensitive siblings and rejects lexical-only containment',()=>{
 const f=fixture();f.add('C:\\','Workspace','directory',{caseSensitive:true});f.add('C:\\Workspace','Foo','directory');f.add('C:\\Workspace','foo','directory');f.add('C:\\Workspace\\Foo','a.txt','file');f.add('C:\\Workspace\\foo','a.txt','file')
 const options={platform:'win32' as const,filesystem:f.filesystem}
 assert.notDeepEqual(paths.resolveResourcePath('C:\\Workspace','Foo/a.txt',options).objectIdentity,paths.resolveResourcePath('C:\\Workspace','foo/a.txt',options).objectIdentity)
 assert.throws(()=>paths.resolveResourcePath('C:\\Workspace\\Foo','C:\\Workspace\\foo\\a.txt',options),{code:'PATH_NOT_ALLOWED'})
 assert.throws(()=>paths.canonicalExistingDirectory('C:\\Workspace\\FOO',options),{code:'PATH_NOT_ALLOWED'})
})

test('Windows missing leaf keeps requested spelling without guessing future short aliases or case folding',()=>{
 const f=fixture();f.add('C:\\','Workspace','directory');const options={platform:'win32' as const,filesystem:f.filesystem,allowMissingLeaf:true}
 const lower=paths.resolveResourcePath('c:\\workspace','new.txt',options),upper=paths.resolveResourcePath('C:\\Workspace','NEW.TXT',options)
 assert.equal(lower.parent,upper.parent);assert.deepEqual(lower.parentIdentity,upper.parentIdentity);assert.notEqual(lower.path,upper.path);assert.equal(lower.exists,false)
})

test('Windows identity fallback refuses ambiguous matches, zero IDs and incomplete enumeration',()=>{
 const f=fixture();f.add('C:\\','Workspace','directory');f.add('C:\\Workspace','Long.txt','file',{shortName:'LONG~1.TXT',ino:80n});f.add('C:\\Workspace','Other.txt','file',{ino:80n})
 const options={platform:'win32' as const,filesystem:f.filesystem}
 assert.throws(()=>paths.resolveResourcePath('C:\\Workspace','LONG~1.TXT',options),{code:'PATH_NOT_ALLOWED'})
 f.locate('C:\\Workspace\\Long.txt').ino=0n
 assert.throws(()=>paths.resolveResourcePath('C:\\Workspace','Long.txt',options),{code:'PATH_NOT_ALLOWED'})
 assert.throws(()=>paths.resolveResourcePath('C:\\Workspace','Other.txt',{...options,maxDirectoryEntries:1}),{code:'PATH_NOT_ALLOWED'})
})

test('Windows exact spelling still rejects unsupported type and nonlocal/device roots',()=>{
 const f=fixture();f.add('C:\\','Workspace','directory');f.add('C:\\Workspace','entry','file')
 const filesystem={...f.filesystem,lstat(path:string):ResourcePathStat{return path.endsWith('entry')?{dev:77n,ino:20n,kind:'symlink'}:f.filesystem.lstat(path)}}
 const options={platform:'win32' as const,filesystem}
 assert.throws(()=>paths.resolveResourcePath('C:\\Workspace','entry',options),{code:'PATH_NOT_ALLOWED'})
 for(const path of ['\\\\server\\share','\\\\?\\C:\\Workspace','C:Workspace'])assert.throws(()=>paths.canonicalExistingDirectory(path,options),{code:'PATH_NOT_ALLOWED'})
})

test('pure canonical containment is component-exact apart from Windows drive letter spelling',()=>{
 assert.equal(paths.withinCanonical('C:\\Workspace\\Foo','c:\\Workspace\\Foo\\a.txt','win32'),true)
 assert.equal(paths.withinCanonical('C:\\Workspace\\Foo','C:\\Workspace\\foo\\a.txt','win32'),false)
 assert.equal(paths.withinCanonical('C:\\Workspace','C:\\Workspace-extra\\a.txt','win32'),false)
 assert.equal(paths.withinCanonical('/work/root','/work/root/file','linux'),true)
 assert.equal(paths.withinCanonical('/work/root','/work/root-extra','linux'),false)
 assert.equal(paths.withinCanonical('C:\\Workspace','D:\\Workspace\\file','win32'),false)
})

test('Windows missing leaf refuses incomplete or oversized parent enumeration',()=>{
 const f=fixture();f.add('C:\\','Workspace','directory');f.add('C:\\Workspace','one','file');f.add('C:\\Workspace','two','file')
 const options={platform:'win32' as const,filesystem:f.filesystem,allowMissingLeaf:true,maxDirectoryEntries:1}
 assert.throws(()=>paths.resolveResourcePath('C:\\Workspace','absent',options),{code:'PATH_NOT_ALLOWED'})
 const incomplete={...f.filesystem,readDirectory(path:string,limit:number){const listing=f.filesystem.readDirectory(path,limit);return path==='C:\\Workspace'?{...listing,complete:false}:listing}}
 assert.throws(()=>paths.resolveResourcePath('C:\\Workspace','absent',{...options,maxDirectoryEntries:100,filesystem:incomplete}),{code:'PATH_NOT_ALLOWED'})
})

test('managed child links are rejected without realpath, while a selected root alias is resolved',()=>{
 const f=fixture();f.add('C:\\','Workspace','directory');f.add('C:\\Workspace','target','directory');f.add('C:\\Workspace\\target','file.txt','file');f.add('C:\\Workspace','link','directory')
 const calls:string[]=[]
 const filesystem={...f.filesystem,
  realpath(path:string){calls.push(path);if(path==='C:\\Alias')return'C:\\Workspace';if(path==='C:\\Workspace\\link')return'C:\\Workspace\\target';return f.filesystem.realpath(path)},
  lstat(path:string):ResourcePathStat{return path==='C:\\Workspace\\link'?{dev:77n,ino:90n,kind:'symlink'}:f.filesystem.lstat(path)},
 }
 const options={platform:'win32' as const,filesystem}
 assert.equal(paths.canonicalExistingDirectory('C:\\Alias',options),'C:\\Workspace')
 assert.equal(paths.resolveResourcePath('C:\\Alias','target/file.txt',options).path,'C:\\Workspace\\target\\file.txt')
 calls.length=0
 assert.throws(()=>paths.resolveResourcePath('C:\\Workspace','link/file.txt',options),{code:'PATH_NOT_ALLOWED'})
 assert.equal(calls.includes('C:\\Workspace\\link'),false)
 calls.length=0
 assert.throws(()=>paths.resolveResourcePath('C:\\Workspace','C:\\Workspace\\link\\file.txt',options),{code:'PATH_NOT_ALLOWED'})
 assert.equal(calls.includes('C:\\Workspace\\link'),false)
})

test('resource resolver imports with native Node TypeScript stripping used by crash workers',async()=>{
 const {spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url')
 const modulePath=fileURLToPath(new URL('../src/platform/resource-paths.ts',import.meta.url))
 const result=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`await import(${JSON.stringify(modulePath)});`],{encoding:'utf8',timeout:10000})
 assert.equal(result.status,0,result.stderr)
})
