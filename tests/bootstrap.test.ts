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
test('bootstrap refuses an unsafe existing directory before writing config or credentials',{skip:process.platform==='win32'?'POSIX mode assertions are not Windows ACL validation':false},()=>{
  const f=fixture();try {
    mkdirSync(f.state,{mode:0o755});chmodSync(f.state,0o755)
    assert.throws(()=>preparePrivateState(resolveConfig({data_dir:f.state})),{code:'PATH_NOT_ALLOWED'})
    assert.deepEqual(readdirSync(f.state),[])
    assert.equal(statSync(f.state).mode&0o777,0o755)
  } finally {f.close()}
})
test('bootstrap rejects final and ancestor symlinks before creating any private files',{skip:process.platform==='win32'?'Symlink creation requires Windows privileges; no ACL claim':false},()=>{
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
    if(process.platform!=='win32')for(const file of ['config.json','runtime.key'])assert.equal(statSync(join(f.state,file)).mode&0o077,0)
    const old=readFileSync(join(f.state,'config.json'),'utf8')
    assert.throws(()=>preparePrivateState({...config,lease_ttl_ms:config.lease_ttl_ms+1}),{code:'PERMISSION_REQUIRED'})
    assert.equal(readFileSync(join(f.state,'config.json'),'utf8'),old)
  } finally {f.close()}
})
test('bootstrap refuses aliased private files without reading or changing their target',{skip:process.platform==='win32'?'Symlink creation requires Windows privileges; no ACL claim':false},()=>{
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

test('portable bootstrap serializes initialization in a separate SQLite transaction and preserves its key',()=>{
 const directory=mkdtempSync(join(tmpdir(),'dsh-bootstrap-portable-'))
 try{
  const config=resolveConfig({data_dir:directory}),first=preparePrivateState(config)
  assert.equal(existsSync(join(directory,'bootstrap.sqlite')),true)
  assert.equal(preparePrivateState(config).admin_token,first.admin_token)
  assert.equal(existsSync(join(directory,'coordinator-election.sqlite')),false,'preparing credentials must not become a live daemon owner')
 }finally{rmSync(directory,{recursive:true,force:true})}
})

test('separate ordinary starter processes converge on one prepared configuration and credential',async()=>{
 const {spawn}=await import('node:child_process'),{fileURLToPath}=await import('node:url')
 const worker=fileURLToPath(new URL('./portable-coordinator-bootstrap-worker.ts',import.meta.url))
 const directory=mkdtempSync(join(tmpdir(),'dsh-bootstrap-concurrent-'))
 try{
  const run=()=>new Promise<{config:{data_dir:string};admin_token:string}>((resolve,reject)=>{
   const child=spawn(process.execPath,['--import','tsx/esm',worker,directory],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false
   const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},15000)
   child.stdout.on('data',part=>{stdout+=String(part)});child.stderr.on('data',part=>{stderr+=String(part)})
   child.once('error',error=>{clearTimeout(timeout);reject(error)})
   child.once('exit',code=>{clearTimeout(timeout);if(timedOut){reject(new Error(`Bootstrap preparation timed out: ${stderr}`));return}if(code!==0){reject(new Error(`Bootstrap preparation failed (${code}): ${stderr}`));return}try{resolve(JSON.parse(stdout))}catch(error){reject(error)}})
  })
  const settled=await Promise.allSettled([run(),run(),run()])
  const results=settled.map(result=>{if(result.status==='rejected')throw result.reason;return result.value})
  assert.deepEqual(results[1],results[0]);assert.deepEqual(results[2],results[0])
  assert.equal(readFileSync(join(directory,'runtime.key'),'utf8'),results[0]!.admin_token)
  assert.equal(preparePrivateState(resolveConfig({data_dir:directory})).admin_token,results[0]!.admin_token)
 }finally{rmSync(directory,{recursive:true,force:true})}
})
