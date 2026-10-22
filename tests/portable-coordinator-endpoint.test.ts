/** Endpoint lifecycle component tests use only injected metadata operations, never net.listen. */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as ipc from '../src/platform/ipc.ts'

test('Windows pipe lifecycle never attempts Unix lstat, unlink, or chmod',async()=>{
 const operations={async lstat(){assert.fail('pipe lstat is invalid')},async unlink(){assert.fail('pipe unlink is invalid')},async chmod(){assert.fail('pipe chmod is invalid')}}
 for(const name of ['prepareCoordinatorEndpoint','secureCoordinatorEndpoint','removeCoordinatorEndpoint']){
  const operation=(ipc as unknown as Record<string,unknown>)[name]
  assert.equal(typeof operation,'function',`${name} must exist`)
  await (operation as (endpoint:unknown,operations:unknown)=>Promise<void>)({kind:'named-pipe',path:'\\\\.\\pipe\\fixture'},operations)
 }
})

test('Unix endpoint lifecycle preserves stale socket removal and private mode',async()=>{
 const calls:string[]=[]
 const operations={async lstat(path:string){calls.push(`stat:${path}`);return{isSocket:()=>true}},async unlink(path:string){calls.push(`unlink:${path}`)},async chmod(path:string,mode:number){calls.push(`chmod:${path}:${mode}`)}}
 const endpoint={kind:'unix',path:'/fixture/coordinator.sock'}
 for(const name of ['prepareCoordinatorEndpoint','secureCoordinatorEndpoint','removeCoordinatorEndpoint']){
  const operation=(ipc as unknown as Record<string,unknown>)[name]
  assert.equal(typeof operation,'function',`${name} must exist`)
  await (operation as (endpoint:unknown,operations:unknown)=>Promise<void>)(endpoint,operations)
 }
 assert.deepEqual(calls,['stat:/fixture/coordinator.sock','unlink:/fixture/coordinator.sock','chmod:/fixture/coordinator.sock:384','unlink:/fixture/coordinator.sock'])
})
