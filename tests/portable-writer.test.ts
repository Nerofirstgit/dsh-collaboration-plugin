/** Portable Node contracts, not native Windows execution or socket acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as writerModule from '../src/writer.ts'
import {Writer,type FileChange} from '../src/writer.ts'
import {renameNoReplace} from '../src/native-rename.ts'
import {Store} from '../src/store.ts'
import {digest} from '../src/util.ts'
import type {RuntimeIdentity} from '../src/types.ts'

function fixture(){
 const dir=fs.mkdtempSync(join(tmpdir(),'dsh-portable-writer-')),root=join(dir,'workspace');fs.mkdirSync(root);fs.mkdirSync(join(root,'nested'))
 const store=new Store(join(dir,'private','store.sqlite'));store.db.prepare('INSERT INTO workspaces(id,project_id,root) VALUES(?,?,?)').run('w','p',root)
 const token='portable-writer-token',identity:RuntimeIdentity={session_id:'a',incarnation_id:'inc-a',execution_epoch:1,coordinator_epoch:store.epoch,coordinator_domain:store.domain,runtime_token:token}
 store.db.prepare('INSERT INTO sessions(id,project_id,workspace_id,incarnation_id,execution_epoch,token_hash,title,task_summary,state,host_id,started_at,last_heartbeat_at,last_heartbeat_mono,owner_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('a','p','w','inc-a',1,digest(token),'A','','running','fixture',1,1,performance.now(),store.epoch)
 const writer=new Writer(store)
 function change(path:string,operation:FileChange['operation'],content?:string,target?:string){
  const receipt=operation==='create'?undefined:writer.readFile(identity,{path}),id='operation-'+operation
  const claims=writer.claimFiles(identity,{paths:target?[path,target]:[path],purpose:'portable ordinary file',request_id:id+':claim'}).claims,source=claims.find(c=>c.path===path)!,destination=target?claims.find(c=>c.path===target)!:undefined
  return writer.applyFileChange(identity,{path,operation,content,expected_version:receipt?.version??null,read_token:receipt?.read_token,lease_id:source.lease_id,coordinator_epoch:source.coordinator_epoch,fencing_token:source.fencing_token,mutation_id:id,...target?{target_path:target,expected_target_version:null,target_lease_id:destination!.lease_id,target_fencing_token:destination!.fencing_token}:{}})
 }
 return{dir,root,store,writer,identity,change,close(){store.close();fs.rmSync(dir,{recursive:true,force:true})}}
}

test('ordinary managed operations use Node paths without proc descriptors or Linux-only open flags',()=>{
 const f=fixture(),original=fs.openSync
 try{
  fs.openSync=((path:fs.PathLike,flags:fs.OpenMode,mode?:fs.Mode)=>{
   assert.equal(String(path).startsWith('/proc/'),false,'portable writer must not depend on /proc')
   if(typeof flags==='number')assert.equal(flags&((fs.constants.O_NOFOLLOW??0)|(fs.constants.O_DIRECTORY??0)|(fs.constants.O_NONBLOCK??0)),0,'portable writer uses common file-open flags')
   return original(path,flags,mode)
  }) as typeof fs.openSync
  syncBuiltinESMExports()
  f.change('nested/file.txt','create','initial\r\n')
  f.change('nested/file.txt','replace','changed\r\n')
  f.change('nested/file.txt','rename',undefined,'moved.txt')
  assert.equal(fs.readFileSync(join(f.root,'moved.txt'),'utf8'),'changed\r\n')
  f.change('moved.txt','delete')
  assert.equal(fs.existsSync(join(f.root,'moved.txt')),false)
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM file_mutations WHERE state='committed'").get()!.n,4)
 }finally{fs.openSync=original;syncBuiltinESMExports();f.close()}
})

test('portable no-replace rename accepts parent paths and retains an existing destination',()=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'dsh-portable-rename-'))
 try{
  fs.writeFileSync(join(dir,'from'),'original')
  ;(renameNoReplace as unknown as (fromDir:string,from:string,toDir:string,to:string)=>void)(dir,'from',dir,'to')
  assert.equal(fs.readFileSync(join(dir,'to'),'utf8'),'original')
  fs.writeFileSync(join(dir,'from'),'later')
  assert.throws(()=>(renameNoReplace as unknown as (a:string,b:string,c:string,d:string)=>void)(dir,'from',dir,'to'),{code:'EEXIST'})
  assert.equal(fs.readFileSync(join(dir,'from'),'utf8'),'later')
  assert.equal(fs.readFileSync(join(dir,'to'),'utf8'),'original')
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})

test('writer capability declaration never promises Windows directory flush or power-loss certification',()=>{
 const describe=Reflect.get(writerModule,'writerCapabilities') as ((platform:NodeJS.Platform)=>Record<string,unknown>)|undefined
 assert.equal(typeof describe,'function')
 const windows=describe!('win32')
 assert.equal(windows.scope,'participating-dsh-sessions')
 assert.equal(windows.file_flush,'node-fsync')
 assert.equal(windows.directory_flush,'unavailable-via-node-windows')
 assert.equal(windows.failure_model,'process-crash-recovery')
 assert.equal(windows.power_loss,'not-certified')
 assert.equal(windows.native_windows_acceptance,'pending')
})

test('portable path grammar preserves Windows separators without admitting drive-relative or reserved names',()=>{
 const normalize=Reflect.get(writerModule,'normalizeManagedPath') as ((root:string,path:string,platform:NodeJS.Platform)=>string)|undefined
 assert.equal(typeof normalize,'function')
 assert.equal(normalize!('C:\\project','src\\Example.txt','win32'),'src/Example.txt')
 assert.equal(normalize!('C:\\project','C:\\project\\src\\Example.txt','win32'),'src/Example.txt')
 for(const path of ['C:relative.txt','D:\\other.txt','../escape.txt','src/../escape.txt','file.txt:stream','NUL.txt','foo.','foo ','\\\\server\\share\\file.txt','.GIT/config'])assert.throws(()=>normalize!('C:\\project',path,'win32'),{code:'PATH_NOT_ALLOWED'})
 assert.equal(normalize!('/project','src/大小写.txt','linux'),'src/大小写.txt')
})

test('Windows managed writes reject legacy unmarked workspace identities',()=>{
 const f=fixture(),platform=Object.getOwnPropertyDescriptor(process,'platform')!
 try{
  Object.defineProperty(process,'platform',{...platform,value:'win32'})
  assert.throws(()=>f.writer.claimFiles(f.identity,{paths:['new.txt'],purpose:'case guard',request_id:'blocked-win'}),{code:'STORAGE_ERROR'})
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases').get()!.n,0)
 }finally{Object.defineProperty(process,'platform',platform);f.close()}
})

test('a reported rename error after a file action remains unknown instead of recording an abort',()=>{
 const f=fixture(),original=fs.renameSync
 try{
  fs.writeFileSync(join(f.root,'source.txt'),'before')
  fs.renameSync=((from:fs.PathLike,to:fs.PathLike)=>{original(from,to);throw Object.assign(new Error('simulated post-action access failure'),{code:'EACCES'})}) as typeof fs.renameSync
  syncBuiltinESMExports()
  assert.throws(()=>f.change('source.txt','rename',undefined,'destination.txt'),{code:'OUTCOME_UNKNOWN'})
  assert.equal(f.writer.mutationStatus(f.identity,{mutation_id:'operation-rename'}).state,'needs_recovery')
  assert.equal(fs.existsSync(join(f.root,'source.txt')),false)
  assert.equal(fs.readFileSync(join(f.root,'destination.txt'),'utf8'),'before')
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='file.aborted'").get()!.n,0)
 }finally{fs.renameSync=original;syncBuiltinESMExports();f.close()}
})

test('Windows identity-scheme gate also covers recovery and artifact cleanup',()=>{
 const f=fixture(),platform=Object.getOwnPropertyDescriptor(process,'platform')!
 try{
  Object.defineProperty(process,'platform',{...platform,value:'win32'})
  assert.doesNotThrow(()=>f.writer.recoverAll(),'a fresh discovery-only coordinator has no workspace recovery action')
  Object.defineProperty(process,'platform',platform)
  f.change('created.txt','create','preserve')
  Object.defineProperty(process,'platform',{...platform,value:'win32'})
  assert.throws(()=>f.writer.recoverAll(),{code:'STORAGE_ERROR'})
  assert.throws(()=>f.writer.reconcile(f.identity,{mutation_id:'operation-create'}),{code:'STORAGE_ERROR'})
  assert.equal(f.writer.mutationStatus(f.identity,{mutation_id:'operation-create'}).state,'committed','query-only outcome remains available')
 }finally{Object.defineProperty(process,'platform',platform);f.close()}
})

test('Windows source-file durability flush requests write access without changing snapshot reads',()=>{
 const flags=Reflect.get(writerModule,'renameSourceFlushFlags') as ((platform:NodeJS.Platform)=>number)|undefined
 assert.equal(typeof flags,'function')
 assert.equal(flags!('win32'),fs.constants.O_RDWR)
 assert.equal(flags!('linux'),fs.constants.O_RDONLY)
})


test('canonical-components identity marker admits the Windows candidate without claiming native execution',()=>{
 const f=fixture(),assertScheme=Reflect.get(writerModule,'requireWriterIdentityScheme') as ((store:Store,platform:NodeJS.Platform)=>void)|undefined
 try{
  assert.equal(typeof assertScheme,'function')
  assert.throws(()=>assertScheme!(f.store,'win32'),{code:'STORAGE_ERROR'})
  f.store.db.prepare("INSERT INTO metadata(key,value) VALUES('windows_identity_scheme','canonical-components-v1')").run()
  assert.doesNotThrow(()=>assertScheme!(f.store,'win32'))
  const capability=writerModule.writerCapabilities('win32')
  assert.equal(capability.windows_mutations,'implementation-candidate')
  assert.equal(capability.native_windows_acceptance,'pending')
  f.store.db.prepare("UPDATE metadata SET value='unknown-v2' WHERE key='windows_identity_scheme'").run()
  assert.throws(()=>assertScheme!(f.store,'win32'),{code:'STORAGE_ERROR'})
 }finally{f.close()}
})
