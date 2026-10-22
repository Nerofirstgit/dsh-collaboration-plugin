/** Pure persisted-claim mapping tests; Windows strings are fixtures, not native Windows acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {renameClaimGroup} from '../../src/host/claim-mapping.ts'
const source={path:'Long Name/Source.txt',lease_id:'source',coordinator_epoch:4,fencing_token:2,active:true}
const target={path:'Long Name/Target.txt',lease_id:'target',coordinator_epoch:4,fencing_token:6,active:true}
const a='C:\\WORKSP~1\\LONGNA~1\\SOURCE.TXT',b='Long Name/TARGET.txt'
function response(){return {claims:[target,source],path_mappings:[{requested_path:b,path:target.path,lease_id:target.lease_id},{requested_path:a,path:source.path,lease_id:source.lease_id}]}}
function code(error:unknown,expected:string){assert.equal((error as {code:string}).code,expected);return true}
test('rename uses durable requested spelling, canonical resource and lease together, never claim order',()=>{
  const result=renameClaimGroup(response(),a,b);assert.equal(result.source,source);assert.equal(result.destination,target)
})
test('original mappings are usable without consulting the filesystem after a parent disappeared',()=>{
  assert.deepEqual(renameClaimGroup(response(),a,b).group,[target,source])
})
test('legacy unmapped claim result fails with mutation reconciliation guidance instead of lexical fallback',()=>{
  assert.throws(()=>renameClaimGroup({claims:[source,target]},source.path,target.path),error=>{code(error,'STORAGE_ERROR');assert.match(String(error),/original mutation/i);return true})
})
for(const [label,mutate] of Object.entries({
  'missing requested spelling':(r:ReturnType<typeof response>)=>r.path_mappings.pop(),
  'duplicate requested spelling':(r:ReturnType<typeof response>)=>r.path_mappings.push({...r.path_mappings[0]!}),
  'lease and canonical path disagree':(r:ReturnType<typeof response>)=>{r.path_mappings[0]!.lease_id=source.lease_id},
  'unrequested alias is not silently invented':(r:ReturnType<typeof response>)=>{r.path_mappings[0]!.requested_path=b.toLowerCase()},
  'unrelated extra claim':(r:ReturnType<typeof response>)=>r.claims.push({...target,lease_id:'extra',path:'Extra.txt'}),
}))test(`malformed rename map fails closed: ${label}`,()=>{const value=response();mutate(value);assert.throws(()=>renameClaimGroup(value,a,b),e=>code(e,'STORAGE_ERROR'))})
test('two requested aliases for one resource cannot become a rename',()=>{
  assert.throws(()=>renameClaimGroup({claims:[source],path_mappings:[{requested_path:a,path:source.path,lease_id:source.lease_id},{requested_path:b,path:source.path,lease_id:source.lease_id}]},a,b),e=>code(e,'INVALID_ARGUMENT'))
})
test('an expired original claim never authorizes a new renamed write',()=>{
  const value=response();value.claims=[{...source,active:false},target];assert.throws(()=>renameClaimGroup(value,a,b),e=>code(e,'LEASE_EXPIRED'))
})
