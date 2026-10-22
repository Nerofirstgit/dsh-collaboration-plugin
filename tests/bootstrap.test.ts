import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { preparePrivateState } from '../src/bootstrap.ts'
import { resolveConfig } from '../src/config.ts'

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'dsh-bootstrap-'))
  return {root,state:join(root,'state'),close(){rmSync(root,{recursive:true,force:true})}}
}
test('bootstrap refuses an unsafe existing directory before writing config or credentials',()=>{
  const f=fixture();try {
    mkdirSync(f.state,{mode:0o755});chmodSync(f.state,0o755)
    assert.throws(()=>preparePrivateState(resolveConfig({data_dir:f.state})),{code:'PATH_NOT_ALLOWED'})
    assert.deepEqual(readdirSync(f.state),[])
    assert.equal(statSync(f.state).mode&0o777,0o755)
  } finally {f.close()}
})
test('bootstrap rejects final and ancestor symlinks before creating any private files',()=>{
  const f=fixture();try {
    const target=join(f.root,'target'),alias=join(f.root,'alias');mkdirSync(target,{mode:0o700});symlinkSync(target,alias)
    for(const directory of [alias,join(alias,'new-state')])assert.throws(()=>preparePrivateState(resolveConfig({data_dir:directory})),{code:'PATH_NOT_ALLOWED'})
    assert.deepEqual(readdirSync(target),[])
  } finally {f.close()}
})
test('bootstrap creates private stable credentials but never overwrites existing shared settings',()=>{
  const f=fixture();try {
    const config=resolveConfig({data_dir:f.state}),first=preparePrivateState(config),again=preparePrivateState(config)
    assert.equal(first.admin_token,again.admin_token);assert.match(first.admin_token,/^[A-Za-z0-9_-]{43}$/)
    for(const file of ['config.json','runtime.key'])assert.equal(statSync(join(f.state,file)).mode&0o077,0)
    const old=readFileSync(join(f.state,'config.json'),'utf8')
    assert.throws(()=>preparePrivateState({...config,lease_ttl_ms:config.lease_ttl_ms+1}),{code:'PERMISSION_REQUIRED'})
    assert.equal(readFileSync(join(f.state,'config.json'),'utf8'),old)
  } finally {f.close()}
})
test('bootstrap refuses aliased private files without reading or changing their target',()=>{
  const f=fixture();try {
    mkdirSync(f.state,{mode:0o700});const target=join(f.root,'target');writeFileSync(target,'unchanged',{mode:0o600})
    symlinkSync(target,join(f.state,'config.json'))
    assert.throws(()=>preparePrivateState(resolveConfig({data_dir:f.state})),{code:'PATH_NOT_ALLOWED'})
    assert.equal(readFileSync(target,'utf8'),'unchanged');assert.equal(existsSync(join(f.state,'runtime.key')),false)
    rmSync(join(f.state,'config.json'));linkSync(target,join(f.state,'config.json'))
    assert.throws(()=>preparePrivateState(resolveConfig({data_dir:f.state})),{code:'PATH_NOT_ALLOWED'})
    assert.equal(readFileSync(target,'utf8'),'unchanged')
  } finally {f.close()}
})
