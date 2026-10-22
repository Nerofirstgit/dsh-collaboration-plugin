/** Real process-loss fixture only; never imported by the installed plugin. */
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {Store} from '../src/store.ts'
import {Writer,type FaultPoint} from '../src/writer.ts'
import {digest} from '../src/util.ts'
import type {RuntimeIdentity} from '../src/types.ts'
const [directory,point,mode='write']=process.argv.slice(2)
if(!directory||!point)throw new Error('directory and boundary required')
const root=join(directory,'workspace'),store=new Store(join(directory,'private','store.sqlite')),writer=new Writer(store)
writer.fault=boundary=>{if(boundary===point as FaultPoint)process.kill(process.pid,'SIGKILL')}
if(mode==='recover'){writer.recoverAll();store.close();process.exit(0)}
mkdirSync(join(root,'destination'),{recursive:true});writeFileSync(join(root,'source.txt'),'old\r\n')
store.db.prepare('INSERT INTO workspaces(id,project_id,root) VALUES(?,?,?)').run('w','p',root)
const token='rename-fixture-token'
store.db.prepare(`INSERT INTO sessions(id,project_id,workspace_id,incarnation_id,execution_epoch,token_hash,title,task_summary,state,host_id,started_at,last_heartbeat_at,last_heartbeat_mono,owner_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('a','p','w','inc-a',1,digest(token),'A','','running','fixture',1,1,performance.now(),store.epoch)
const identity:RuntimeIdentity={session_id:'a',incarnation_id:'inc-a',execution_epoch:1,coordinator_epoch:store.epoch,coordinator_domain:store.domain,runtime_token:token}
const read=writer.readFile(identity,{path:'source.txt'}),claims=writer.claimFiles(identity,{paths:['source.txt','destination/target.txt'],purpose:'rename process-loss fixture',request_id:'claim'}).claims
const source=claims.find(c=>c.path==='source.txt')!,target=claims.find(c=>c.path==='destination/target.txt')!
writer.applyFileChange(identity,{path:'source.txt',operation:'rename',expected_version:read.version,read_token:read.read_token,lease_id:source.lease_id,coordinator_epoch:store.epoch,fencing_token:source.fencing_token,mutation_id:'rename-crash',target_path:'destination/target.txt',expected_target_version:null,target_lease_id:target.lease_id,target_fencing_token:target.fencing_token})
throw new Error('Requested process-loss boundary was not reached')
