/** Portable naming/election component evidence. Never opens a transport. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import {tmpdir,userInfo} from 'node:os'
import {join} from 'node:path'
import * as config from '../src/config.ts'
import {InstanceLock,CoordinatorInstanceLock} from '../src/instance-lock.ts'

test('machine election namespace uses the OS account home rather than host-controlled environment',()=>{
 const names=['HOME','USERPROFILE','TMPDIR','DSH_HOME','XDG_DATA_HOME'] as const,previous=new Map(names.map(name=>[name,process.env[name]]))
 try{for(const name of names)process.env[name]='/unrelated-test-environment';assert.equal(config.machineInstanceDirectory(),join(userInfo().homedir,'.dsh-collaboration-instance'))}
 finally{for(const [name,value]of previous)value===undefined?delete process.env[name]:process.env[name]=value}
})

test('portable endpoint selection preserves Unix path and produces stable Windows named pipes',()=>{
 const endpoint=(config as unknown as {coordinatorEndpoint?: (directory:string,platform?:NodeJS.Platform)=>{kind:string;path:string}}).coordinatorEndpoint
 assert.equal(typeof endpoint,'function','portable endpoint selector must exist')
 const unix=endpoint!('/private/domain','linux');assert.deepEqual(unix,{kind:'unix',path:'/private/domain/coordinator.sock'})
 const windows=endpoint!('C:\\Users\\Fixture\\domain','win32');assert.equal(windows.kind,'named-pipe');assert.match(windows.path,/^\\\\\.\\pipe\\dsh-collaboration-[a-f0-9]{64}$/)
 assert.deepEqual(endpoint!('C:\\Users\\Fixture\\domain','win32'),windows)
 assert.notEqual(endpoint!('C:\\Users\\Fixture\\other','win32').path,windows.path)
 assert.ok(windows.path.length<200)
})

test('ordinary election uses a dedicated SQLite database and retains ownership until close',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'dsh-portable-election-'));let first:InstanceLock|undefined,second:InstanceLock|undefined
 try{first=await InstanceLock.acquire(directory);assert.equal(existsSync(join(directory,'coordinator-election.sqlite')),true)
 await assert.rejects(InstanceLock.acquire(directory),{code:'COORDINATOR_UNAVAILABLE'});await first.close();await first.close();first=undefined
 second=await InstanceLock.acquire(directory)
 }finally{await second?.close();await first?.close();rmSync(directory,{recursive:true,force:true})}
})

test('internal namespace injection lets two domains share one election without changing production Config',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'dsh-portable-domain-'));const namespace=join(directory,'machine');let first:CoordinatorInstanceLock|undefined,second:CoordinatorInstanceLock|undefined
 const acquire=CoordinatorInstanceLock.acquire as (domain:string,internalNamespace?:string)=>Promise<CoordinatorInstanceLock>
 try{first=await acquire(join(directory,'one'),namespace);assert.equal(existsSync(join(namespace,'coordinator-election.sqlite')),true)
 await assert.rejects(acquire(join(directory,'two'),namespace),{code:'COORDINATOR_UNAVAILABLE'});await first.close();first=undefined
 second=await acquire(join(directory,'two'),namespace)
 assert.equal('machine_directory' in config.resolveConfig({data_dir:join(directory,'one'),machine_directory:'/ignored'} as Parameters<typeof config.resolveConfig>[0]),false)
 }finally{await second?.close();await first?.close();rmSync(directory,{recursive:true,force:true})}
})

test('a failed same-process contender does not release the owner lock to a separate process',async()=>{
 const {spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url')
 const worker=fileURLToPath(new URL('./portable-coordinator-lock-worker.ts',import.meta.url))
 const directory=mkdtempSync(join(tmpdir(),'dsh-portable-contender-'));let owner:InstanceLock|undefined
 try{
  owner=await InstanceLock.acquire(directory)
  await assert.rejects(InstanceLock.acquire(directory),{code:'COORDINATOR_UNAVAILABLE'})
  const rejected=spawnSync(process.execPath,['--import','tsx/esm',worker,directory],{encoding:'utf8',timeout:10000})
  assert.equal(rejected.status,2,rejected.stdout+rejected.stderr)
  assert.match(rejected.stdout,/COORDINATOR_UNAVAILABLE/)
  await owner.close();owner=undefined
  const accepted=spawnSync(process.execPath,['--import','tsx/esm',worker,directory],{encoding:'utf8',timeout:10000})
  assert.equal(accepted.status,0,accepted.stdout+accepted.stderr);assert.match(accepted.stdout,/held/)
 }finally{await owner?.close();rmSync(directory,{recursive:true,force:true})}
})

test('an idle or paused child keeps the election; process death releases it without a timer',async()=>{
 const {spawn}=await import('node:child_process'),{fileURLToPath}=await import('node:url'),{once}=await import('node:events')
 const worker=fileURLToPath(new URL('./portable-coordinator-lock-worker.ts',import.meta.url))
 const directory=mkdtempSync(join(tmpdir(),'dsh-portable-owner-death-'))
 const child=spawn(process.execPath,['--import','tsx/esm',worker,directory,'hold'],{stdio:['pipe','pipe','pipe']})
 let stderr='';child.stderr.on('data',part=>{stderr+=String(part)})
 const finished=once(child,'exit');let next:InstanceLock|undefined,stopped=false
 try{
  await new Promise<void>((resolve,reject)=>{
   let output='';const timeout=setTimeout(()=>reject(new Error(`Child election readiness timed out: ${stderr}`)),10000)
   child.once('error',error=>{clearTimeout(timeout);reject(error)})
   child.once('exit',code=>{clearTimeout(timeout);if(!output.includes('held\n'))reject(new Error(`Child exited ${code}: ${stderr}`))})
   child.stdout.on('data',part=>{output+=String(part);if(output.includes('held\n')){clearTimeout(timeout);resolve()}})
  })
  await assert.rejects(InstanceLock.acquire(directory),{code:'COORDINATOR_UNAVAILABLE'})
  if(process.platform!=='win32'){assert.equal(child.kill('SIGSTOP'),true);stopped=true}
  await assert.rejects(InstanceLock.acquire(directory),{code:'COORDINATOR_UNAVAILABLE'})
  if(stopped){child.kill('SIGCONT');stopped=false}
  child.kill('SIGKILL');await finished
  next=await InstanceLock.acquire(directory)
 }finally{
  if(stopped)child.kill('SIGCONT')
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')
  await finished;await next?.close();rmSync(directory,{recursive:true,force:true})
 }
})

test('a failed domain election releases the already acquired internal machine election',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'dsh-portable-partial-election-'))
 const blocked=await InstanceLock.acquire(join(directory,'busy'));let accepted:CoordinatorInstanceLock|undefined
 try{
  await assert.rejects(CoordinatorInstanceLock.acquire(join(directory,'busy'),join(directory,'machine')),{code:'COORDINATOR_UNAVAILABLE'})
  accepted=await CoordinatorInstanceLock.acquire(join(directory,'free'),join(directory,'machine'))
 }finally{await accepted?.close();await blocked.close();rmSync(directory,{recursive:true,force:true})}
})
