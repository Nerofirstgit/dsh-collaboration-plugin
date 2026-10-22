import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {startCoordinator} from '../src/server.ts'
import {CoordinatorClient} from '../src/client.ts'
import {resolveConfig} from '../src/config.ts'
import {record} from '../src/util.ts'
import type {RuntimeIdentity} from '../src/types.ts'
test('L02 kernel singleton rejects a second live coordinator and survives stale socket cleanup',async()=>{const dir=mkdtempSync(join(tmpdir(),'dsh-server-'));const config=resolveConfig({data_dir:join(dir,'state')});const server=await startCoordinator(config,'admin');const client=new CoordinatorClient({socket_path:server.socket_path,admin_token:'admin'});try{const ping=record(await client.call('ping'));assert.equal(ping.coordinator_epoch,1);await assert.rejects(startCoordinator(config,'admin'),{code:'COORDINATOR_UNAVAILABLE'})}finally{client.close();await server.close();rmSync(dir,{recursive:true,force:true})}})
test('private RPC authenticates before registration, resolves canonical session close idempotently',async()=>{const dir=mkdtempSync(join(tmpdir(),'dsh-rpc-')),root=join(dir,'project');mkdirSync(root);const server=await startCoordinator(resolveConfig({data_dir:join(dir,'state')}),'admin');const client=new CoordinatorClient({socket_path:server.socket_path,admin_token:'admin'}),bad=new CoordinatorClient({socket_path:server.socket_path,admin_token:'wrong'});try{await assert.rejects(bad.call('session_list'),{code:'PERMISSION_REQUIRED'});const h=record(await client.call('session_create',{header:{id:'a',version:4,createdAt:1,isSeeded:false,cwd:root},open_request_id:'create'}));const identity=h.identity as RuntimeIdentity;await client.call('session_close',{handle_id:h.handle_id},identity);await client.call('session_close',{handle_id:h.handle_id},identity);await assert.rejects(client.call('heartbeat',{},identity),{code:'STALE_INSTANCE'})}finally{client.close();bad.close();await server.close();rmSync(dir,{recursive:true,force:true})}})
