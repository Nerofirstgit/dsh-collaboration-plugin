/** Pure setup/summary tests; no real host, listener, model endpoint or child spawn. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {coordinatorEndpoint} from '../src/config.ts'
import {canonicalExistingDirectory} from '../src/platform/resource-paths.ts'
import {COOPERATION_PROTOCOL} from '../src/protocol.ts'
import {fixtureEnvironment,fixtureLinkType,fixtureClientOptions,fixtureSummary} from './integration/fixture-runtime.ts'

test('Windows fixture env keeps only allowlisted runtime values and isolated home/temp, never provider credentials',()=>{
 const source={Path:'C:\\Windows\\System32',SystemRoot:'C:\\Windows',windir:'C:\\Windows',ComSpec:'C:\\Windows\\System32\\cmd.exe',PATHEXT:'.EXE;.CMD',SystemDrive:'C:',USERPROFILE:'C:\\Users\\Real',APPDATA:'C:\\Users\\Real\\AppData',TEMP:'C:\\RealTemp',DEEPSEEK_API_KEY:'real-secret',OPENAI_API_KEY:'another-secret',NODE_OPTIONS:'--require unrelated.cjs',HTTPS_PROXY:'http://private-proxy',OTHER_SECRET:'no'}
 const env=fixtureEnvironment('C:\\Fixture\\home','C:\\Fixture\\temp',source,'win32')
 assert.equal(env.PATH,source.Path);assert.equal(env.SystemRoot,source.SystemRoot);assert.equal(env.ComSpec,source.ComSpec)
 assert.equal(env.USERPROFILE,'C:\\Fixture\\home');assert.equal(env.HOMEDRIVE,'C:');assert.equal(env.HOMEPATH,'\\Fixture\\home')
 assert.equal(env.HOME,env.USERPROFILE);assert.equal(env.DSH_HOME,env.USERPROFILE);assert.equal(env.TEMP,'C:\\Fixture\\temp');assert.equal(env.TMP,env.TEMP)
 assert.equal(env.APPDATA,'C:\\Fixture\\home\\AppData\\Roaming');assert.equal(env.LOCALAPPDATA,'C:\\Fixture\\home\\AppData\\Local')
 assert.equal(env.DEEPSEEK_API_KEY,'local-fixture-not-a-secret')
 for(const key of ['OPENAI_API_KEY','NODE_OPTIONS','HTTPS_PROXY','OTHER_SECRET'])assert.equal(Object.hasOwn(env,key),false)
 assert.equal(JSON.stringify(env).includes('real-secret'),false);assert.equal(fixtureLinkType('win32'),'junction')
})

test('POSIX fixture env also isolates tmp/home without inheriting unrelated configuration',()=>{
 const env=fixtureEnvironment('/fixture/home','/fixture/temp',{PATH:'/runtime',HOME:'/real',TMPDIR:'/real-tmp',DSH_HOME:'/real-dsh',DEEPSEEK_API_KEY:'real',NODE_OPTIONS:'unrelated'},'linux')
 assert.equal(env.PATH,'/runtime');assert.equal(env.HOME,'/fixture/home');assert.equal(env.DSH_HOME,'/fixture/home');assert.equal(env.TMPDIR,'/fixture/temp');assert.equal(env.DEEPSEEK_API_KEY,'local-fixture-not-a-secret');assert.equal(env.NODE_OPTIONS,undefined);assert.equal(fixtureLinkType('linux'),'dir')
})

test('fixture cleanup selects the actual production endpoint and current protocol from canonical state',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-fixture-options-'))
 try{const options=fixtureClientOptions(dir,'test-token');assert.equal(options.socket_path,coordinatorEndpoint(canonicalExistingDirectory(dir)).path);assert.equal(options.requiredProtocol,COOPERATION_PROTOCOL);assert.equal(options.admin_token,'test-token');assert.equal(options.timeout_ms,1000)}finally{rmSync(dir,{recursive:true,force:true})}
})

test('fixture evidence preserves only finite aggregate checks, and retains failed or requested successful runs',()=>{
 const input={completed:true,counts:{A:5,B:5},stored:{messages:1,delivered_messages:1,context_deliveries:1,committed_file_mutations:2},hostsStopped:true,daemonStopped:true,keepArtifacts:false,admin_token:'not-exported',requests:[{body:'not-exported'}],stdout:'not-exported'}
 const summary=fixtureSummary(input)
 assert.equal(summary.completed,true);assert.equal(summary.artifacts_retained,false);assert.deepEqual(summary.model_requests,{A:5,B:5});assert.deepEqual(summary.database,input.stored);assert.equal(JSON.stringify(summary).includes('not-exported'),false)
 assert.equal(fixtureSummary({...input,keepArtifacts:true}).artifacts_retained,true)
 assert.equal(fixtureSummary({...input,completed:false}).artifacts_retained,true)
 assert.equal(fixtureSummary({...input,daemonStopped:false}).artifacts_retained,true)
 assert.equal(fixtureSummary({...input,hostsStopped:false}).artifacts_retained,true)
})
