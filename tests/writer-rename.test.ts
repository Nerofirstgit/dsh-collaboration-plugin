/** Ordinary same-filesystem rename: no sockets, helper process or shell fallback. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,statSync,rmSync,renameSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Store} from '../src/store.ts'
import {Writer,type FileChange} from '../src/writer.ts'
import {digest} from '../src/util.ts'
import type {RuntimeIdentity} from '../src/types.ts'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'dsh-rename-')),root=join(dir,'workspace');mkdirSync(root);mkdirSync(join(root,'destination'))
 const store=new Store(join(dir,'private','db.sqlite'));store.db.prepare('INSERT INTO workspaces(id,project_id,root) VALUES(?,?,?)').run('w','p',root)
 const identity=(id:string):RuntimeIdentity=>{const token='fixture-'+id;store.db.prepare(`INSERT INTO sessions(id,project_id,workspace_id,incarnation_id,execution_epoch,token_hash,title,task_summary,state,host_id,started_at,last_heartbeat_at,last_heartbeat_mono,owner_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,'p','w','inc-'+id,1,digest(token),id,'','running','fixture',1,1,performance.now(),store.epoch);return{session_id:id,incarnation_id:'inc-'+id,execution_epoch:1,coordinator_epoch:store.epoch,coordinator_domain:store.domain,runtime_token:token}}
 const a=identity('a'),b=identity('b'),writer=new Writer(store);writeFileSync(join(root,'source.txt'),'original\r\n')
 const prepare=(id='rename-one')=>{const read=writer.readFile(a,{path:'source.txt'}),claims=writer.claimFiles(a,{paths:['source.txt','destination/target.txt'],purpose:'ordinary rename',request_id:id+':claims'}).claims;return{path:'source.txt',operation:'rename',expected_version:read.version,read_token:read.read_token,lease_id:claims.find(c=>c.path==='source.txt')!.lease_id,coordinator_epoch:store.epoch,fencing_token:claims.find(c=>c.path==='source.txt')!.fencing_token,mutation_id:id,target_path:'destination/target.txt',expected_target_version:null,target_lease_id:claims.find(c=>c.path==='destination/target.txt')!.lease_id,target_fencing_token:claims.find(c=>c.path==='destination/target.txt')!.fencing_token}as FileChange}
 return{dir,root,store,writer,a,b,prepare,close(){store.close();rmSync(dir,{recursive:true,force:true})}}
}
test('F06 normal same-filesystem rename preserves inode and bytes, returns one terminal result',()=>{const f=fixture();try{const request=f.prepare(),inode=statSync(join(f.root,'source.txt')).ino,result=f.writer.applyFileChange(f.a,request);assert.equal(existsSync(join(f.root,'source.txt')),false);assert.equal(statSync(join(f.root,'destination/target.txt')).ino,inode);assert.equal(readFileSync(join(f.root,'destination/target.txt'),'utf8'),'original\r\n');assert.equal(result.destination_path,'destination/target.txt');assert.equal(result.new_version,null);assert.equal(result.destination_version,request.expected_version);assert.deepEqual(f.writer.applyFileChange(f.a,request),result);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='file.changed'").get()!.n,1)}finally{f.close()}})
test('F22 an existing rename destination is never silently overwritten',()=>{const f=fixture();try{const request=f.prepare();writeFileSync(join(f.root,'destination/target.txt'),'peer data');assert.throws(()=>f.writer.applyFileChange(f.a,request),{code:'VERSION_CONFLICT'});assert.equal(readFileSync(join(f.root,'source.txt'),'utf8'),'original\r\n');assert.equal(readFileSync(join(f.root,'destination/target.txt'),'utf8'),'peer data')}finally{f.close()}})
test('F22 target created at publication boundary remains intact under kernel no-replace',()=>{const f=fixture();try{const request=f.prepare();f.writer.fault=point=>{if(point==='before_publish')writeFileSync(join(f.root,'destination/target.txt'),'late peer data')};assert.throws(()=>f.writer.applyFileChange(f.a,request),{code:'VERSION_CONFLICT'});assert.equal(readFileSync(join(f.root,'source.txt'),'utf8'),'original\r\n');assert.equal(readFileSync(join(f.root,'destination/target.txt'),'utf8'),'late peer data');assert.equal(f.writer.mutationStatus(f.a,{mutation_id:request.mutation_id}).state,'aborted')}finally{f.close()}})
test('F01 rename requires both current leases and freezes both path entries while in flight',()=>{const f=fixture();try{const request=f.prepare();f.writer.fault=point=>{if(point==='after_prepared'){for(const path of ['source.txt','destination/target.txt']){assert.throws(()=>f.writer.readFile(f.a,{path}),{code:'RESOURCE_RECOVERING'});assert.throws(()=>f.writer.claimFiles(f.b,{paths:[path],purpose:'conflict',request_id:'claim-'+path}),{code:'RESOURCE_RECOVERING'})}assert.equal(f.writer.claimFiles(f.b,{paths:['independent.txt'],purpose:'independent',request_id:'unrelated'}).claims.length,1)}};f.writer.applyFileChange(f.a,request)}finally{f.close()}})
for(const field of ['target_path','target_lease_id','target_fencing_token','expected_target_version'])test(`F22 rename missing ${field} refuses before intent`,()=>{const f=fixture();try{const request=f.prepare()as unknown as Record<string,unknown>;delete request[field];assert.throws(()=>f.writer.applyFileChange(f.a,request as unknown as FileChange),{code:'INVALID_ARGUMENT'});assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM file_mutations').get()!.n,0);assert.equal(existsSync(join(f.root,'source.txt')),true)}finally{f.close()}})
test('F22 explicit target overwrite is refused rather than weak check-then-replace',()=>{const f=fixture();try{const request={...f.prepare(),expected_target_version:'sha256:'+digest('peer')};assert.throws(()=>f.writer.applyFileChange(f.a,request),{code:'UNSUPPORTED_ATOMIC_OPERATION'});assert.equal(existsSync(join(f.root,'source.txt')),true)}finally{f.close()}})
test('F04 stale destination fencing token cannot rename a currently valid source',()=>{const f=fixture();try{const request={...f.prepare(),target_fencing_token:999};assert.throws(()=>f.writer.applyFileChange(f.a,request),{code:'STALE_FENCING_TOKEN'});assert.equal(existsSync(join(f.root,'source.txt')),true)}finally{f.close()}})
for(const path of ['source.txt','destination/target.txt'])test(`F22 ordinary rename refuses a directory at ${path}`,()=>{const f=fixture();try{const request=f.prepare();if(path==='source.txt')rmSync(join(f.root,path));mkdirSync(join(f.root,path));assert.throws(()=>f.writer.applyFileChange(f.a,request),{code:'PATH_NOT_ALLOWED'});assert.equal(statSync(join(f.root,path)).isDirectory(),true);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM file_mutations').get()!.n,0)}finally{f.close()}})
test('L07 rename original terminal result survives release and later destination edits',()=>{const f=fixture();try{const request=f.prepare(),result=f.writer.applyFileChange(f.a,request);f.writer.releaseSession(f.a);writeFileSync(join(f.root,'destination/target.txt'),'later');assert.deepEqual(f.writer.applyFileChange(f.a,request),result);assert.equal(readFileSync(join(f.root,'destination/target.txt'),'utf8'),'later');assert.throws(()=>f.writer.applyFileChange(f.a,{...request,target_path:'other.txt'}),{code:'IDEMPOTENCY_CONFLICT'})}finally{f.close()}})
test('L08 an external move-shaped state before publication is not attributed to our rename',()=>{const f=fixture();try{const request=f.prepare();f.writer.fault=point=>{if(point==='after_prepared'){renameSync(join(f.root,'source.txt'),join(f.root,'destination/target.txt'));throw new Error('ordinary external movement fixture')}};assert.throws(()=>f.writer.applyFileChange(f.a,request));f.writer.fault=undefined;f.writer.recoverAll();assert.notEqual(f.writer.mutationStatus(f.a,{mutation_id:request.mutation_id}).state,'committed');assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='file.changed'").get()!.n,0)}finally{f.close()}})

const worker=fileURLToPath(new URL('./writer-rename-worker.ts',import.meta.url))
const committedPoints=['after_publish_evidence','after_directory_flush','before_commit','after_durable_commit_before_cleanup','after_commit']
for(const point of ['after_prepared','before_publish','after_publish',...committedPoints])test(`L05 L08 SIGKILL ordinary rename at ${point} preserves provable outcome without replay`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-rename-crash-'));let store:Store|undefined
 try{
  const child=spawnSync(process.execPath,['--experimental-strip-types',worker,dir,point],{encoding:'utf8',timeout:10000});assert.equal(child.signal,'SIGKILL',child.stderr)
  store=new Store(join(dir,'private','store.sqlite'));const writer=new Writer(store)
  writer.recoverAll();writer.recoverAll()
  const row=store.db.prepare("SELECT state,original_result FROM file_mutations WHERE mutation_id='rename-crash'").get()!,moved=point==='after_publish'||committedPoints.includes(point)
  assert.equal(row.state,point==='after_publish'?'needs_recovery':moved?'committed':'aborted')
  const source=join(dir,'workspace/source.txt'),destination=join(dir,'workspace/destination/target.txt')
  assert.equal(existsSync(source),!moved);assert.equal(existsSync(destination),moved)
  assert.equal(readFileSync(moved?destination:source,'utf8'),'old\r\n');assert.equal(statSync(moved?destination:source).nlink,1)
  const guards=store.db.prepare('SELECT resource_key,recovery_state FROM resource_guards ORDER BY resource_key').all()
  assert.equal(guards.length,2);for(const guard of guards)assert.equal(guard.recovery_state,point==='after_publish'?'needs_recovery':'ready')
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM events WHERE type IN ('file.changed','file.aborted')").get()!.n,point==='after_publish'?0:1)
  if(row.state==='committed'){const result=JSON.parse(String(row.original_result));assert.equal(result.destination_path,'destination/target.txt');assert.equal(result.new_version,null);assert.equal(result.destination_version,'sha256:'+digest('old\r\n'))}
 }finally{store?.close();rmSync(dir,{recursive:true,force:true})}
})
test('L05 rename recovery can lose its own process twice and still publish one terminal event',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-rename-recovery-'));let store:Store|undefined
 try{
  const first=spawnSync(process.execPath,['--experimental-strip-types',worker,dir,'after_publish_evidence'],{encoding:'utf8',timeout:10000});assert.equal(first.signal,'SIGKILL',first.stderr)
  for(let i=0;i<2;i++){const child=spawnSync(process.execPath,['--experimental-strip-types',worker,dir,'before_commit','recover'],{encoding:'utf8',timeout:10000});assert.equal(child.signal,'SIGKILL',child.stderr)}
  store=new Store(join(dir,'private','store.sqlite'));new Writer(store).recoverAll()
  assert.equal(store.db.prepare("SELECT state FROM file_mutations WHERE mutation_id='rename-crash'").get()!.state,'committed')
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='file.changed'").get()!.n,1)
 }finally{store?.close();rmSync(dir,{recursive:true,force:true})}
})
test('L08 post-publication external edit freezes both rename names rather than fabricating success',()=>{
 const f=fixture();try{
  const request=f.prepare();f.writer.fault=point=>{if(point==='after_publish_evidence'){writeFileSync(join(f.root,'destination/target.txt'),'later external edit');throw new Error('process-loss equivalent boundary')}}
  assert.throws(()=>f.writer.applyFileChange(f.a,request),{code:'OUTCOME_UNKNOWN'});f.writer.fault=undefined;f.writer.recoverAll()
  const status=f.writer.mutationStatus(f.a,{mutation_id:request.mutation_id});assert.equal(status.state,'needs_recovery');assert.deepEqual(status.affected_paths,['source.txt','destination/target.txt']);assert.ok(status.recovery_reason)
  for(const path of status.affected_paths!)assert.throws(()=>f.writer.readFile(f.a,{path}),{code:'RESOURCE_RECOVERING'})
  assert.equal(f.writer.claimFiles(f.b,{paths:['independent.txt'],purpose:'continue elsewhere',request_id:'elsewhere'}).claims.length,1)
  assert.equal(readFileSync(join(f.root,'destination/target.txt'),'utf8'),'later external edit')
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='file.changed'").get()!.n,0)
 }finally{f.close()}
})
