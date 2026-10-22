import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {Store} from '../src/store.ts'
for(const [name,sql]of [
 ['non-numeric epoch',"UPDATE metadata SET value='not-an-epoch' WHERE key='coordinator_epoch'"],
 ['unsafe epoch',"UPDATE metadata SET value='9007199254740991' WHERE key='coordinator_epoch'"],
 ['missing domain',"DELETE FROM metadata WHERE key='coordinator_domain'"],
 ['missing signing key',"DELETE FROM metadata WHERE key='signing_key'"],
 ['unsupported schema',"UPDATE metadata SET value='future' WHERE key='schema_version'"],
]as const)test(`corrupt ${name} fails closed rather than recreating authority`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-store-metadata-')),path=join(dir,'db.sqlite');const first=new Store(path);first.db.exec(sql);first.close();try{assert.throws(()=>new Store(path),{code:'STORAGE_ERROR'})}finally{rmSync(dir,{recursive:true,force:true})}
})
test('non-coordinator SQLite database is not silently converted into a coordination domain',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-store-unknown-')),path=join(dir,'db.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE unrelated(value TEXT)');db.close();try{assert.throws(()=>new Store(path),{code:'STORAGE_ERROR'});const after=new DatabaseSync(path);try{assert.equal(after.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='metadata'").get()!.n,0)}finally{after.close()}}finally{rmSync(dir,{recursive:true,force:true})}
})
test('validated orderly reopen advances epoch without replacing coordinator domain',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-store-reopen-')),path=join(dir,'db.sqlite'),first=new Store(path),domain=first.domain;first.close();try{const second=new Store(path);try{assert.equal(second.epoch,2);assert.equal(second.domain,domain)}finally{second.close()}}finally{rmSync(dir,{recursive:true,force:true})}
})
