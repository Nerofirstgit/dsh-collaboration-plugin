/** Global GUI state reservations: real SQLite and temp directories, no sockets or model endpoint. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Coordinator} from '../src/coordinator.ts'
import {Identities,ensureWorkspaceIdentityScheme} from '../src/identity.ts'
import {canonicalExistingDirectory} from '../src/platform/resource-paths.ts'
import {Store} from '../src/store.ts'
import {resolveConfig} from '../src/config.ts'

const table='host_state_reservations'
function fixture(){
 const dir=canonicalExistingDirectory(mkdtempSync(join(tmpdir(),'dsh-host-state-'))),home=join(dir,'account','harness-home'),project=join(dir,'project'),otherHome=join(dir,'other-home')
 for(const path of [home,project,otherHome,join(home,'profiles')])mkdirSync(path,{recursive:true})
 const config=resolveConfig({data_dir:join(dir,'coordinator-private')})
 let coordinator:Coordinator|undefined=new Coordinator(config)
 return{dir,home,project,otherHome,config,get c(){assert.ok(coordinator);return coordinator},reopen(){coordinator?.close();coordinator=undefined;coordinator=new Coordinator(config);return coordinator},close(){coordinator?.close();rmSync(dir,{recursive:true,force:true})}}
}
function reserve(f:ReturnType<typeof fixture>,roots:string[]){return f.c.dispatch('trusted-gui-profile','reserve_host_state_roots',{roots})}
function snapshot(f:ReturnType<typeof fixture>){return JSON.parse(String(f.c.store.db.prepare(`SELECT snapshot FROM ${table} WHERE singleton=1`).get()!.snapshot)) as {schema:string;roots:string[]}}
function putSnapshot(f:ReturnType<typeof fixture>,raw:string){
 f.c.store.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(singleton INTEGER PRIMARY KEY,snapshot TEXT NOT NULL)`)
 f.c.store.db.prepare(`INSERT OR REPLACE INTO ${table} VALUES(1,?)`).run(raw)
}

test('reserve before registration globally rejects equal, descendant and ancestor workspaces',async()=>{const f=fixture();try{
 assert.deepEqual(await reserve(f,[f.home]),{roots:[f.home]})
 for(const [index,root]of [f.home,join(f.home,'profiles'),join(f.dir,'account')].entries())assert.throws(()=>new Identities(f.c.store,f.config).register({session_id:'denied-'+index,cwd:root}),{code:'PATH_NOT_ALLOWED'})
 assert.equal(f.c.store.db.prepare('SELECT COUNT(*) n FROM workspaces').get()!.n,0)
 assert.equal(f.c.store.db.prepare('SELECT COUNT(*) n FROM sessions').get()!.n,0)
}finally{f.close()}})

test('all stored workspaces including closed sessions block overlapping reservation with no partial commit',async()=>{const f=fixture();try{
 await reserve(f,[f.home]);const identity=f.c.identities.register({session_id:'old-project',cwd:f.project});f.c.identities.close(identity)
 await assert.rejects(reserve(f,[f.otherHome,f.project]),{code:'WORKSPACE_OVERLAP'})
 assert.deepEqual(snapshot(f).roots,[f.home])
 f.c.identities.register({session_id:'unreserved-other-home',cwd:f.otherHome})
}finally{f.close()}})

for(const direction of ['parent','child'] as const)test(`a ${direction} of an existing workspace is not an independent state reservation`,async()=>{const f=fixture();try{
 const child=join(f.project,'child');mkdirSync(child)
 f.c.identities.register({session_id:'old',cwd:direction==='parent'?child:f.project})
 await assert.rejects(reserve(f,[direction==='parent'?f.project:child]),{code:'WORKSPACE_OVERLAP'})
 assert.deepEqual(snapshot(f).roots,[])
}finally{f.close()}})

test('reservation reply loss and coordinator reopen preserve the same canonical result and global exclusion',async()=>{const f=fixture();try{
 const transaction=f.c.store.transaction.bind(f.c.store);let loseResponse=true
 f.c.store.transaction=<T>(run:()=>T):T=>{const result=transaction(run);if(loseResponse){loseResponse=false;throw Object.assign(new Error('fixture response lost after durable commit'),{code:'OUTCOME_UNKNOWN'})}return result}
 await assert.rejects(reserve(f,[f.home,f.home]),{code:'OUTCOME_UNKNOWN'})
 assert.deepEqual(snapshot(f).roots,[f.home]);const first={roots:[f.home]};f.reopen()
 assert.deepEqual(await reserve(f,[f.home]),first)
 await reserve(f,[f.otherHome]);assert.deepEqual(await reserve(f,[f.home]),first)
 assert.deepEqual(snapshot(f).roots,[f.home,f.otherHome].sort())
 assert.throws(()=>f.c.identities.register({session_id:'later-profile',cwd:f.home}),{code:'PATH_NOT_ALLOWED'})
 assert.equal(f.c.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n,1)
}finally{f.close()}})

test('trusted existing directory aliases resolve to one durable root without changing project admission',async()=>{const f=fixture();try{
 const alias=join(f.dir,'home-alias');symlinkSync(f.home,alias,process.platform==='win32'?'junction':'dir')
 assert.deepEqual(await reserve(f,[alias,f.home]),{roots:[f.home]})
 assert.deepEqual(snapshot(f).roots,[f.home])
 assert.throws(()=>f.c.identities.register({session_id:'alias-workspace',cwd:alias}),{code:'PATH_NOT_ALLOWED'})
 const a=f.c.identities.register({session_id:'ordinary-a',cwd:f.project}),b=new Identities(f.c.store,f.config).register({session_id:'ordinary-b',cwd:f.project})
 assert.equal(f.c.store.session(a.session_id).workspace_id,f.c.store.session(b.session_id).workspace_id)
 assert.equal(f.c.store.db.prepare('SELECT COUNT(*) n FROM communication_grants').get()!.n,0)
}finally{f.close()}})

test('roots must already be directories; a failed multi-root request neither creates nor partially reserves them',async()=>{const f=fixture();try{
 const file=join(f.dir,'file');writeFileSync(file,'ordinary file')
 for(const invalid of [join(f.dir,'missing','home'),file,'relative-home'])await assert.rejects(reserve(f,[f.home,invalid]),{code:'PATH_NOT_ALLOWED'})
 assert.deepEqual(snapshot(f).roots,[])
}finally{f.close()}})

test('reservation validates its bounded input and does not accept session execution credentials',async()=>{const f=fixture();try{
 for(const params of [{roots:[]},{roots:'home'},{roots:[f.home],release:true},{roots:[null]},{roots:Array(65).fill(f.home)}])await assert.rejects(f.c.dispatch('trusted','reserve_host_state_roots',params),{code:'INVALID_ARGUMENT'})
 const identity=f.c.identities.register({session_id:'ordinary',cwd:f.project})
 await assert.rejects(f.c.dispatch('model-session','reserve_host_state_roots',{roots:[f.home]},identity),{code:'PERMISSION_REQUIRED'})
 assert.deepEqual(snapshot(f).roots,[])
}finally{f.close()}})

for(const corruption of ['invalid-json','array','unknown-schema','relative-root','noncanonical-root','missing-root','extra-field','duplicate-root'] as const)test(`malformed reservation ${corruption} fails admission and startup closed`,()=>{const f=fixture();try{
 const normal={schema:'host-state-roots-v1',roots:[f.home]}
 const value=corruption==='invalid-json'?'{':JSON.stringify(corruption==='array'?[]:corruption==='unknown-schema'?{...normal,schema:'future'}:corruption==='relative-root'?{...normal,roots:['relative']}:corruption==='noncanonical-root'?{...normal,roots:[f.home+'/../harness-home']}:corruption==='missing-root'?{...normal,roots:[join(f.dir,'missing')]}:corruption==='extra-field'?{...normal,ignore:true}:corruption==='duplicate-root'?{...normal,roots:[f.home,f.home]}:normal)
 putSnapshot(f,value)
 assert.throws(()=>f.c.identities.register({session_id:'blocked',cwd:f.project}),{code:'STORAGE_ERROR'})
 assert.equal(f.c.store.db.prepare('SELECT COUNT(*) n FROM sessions').get()!.n,0)
 assert.throws(()=>f.reopen(),{code:'STORAGE_ERROR'})
}finally{f.close()}})

test('loss of an established singleton is not mistaken for first feature migration',async()=>{const f=fixture();try{
 await reserve(f,[f.home]);f.c.store.db.prepare(`DELETE FROM ${table}`).run()
 assert.throws(()=>f.c.identities.register({session_id:'blocked',cwd:f.project}),{code:'STORAGE_ERROR'})
 assert.throws(()=>f.reopen(),{code:'STORAGE_ERROR'})
}finally{f.close()}})

test('legacy pre-feature database initializes once but its old workspace still prevents a conflicting reservation',async()=>{
 const dir=canonicalExistingDirectory(mkdtempSync(join(tmpdir(),'dsh-host-state-legacy-'))),root=join(dir,'project'),config=resolveConfig({data_dir:join(dir,'private')});mkdirSync(root)
 const old=new Store(join(config.data_dir,'coordinator.sqlite'));ensureWorkspaceIdentityScheme(old);old.db.prepare('INSERT INTO workspaces(id,project_id,root) VALUES(?,?,?)').run('old-w','old-p',root);old.close()
 const c=new Coordinator(config)
 try{await assert.rejects(c.dispatch('trusted','reserve_host_state_roots',{roots:[root]}),{code:'WORKSPACE_OVERLAP'});assert.equal(c.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n,1)}finally{c.close();rmSync(dir,{recursive:true,force:true})}
})

test('durable reservation transaction rolls back as a unit on storage failure',async()=>{const f=fixture();try{
 await reserve(f,[f.home]);f.c.store.db.exec(`CREATE TRIGGER fail_reservation BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END`)
 await assert.rejects(reserve(f,[f.otherHome]));assert.deepEqual(snapshot(f).roots,[f.home])
 f.c.store.db.exec('DROP TRIGGER fail_reservation');await reserve(f,[f.otherHome]);assert.deepEqual(snapshot(f).roots,[f.home,f.otherHome].sort())
}finally{f.close()}})


test('startup refuses a structurally valid reservation that contradicts stored workspace history',()=>{const f=fixture();try{
 f.c.identities.register({session_id:'before',cwd:f.project})
 putSnapshot(f,JSON.stringify({schema:'host-state-roots-v1',roots:[f.project]}))
 assert.throws(()=>f.reopen(),{code:'STORAGE_ERROR'})
}finally{f.close()}})

test('a suppressed reservation update cannot acknowledge unpersisted GUI readiness',async()=>{const f=fixture();try{
 await reserve(f,[f.home]);f.c.store.db.exec(`CREATE TRIGGER ignore_reservation BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`)
 await assert.rejects(reserve(f,[f.otherHome]),{code:'STORAGE_ERROR'})
 assert.deepEqual(snapshot(f).roots,[f.home])
}finally{f.close()}})
