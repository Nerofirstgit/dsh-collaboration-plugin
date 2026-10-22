/** Canonical identity scheme and alias fixtures, not native Windows execution. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {win32} from 'node:path'
import {Store} from '../src/store.ts'
import * as identity from '../src/identity.ts'
import type {ResourcePathFileSystem} from '../src/platform/resource-paths.ts'

function filesystem():ResourcePathFileSystem {
 const entries=[{path:'C:\\',ino:1n},{path:'C:\\Workbench',ino:2n},{path:'C:\\Workbench\\Sub',ino:3n},{path:'C:\\Workbench\\Sibling',ino:4n}]
 const locate=(path:string)=>{const candidate=win32.normalize(path).replace(/workb~1/ig,'Workbench').toLowerCase();const match=entries.find(e=>e.path.toLowerCase()===candidate);if(!match)throw Object.assign(new Error('missing'),{code:'ENOENT'});return match}
 return {realpath(path){locate(path);return win32.normalize(path)},lstat(path){return{kind:'directory',dev:77n,ino:locate(path).ino}},readDirectory(path,maximum){const current=locate(path).path,children=entries.filter(e=>e.path!==current&&win32.dirname(e.path)===current).map(e=>win32.basename(e.path));return{entries:children.slice(0,maximum),complete:children.length<=maximum}}}
}

test('Windows project case and short-name aliases produce one canonical logical workspace',()=>{
 const options={platform:'win32' as const,filesystem:filesystem(),git:()=>null}
 const resolve=identity.resolveProject as (cwd:string,root?:string,options?:unknown)=>ReturnType<typeof identity.resolveProject>
 const a=resolve('C:\\Workbench\\Sub','C:\\Workbench',options),b=resolve('c:\\workb~1\\sub','c:\\workbench',options)
 assert.deepEqual(a,b);assert.equal(a.root,'C:\\Workbench')
 assert.notEqual(a.workspace_id,resolve('C:\\Workbench\\Sibling',undefined,options).workspace_id)
})

test('canonical Windows containment does not case-fold distinct directory names',()=>{
 const within=identity.within as (root:string,path:string,platform?:NodeJS.Platform)=>boolean
 assert.equal(within('C:\\Workspace\\Foo','C:\\Workspace\\Foo\\a.txt','win32'),true)
 assert.equal(within('C:\\Workspace\\Foo','C:\\Workspace\\foo\\a.txt','win32'),false)
 assert.equal(within('C:\\Workspace\\Foo','C:\\Workspace\\Foobar','win32'),false)
})

test('fresh Windows identity domain records its canonical-component scheme without rewriting Linux metadata',()=>{
 const store=new Store(':memory:')
 try{
  const ensure=Reflect.get(identity,'ensureWorkspaceIdentityScheme') as ((store:Store,platform:NodeJS.Platform)=>void)|undefined
  assert.equal(typeof ensure,'function');ensure!(store,'linux')
  assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key='windows_identity_scheme'").get(),undefined)
  ensure!(store,'win32');ensure!(store,'win32')
  assert.equal(store.meta('windows_identity_scheme'),'canonical-components-v1')
  const epoch=store.epoch;ensure!(store,'win32');assert.equal(store.epoch,epoch)
 }finally{store.close()}
})

test('legacy Windows rows require explicit identity migration instead of creating a second workspace domain',()=>{
 const store=new Store(':memory:')
 try{
  store.db.prepare('INSERT INTO workspaces(id,project_id,root) VALUES(?,?,?)').run('old-workspace','old-project','C:\\Workbench')
  const ensure=Reflect.get(identity,'ensureWorkspaceIdentityScheme') as ((store:Store,platform:NodeJS.Platform)=>void)|undefined
  assert.equal(typeof ensure,'function')
  assert.throws(()=>ensure!(store,'win32'),{code:'STORAGE_ERROR'})
  assert.deepEqual(store.db.prepare('SELECT id,project_id,root FROM workspaces').all().map(r=>({...r})),[{id:'old-workspace',project_id:'old-project',root:'C:\\Workbench'}])
  assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key='windows_identity_scheme'").get(),undefined)
 }finally{store.close()}
})

test('explicit workspace restriction is not ignored when Git returns a different root',()=>{
 const options={platform:'win32' as const,filesystem:filesystem(),git:(_directory:string,arg:string)=>arg==='--show-toplevel'?'C:\\Workbench':null}
 const resolve=identity.resolveProject as (cwd:string,root?:string,options?:unknown)=>ReturnType<typeof identity.resolveProject>
 assert.throws(()=>resolve('C:\\Workbench\\Sub','C:\\Workbench\\Sibling',options),{code:'PATH_NOT_ALLOWED'})
 assert.throws(()=>resolve('C:\\Workbench\\Sub','C:\\Workbench\\Sub',options),{code:'PATH_NOT_ALLOWED'})
 assert.equal(resolve('C:\\Workbench\\Sub','C:\\Workbench',options).root,'C:\\Workbench')
})
