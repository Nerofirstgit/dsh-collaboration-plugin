/** Claim path mappings are coordinator evidence, not host-side spelling guesses. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,win32} from 'node:path'
import {resolveManagedPath} from '../src/writer-paths.ts'
import type {ResourcePathFileSystem} from '../src/platform/resource-paths.ts'
import {Store} from '../src/store.ts'
import {Writer} from '../src/writer.ts'
import {digest} from '../src/util.ts'
import type {RuntimeIdentity} from '../src/types.ts'

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'dsh-claim-mapping-')),root=join(dir,'workspace');mkdirSync(root);mkdirSync(join(root,'nested'))
 let time=100
 const store=new Store(join(dir,'private','store.sqlite'),{utc:()=>time,monotonic:()=>time})
 store.db.prepare('INSERT INTO workspaces(id,project_id,root) VALUES(?,?,?)').run('w','p',root)
 const token='mapping-token',identity:RuntimeIdentity={session_id:'a',incarnation_id:'inc-a',execution_epoch:1,runtime_token:token,coordinator_epoch:store.epoch,coordinator_domain:store.domain}
 store.db.prepare('INSERT INTO sessions(id,project_id,workspace_id,incarnation_id,execution_epoch,token_hash,title,task_summary,state,host_id,started_at,last_heartbeat_at,last_heartbeat_mono,owner_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('a','p','w','inc-a',1,digest(token),'A','','running','fixture',time,time,time,store.epoch)
 const writer=new Writer(store,{lease_ttl_ms:100})
 function claim(paths:string[],id='request'){return writer.claimFiles(identity,{paths,purpose:'mapping',request_id:id}) as ReturnType<Writer['claimFiles']>&{path_mappings?:{requested_path:string;path:string;lease_id:string}[]}}
 return{dir,root,store,writer,identity,claim,advance(ms:number){time+=ms},close(){store.close();rmSync(dir,{recursive:true,force:true})}}
}

test('raw inputs map to their own canonical lease keys rather than sorted claim positions',()=>{const f=fixture();try{const absolute=join(f.root,'zeta.txt'),result=f.claim([absolute,'alpha.txt']);assert.deepEqual(result.claims.map(c=>c.path),['alpha.txt','zeta.txt']);assert.deepEqual(result.path_mappings,[{requested_path:absolute,path:'zeta.txt',lease_id:result.claims.find(c=>c.path==='zeta.txt')!.lease_id},{requested_path:'alpha.txt',path:'alpha.txt',lease_id:result.claims.find(c=>c.path==='alpha.txt')!.lease_id}]);const saved=JSON.parse(String(f.store.db.prepare("SELECT result FROM writer_requests WHERE request_id='request'").get()!.result));assert.deepEqual(saved.path_mappings,result.path_mappings)}finally{f.close()}})

test('distinct requested aliases may map to one lease without losing either association',()=>{const f=fixture();try{const absolute=join(f.root,'one.txt');writeFileSync(absolute,'one');const result=f.claim(['one.txt',absolute,'one.txt']);assert.equal(result.claims.length,1);assert.deepEqual(result.path_mappings,[{requested_path:absolute,path:'one.txt',lease_id:result.claims[0]!.lease_id},{requested_path:'one.txt',path:'one.txt',lease_id:result.claims[0]!.lease_id}])}finally{f.close()}})

test('identical retry after parent removal returns persisted mappings without a new lease or event',()=>{const f=fixture();try{const absolute=join(f.root,'nested','alpha.txt'),paths=[absolute,'nested/beta.txt'],first=f.claim(paths);rmSync(join(f.root,'nested'),{recursive:true});const leases=f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases').get()!.n,events=f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='files.claimed'").get()!.n;const retry=f.claim([...paths].reverse());assert.deepEqual(retry.path_mappings,first.path_mappings);assert.equal(retry.claims[0]!.lease_id,first.claims[0]!.lease_id);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases').get()!.n,leases);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='files.claimed'").get()!.n,events)}finally{f.close()}})

test('new mapped request rejects a different raw spelling under the same idempotency ID',()=>{const f=fixture();try{const first=f.claim(['one.txt']),absolute=join(f.root,'one.txt');assert.throws(()=>f.claim([absolute]),{code:'IDEMPOTENCY_CONFLICT'});assert.deepEqual(f.claim(['one.txt','one.txt']).path_mappings,first.path_mappings);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases').get()!.n,1)}finally{f.close()}})

test('different logical paths under the same request ID still conflict without changing stored mappings',()=>{const f=fixture();try{const first=f.claim(['one.txt']);assert.throws(()=>f.claim(['two.txt']),{code:'IDEMPOTENCY_CONFLICT'});assert.deepEqual(f.claim(['one.txt']).path_mappings,first.path_mappings);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases').get()!.n,1)}finally{f.close()}})

test('legacy cached result without mappings stays unmapped instead of inferring input order',()=>{const f=fixture();try{const first=f.claim(['nested/alpha.txt','nested/beta.txt']),legacy={claims:first.claims};f.store.db.prepare("UPDATE writer_requests SET result=? WHERE request_id='request'").run(JSON.stringify(legacy));rmSync(join(f.root,'nested'),{recursive:true});const retry=f.claim(['nested/beta.txt','nested/alpha.txt']);assert.equal(Object.hasOwn(retry,'path_mappings'),false);assert.deepEqual(retry.claims.map(c=>c.lease_id),first.claims.map(c=>c.lease_id))}finally{f.close()}})

test('expired cached mappings retain their identity but cannot silently reacquire a lease',()=>{const f=fixture();try{const first=f.claim(['one.txt']);f.advance(101);const retry=f.claim(['one.txt']);assert.deepEqual(retry.path_mappings,first.path_mappings);assert.equal(retry.claims[0]!.active,false);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases').get()!.n,1)}finally{f.close()}})


test('legacy unmapped cache retains its earlier canonical-alias idempotency semantics',()=>{const f=fixture();try{const first=f.claim(['one.txt']);f.store.db.prepare("UPDATE writer_requests SET result=? WHERE request_id='request'").run(JSON.stringify({claims:first.claims}));const retry=f.claim([join(f.root,'one.txt')]);assert.equal(Object.hasOwn(retry,'path_mappings'),false);assert.equal(retry.claims[0]!.lease_id,first.claims[0]!.lease_id)}finally{f.close()}})

function windowsPathFixture(){
 const nodes=new Map<string,{ino:bigint;kind:'directory'|'file';children:string[]}>([
  ['C:\\',{ino:1n,kind:'directory',children:['Workspace']}],
  ['C:\\Workspace',{ino:2n,kind:'directory',children:['Folder','File.txt','.git']}],
  ['C:\\Workspace\\Folder',{ino:3n,kind:'directory',children:['LongFile.txt']}],
  ['C:\\Workspace\\File.txt',{ino:4n,kind:'file',children:[]}],
  ['C:\\Workspace\\Folder\\LongFile.txt',{ino:5n,kind:'file',children:[]}],
  ['C:\\Workspace\\.git',{ino:6n,kind:'directory',children:['config']}],
  ['C:\\Workspace\\.git\\config',{ino:7n,kind:'file',children:[]}],
 ])
 function locate(path:string){const mapped=win32.normalize(path).replace(/worksp~1/ig,'Workspace').replace(/longfi~1.txt/ig,'LongFile.txt').replace(/git~1/ig,'.git'),entry=[...nodes].find(([name])=>name.toUpperCase()===mapped.toUpperCase())?.[1];if(!entry)throw Object.assign(new Error('missing'),{code:'ENOENT'});return entry}
 const filesystem:ResourcePathFileSystem={realpath(path){locate(path);return win32.normalize(path)},lstat(path){const entry=locate(path);return{dev:77n,ino:entry.ino,kind:entry.kind}},readDirectory(path,maximum){const children=locate(path).children;return{entries:children.slice(0,maximum),complete:children.length<=maximum}}}
 return{platform:'win32' as const,filesystem,allowMissingLeaf:true}
}

test('combined writer grammar and resolver accepts an absolute existing root/leaf alias without lexical containment guesses',()=>{
 const resolve=resolveManagedPath
 const options=windowsPathFixture(),actual=resolve('C:\\Workspace','c:\\worksp~1\\folder\\LONGFI~1.TXT',options)
 assert.equal(actual.relative,'Folder/LongFile.txt');assert.equal(actual.path,'C:\\Workspace\\Folder\\LongFile.txt')
 const missing=resolve('C:\\Workspace','C:\\WORKSP~1\\Folder\\New.txt',options)
 assert.equal(missing.relative,'Folder/New.txt');assert.equal(missing.exists,false)
 for(const input of ['C:\\WORKSP~1\\..\\Workspace\\File.txt','C:\\WORKSP~1\\File.txt:stream','C:\\WORKSP~1\\CON','C:\\WORKSP~1\\.DSH-COLLAB-new','C:\\WORKSP~1\\GIT~1\\config','\\\\server\\share\\File.txt'])assert.throws(()=>resolve('C:\\Workspace',input,options),{code:'PATH_NOT_ALLOWED'})
})


test('persisted mapping itself proves an exact retry after obsolete input metadata is absent',()=>{const f=fixture();try{const first=f.claim(['nested/file.txt']);f.store.db.prepare('DELETE FROM writer_claim_inputs').run();rmSync(join(f.root,'nested'),{recursive:true});const restartedWriter=new Writer(f.store),retry=restartedWriter.claimFiles(f.identity,{paths:['nested/file.txt'],purpose:'mapping',request_id:'request'});assert.deepEqual(retry.path_mappings,first.path_mappings);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM writer_leases').get()!.n,1)}finally{f.close()}})

test('mapped cache still rejects changed purpose or TTL after parent removal',()=>{const f=fixture();try{const input={paths:['nested/file.txt'],purpose:'mapping',request_id:'request'},first=f.writer.claimFiles(f.identity,input);rmSync(join(f.root,'nested'),{recursive:true});assert.throws(()=>f.writer.claimFiles(f.identity,{...input,purpose:'changed'}),{code:'IDEMPOTENCY_CONFLICT'});assert.throws(()=>f.writer.claimFiles(f.identity,{...input,ttl_ms:50}),{code:'IDEMPOTENCY_CONFLICT'});assert.deepEqual(f.writer.claimFiles(f.identity,input).path_mappings,first.path_mappings)}finally{f.close()}})
