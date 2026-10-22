/** Explicit packaging check, not host activation or the socket acceptance suite.
 * Usage: node tests/installed-package-smoke.mjs /path/to/isolated/npm-fixture
 * The fixture must already have installed this tarball and its pinned peers.
 */
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,rmSync,lstatSync} from 'node:fs'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

if(!process.argv[2])throw new Error('An isolated archive-install fixture directory is required.')
const fixture=resolve(process.argv[2]),require=createRequire(join(fixture,'package.json'))
const entry=require.resolve('@nerofirstgit/dsh-collaboration')
assert.equal(lstatSync(join(fixture,'node_modules/@nerofirstgit/dsh-collaboration')).isSymbolicLink(),false,'Use a real archive installation, not a source link.')
const plugin=await import(pathToFileURL(entry).href)
const filesystem=await import(pathToFileURL(require.resolve('@nerofirstgit/dsh-collaboration/filesystem')).href)
const {renameNoReplace}=await import(pathToFileURL(join(dirname(entry),'native-rename.js')).href)
assert.equal(plugin.name,'session-collaboration')
assert.equal(typeof plugin.apply,'function');assert.equal(typeof filesystem.ProtectedFileSystem,'function')
const dir=mkdtempSync(join(tmpdir(),'dsh-installed-rename-'))
try{
  writeFileSync(join(dir,'from'),'fresh offline package')
  renameNoReplace(dir,'from',dir,'to')
  assert.equal(readFileSync(join(dir,'to'),'utf8'),'fresh offline package')
  writeFileSync(join(dir,'from'),'retain')
  assert.throws(()=>renameNoReplace(dir,'from',dir,'to'),{code:'EEXIST'})
  assert.equal(readFileSync(join(dir,'from'),'utf8'),'retain')
  assert.equal(readFileSync(join(dir,'to'),'utf8'),'fresh offline package')
}finally{rmSync(dir,{recursive:true,force:true})}
console.log(JSON.stringify({compiled_exports:'PASS',compiled_portable_rename:'PASS',existing_target:'retained',host_mount:'NOT RUN'}))
