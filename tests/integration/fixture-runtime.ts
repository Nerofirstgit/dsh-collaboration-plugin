/** Test-only setup helpers. No listener, child process, or production config override. */
import {posix,win32} from 'node:path'
import {coordinatorEndpoint} from '../../src/config.ts'
import {canonicalExistingDirectory} from '../../src/platform/resource-paths.ts'
import {COOPERATION_PROTOCOL} from '../../src/protocol.ts'
import type {ClientOptions} from '../../src/client.ts'

export function fixtureEnvironment(home:string,temp:string,source:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform):NodeJS.ProcessEnv {
 const windows=platform==='win32',path=windows?win32:posix
 const value=(name:string)=>{const key=Object.keys(source).sort().find(key=>windows?key.toUpperCase()===name.toUpperCase():key===name);return key===undefined?undefined:source[key]}
 const env:NodeJS.ProcessEnv={HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',DEEPSEEK_API_KEY:'local-fixture-not-a-secret',NO_PROXY:'127.0.0.1,localhost'}
 const executablePath=value('PATH');if(executablePath!==undefined)env.PATH=executablePath
 if(windows){
  for(const key of ['SystemRoot','WINDIR','SystemDrive','ComSpec','PATHEXT']){const inherited=value(key);if(inherited!==undefined)env[key]=inherited}
  const drive=win32.parse(home).root.replace(/\\$/,'')
  Object.assign(env,{USERPROFILE:home,HOMEDRIVE:drive,HOMEPATH:home.slice(drive.length),APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),TEMP:temp,TMP:temp})
 }else env.TMPDIR=temp
 return env
}
export function fixtureLinkType(platform:NodeJS.Platform=process.platform):'junction'|'dir' {return platform==='win32'?'junction':'dir'}
export function fixtureClientOptions(directory:string,token:string):ClientOptions {
 return{socket_path:coordinatorEndpoint(canonicalExistingDirectory(directory)).path,admin_token:token,requiredProtocol:COOPERATION_PROTOCOL,timeout_ms:1000}
}
export interface FixtureDatabaseEvidence {messages:number;delivered_messages:number;context_deliveries:number;committed_file_mutations:number}
export function fixtureSummary(input:{completed:boolean;counts:{A:number;B:number};stored?:FixtureDatabaseEvidence;hostsStopped:boolean;daemonStopped:boolean;keepArtifacts:boolean}) {
 const stored=input.stored
 return{
  schema:'dsh-two-headless-fixture-v1',coverage:'source-linked-two-real-headless-harness-processes',
  platform:process.platform,node:process.version,harness_version:'0.2.1-rc.2',completed:input.completed,
  model_requests:{A:input.counts.A,B:input.counts.B},expected_model_requests:{A:5,B:5},
  database:stored?{messages:stored.messages,delivered_messages:stored.delivered_messages,context_deliveries:stored.context_deliveries,committed_file_mutations:stored.committed_file_mutations}:null,
  cleanup:{hosts_stopped:input.hostsStopped,daemon_stopped:input.daemonStopped},
  artifacts_retained:input.keepArtifacts||!input.completed||!input.hostsStopped||!input.daemonStopped,
 }
}
