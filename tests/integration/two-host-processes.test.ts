/**
 * UNRUN in the cloud sandbox: original Unix daemon transport cannot bind here.
 * This is an actual two-dsh-process test, not a loopback coordinator substitute.
 * A local Messages HTTP fixture replaces only the paid model endpoint.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer,type ServerResponse} from 'node:http'
import {spawn,type ChildProcess} from 'node:child_process'
import {once} from 'node:events'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {DatabaseSync} from 'node:sqlite'
import {initProfile} from '@deepseek-ai/dsh-app-boot'
import {CoordinatorClient} from '../../src/client.ts'

const repository=fileURLToPath(new URL('../..',import.meta.url))
const model='deepseek-v4-flash'
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});void promise.catch(()=>{});return{promise,resolve,reject}}
function bounded<T>(promise:Promise<T>,ms:number,label:string):Promise<T>{return new Promise((yes,no)=>{const timer=setTimeout(()=>no(new Error(`Timed out: ${label}`)),ms);promise.then(v=>{clearTimeout(timer);yes(v)},e=>{clearTimeout(timer);no(e)})})}
function answer(response:ServerResponse,tool?:{name:string;input:Record<string,unknown>}){
  const start={type:'message_start',message:{id:'fixture-'+Math.random().toString(16).slice(2),model,usage:{input_tokens:100,output_tokens:0}}}
  const events:Record<string,unknown>[]=tool?[start,{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'call-'+Math.random().toString(16).slice(2),name:tool.name,input:tool.input}},{type:'content_block_stop',index:0}]:[start,{type:'content_block_start',index:0,content_block:{type:'text',text:'fixture complete'}},{type:'content_block_stop',index:0}]
  events.push({type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:5}},{type:'message_stop'})
  response.writeHead(200,{'content-type':'text/event-stream'})
  response.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
}
function startHost(home:string,workspace:string,marker:string){
  const cli=resolve(repository,'node_modules/@deepseek-ai/dsh/lib/bin.js')
  // Deliberately do not inherit any real credentials or unrelated project env.
  const env={PATH:process.env.PATH,HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',DEEPSEEK_API_KEY:'local-fixture-not-a-secret',NO_PROXY:'127.0.0.1,localhost'}
  const child=spawn(process.execPath,[cli,'--profile','collaboration-fixture','--json',marker],{cwd:workspace,env,stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='',buffer='';const session=deferred<string>()
  child.stdout!.on('data',chunk=>{const text=String(chunk);stdout+=text;buffer+=text;let i:number;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const event=JSON.parse(line);if(event.type==='session')session.resolve(event.sessionId)}catch{/* ordinary diagnostics are retained */}}})
  child.stderr!.on('data',chunk=>{stderr+=String(chunk)})
  const done=new Promise<void>((yes,no)=>{child.once('error',no);child.once('exit',(code,signal)=>code===0?yes():no(new Error(`Host ${marker} failed (${code}/${signal})\n${stdout}\n${stderr}`)))})
  void done.catch(error=>session.reject(error))
  return{child,done,session:session.promise,diagnostics:()=>({stdout,stderr})}
}

test('two real pinned Harness processes discover, deliver at a boundary, reject stale edit, and preserve both writers',{timeout:120000},async(t)=>{
  assert.ok(existsSync(join(repository,'lib/plugin.js')),'Run npm run build before the process acceptance test.')
  const dir=mkdtempSync(join(tmpdir(),'dsh-two-host-')),home=join(dir,'home'),workspace=join(dir,'project'),data=join(dir,'coordinator')
  mkdirSync(workspace);mkdirSync(home);writeFileSync(join(workspace,'shared.txt'),'base\n')
  const profile=join(home,'profiles','collaboration-fixture')
  initProfile(profile,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless','@nerofirstgit/dsh-collaboration'])
  const manifest=JSON.parse(readFileSync(join(profile,'package.json'),'utf8'));manifest.dependencies={'@nerofirstgit/dsh-collaboration':`file:${repository}`};writeFileSync(join(profile,'package.json'),JSON.stringify(manifest))
  mkdirSync(join(profile,'node_modules','@nerofirstgit'),{recursive:true});symlinkSync(repository,join(profile,'node_modules','@nerofirstgit','dsh-collaboration'))
  const bothRead=deferred<void>(),messageCommitted=deferred<void>(),aExited=deferred<void>();let reads=0,bId=''
  const requests:{peer:string;phase:number;body:unknown}[]=[];const counts={A:0,B:0};let endpointFailure:unknown
  const children:ChildProcess[]=[];let client:CoordinatorClient|undefined,daemonPid:number|undefined,completed=false
  const server=createServer((request,response)=>{void(async()=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    assert.ok(request.url?.endsWith('/v1/messages'),'Only the local Messages API is allowed')
    const body=JSON.parse(Buffer.concat(chunks).toString()),json=JSON.stringify(body),peer=json.includes('HARNESS_FIXTURE_A')?'A':json.includes('HARNESS_FIXTURE_B')?'B':undefined
    assert.ok(peer,'Unknown fixture model request');const phase=++counts[peer];requests.push({peer,phase,body})
    if(phase===1){answer(response,{name:'read',input:{file_path:'shared.txt'}});return}
    if(phase===2){if(++reads===2)bothRead.resolve();await bounded(bothRead.promise,20000,'both independent reads');assert.match(json,/base/)
      if(peer==='B'){await bounded(messageCommitted.promise,20000,'A accepted message');await bounded(aExited.promise,20000,'A lifecycle releases claim')}
      answer(response,{name:'edit',input:{file_path:'shared.txt',old_string:'base\n',new_string:peer==='A'?'base\nA\n':'base\nB\n'}});return
    }
    if(peer==='A'&&phase===3){assert.match(json,/committed/);answer(response,{name:'session_list_sessions',input:{scope:'same_workspace'}});return}
    if(peer==='A'&&phase===4){assert.ok(bId);assert.match(json,new RegExp(bId));answer(response,{name:'session_send_message',input:{to_session_id:bId,body:'A committed; reread before editing.',idempotency_key:'fixture-A-to-B'}});return}
    if(peer==='A'&&phase===5){assert.match(json,/message_id/);messageCommitted.resolve();answer(response);return}
    if(peer==='B'&&phase===3){assert.match(json,/VERSION_CONFLICT/);assert.match(json,/A committed; reread before editing/);assert.match(json,/not human authorization/);answer(response,{name:'read',input:{file_path:'shared.txt'}});return}
    if(peer==='B'&&phase===4){answer(response,{name:'edit',input:{file_path:'shared.txt',old_string:'base\nA\n',new_string:'base\nA\nB\n'}});return}
    if(peer==='B'&&phase===5){assert.match(json,/committed/);answer(response);return}
    throw new Error(`Unexpected model boundary ${peer}:${phase}`)
  })().catch(error=>{endpointFailure=error;bothRead.reject(error);messageCommitted.reject(error);aExited.reject(error);response.destroy(error as Error)})})
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string')
    writeFileSync(join(profile,'cordis.patch.yml'),`- id: session-collaboration\n  config:\n    data_dir: ${JSON.stringify(data)}\n    workspace_root: ${JSON.stringify(workspace)}\n    communication_policy: same_project_enabled\n- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${address.port}/anthropic\n    thinking: disabled\n    reasoningEffort: off\n    maxTokens: 1000\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: ${model}\n`)
    const b=startHost(home,workspace,'HARNESS_FIXTURE_B');children.push(b.child);bId=await bounded(b.session,20000,'B session registration')
    const a=startHost(home,workspace,'HARNESS_FIXTURE_A');children.push(a.child);await bounded(a.session,20000,'A session registration')
    assert.notEqual(a.child.pid,b.child.pid)
    await bounded(a.done,40000,'A terminal result');aExited.resolve()
    await bounded(b.done,40000,'B terminal result');if(endpointFailure)throw endpointFailure
    assert.equal(readFileSync(join(workspace,'shared.txt'),'utf8'),'base\nA\nB\n')
    const db=new DatabaseSync(join(data,'coordinator.sqlite'),{readOnly:true})
    try{assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get()!.n,1);assert.equal(db.prepare('SELECT delivery_state FROM messages').get()!.delivery_state,'delivered');assert.ok(Number(db.prepare('SELECT COUNT(*) n FROM context_deliveries').get()!.n)>0);assert.equal(db.prepare("SELECT COUNT(*) n FROM file_mutations WHERE state='committed'").get()!.n,2)}finally{db.close()}
    assert.equal(requests.filter(r=>r.peer==='A').length,5);assert.equal(requests.filter(r=>r.peer==='B').length,5)
    completed=true
  }finally{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')
    if(existsSync(join(data,'runtime.key'))){try{client=new CoordinatorClient({socket_path:join(data,'coordinator.sock'),admin_token:readFileSync(join(data,'runtime.key'),'utf8').trim(),timeout_ms:1000});const ping=await client.call('ping') as {pid:number};daemonPid=ping.pid}catch{/* retain failure diagnostics */}finally{client?.close()}}
    if(daemonPid)try{process.kill(daemonPid,'SIGTERM')}catch{/* already stopped */}
    await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()})
    // Wait for spawned hosts to release only their own temporary profile files.
    await Promise.all(children.map(child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():bounded(once(child,'exit').then(()=>undefined),5000,'fixture host shutdown').catch(()=>undefined)))
    // Never remove an open daemon's recovery evidence or a failed fixture's
    // diagnostic state. The authenticated ping above identifies only our daemon.
    let daemonStopped=!existsSync(join(data,'runtime.key'))
    if(daemonPid)for(let attempt=0;attempt<100;attempt++){try{process.kill(daemonPid,0)}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH'){daemonStopped=true;break}throw error}await new Promise(resolve=>setTimeout(resolve,50))}
    const hostsStopped=children.every(child=>child.exitCode!==null||child.signalCode!==null)
    if(completed&&hostsStopped&&daemonStopped)rmSync(dir,{recursive:true,force:true})
    else t.diagnostic(`Fixture evidence retained at ${dir}; completed=${completed}, hostsStopped=${hostsStopped}, daemonStopped=${daemonStopped}`)
  }
})
