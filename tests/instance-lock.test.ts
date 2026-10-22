/** Kernel lock component evidence only: no socket or daemon process is started. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {CoordinatorInstanceLock} from '../src/instance-lock.ts'
test('L02 distinct configured data directories cannot elect simultaneous writers for one OS user',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-global-lock-'));let first:CoordinatorInstanceLock|undefined,second:CoordinatorInstanceLock|undefined
 try{first=await CoordinatorInstanceLock.acquire(join(dir,'one'));await assert.rejects(CoordinatorInstanceLock.acquire(join(dir,'two')),{code:'COORDINATOR_UNAVAILABLE'});await first.close();first=undefined;second=await CoordinatorInstanceLock.acquire(join(dir,'two'));await assert.rejects(CoordinatorInstanceLock.acquire(join(dir,'one')),{code:'COORDINATOR_UNAVAILABLE'})}finally{await second?.close();await first?.close();rmSync(dir,{recursive:true,force:true})}
})
