/** Actual SQLite + host persistence component probe; no network transport. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionId,SessionSeq,SESSION_FORMAT_VERSION,type SessionEvent} from '@deepseek-ai/dsh-session'
import {createMessage,ToolCallId} from '@deepseek-ai/dsh-llm'
import {Coordinator} from '../src/coordinator.ts'
import {resolveConfig} from '../src/config.ts'
import {CoordinationSessionPersistence} from '../src/host/persistence.ts'
import type {RuntimeIdentity} from '../src/types.ts'

for(const scenario of [
 {name:'changed content and recipient',changes:{to_session_id:'c',body:'changed content'},code:'IDEMPOTENCY_CONFLICT'},
 {name:'null related paths',changes:{related_paths:null},code:'INVALID_ARGUMENT'},
 {name:'null reply reference',changes:{in_reply_to:null},code:'INVALID_ARGUMENT'},
 {name:'extra invalid field',changes:{unexpected:true},code:'INVALID_ARGUMENT'},
])test(`recovery must not fabricate success for ${scenario.name} under a reused message key`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-review-fingerprint-')),root=join(dir,'project');mkdirSync(root)
 const c=new Coordinator(resolveConfig({data_dir:join(dir,'state'),communication_policy:'same_project_enabled'}))
 const client={call:(method:string,params:Record<string,unknown>={},identity?:RuntimeIdentity)=>c.dispatch('fixture',method,params,identity)}
 const p=new CoordinationSessionPersistence(new Context(),client,{workspaceRoot:root})
 try{
  const header={version:SESSION_FORMAT_VERSION,createdAt:1,isSeeded:false,cwd:root}
  const a=await p.create({...header,id:SessionId('a')}),b=await p.create({...header,id:SessionId('b')}),d=await p.create({...header,id:SessionId('c')})
  const old=await client.call('send_message',{to_session_id:'b',body:'original',idempotency_key:'same-key'},p.runtimeIdentity(a.id))
  const changed={to_session_id:'b',body:'original',idempotency_key:'same-key',...scenario.changes},args=JSON.stringify(changed),callId=ToolCallId('call-conflict')
  const events:SessionEvent[]=[
   {type:'turn/start',seq:SessionSeq(0),time:1,data:{turn:1}},
   {type:'step/start',seq:SessionSeq(1),time:1,data:{turn:1,step:1}},
   {type:'assistant/message',seq:SessionSeq(2),time:2,surfaceOp:'append',data:{turn:1,step:1,stream:[],message:createMessage({role:'assistant',source:{kind:'model',provider:'keyless',model:'fixture'},content:[{type:'tool-call',id:callId,name:'session_send_message',arguments:args}]})}},
   {type:'tool/call',seq:SessionSeq(3),time:2,data:{turn:1,step:1,callId,name:'session_send_message',arguments:args}},
  ]
  await a.append(events)
  await client.call('prepare_tool_operation',{turn_id:'1',tool_call_id:callId,tool_name:'session_send_message',arguments:args},p.runtimeIdentity(a.id))
  await assert.rejects(client.call('send_message',changed,p.runtimeIdentity(a.id)),{code:scenario.code})
  // Simulate the lost tool/result suffix by closing before that result is appended.
  await a.close()
  const resumed=await p.open(a.id,'write')
  const appended=(await resumed.read()).events.find(e=>e.type==='tool/result')
  assert.ok(appended&&appended.type==='tool/result','probe should reach actual host recovery append')
  const text=appended.data.message.content.find(block=>block.type==='text')
  assert.ok(text&&text.type==='text')
  const recovered=JSON.parse(text.text)
  assert.notEqual(recovered.status,'success',`conflicting call was fabricated as success of prior message ${JSON.stringify(old)}`)
  assert.equal(recovered.error.code,scenario.code)
  await resumed.close();await b.close();await d.close()
 }finally{c.close();rmSync(dir,{recursive:true,force:true})}
})
