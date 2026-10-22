import { existsSync } from 'node:fs'
import { basename, dirname, resolve, posix, win32 } from 'node:path'
import { spawnSync } from 'node:child_process'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Store } from './store.ts'
import { digest, fingerprint, secret } from './util.ts'
import { fail } from './errors.ts'
import { machineInstanceDirectory } from './config.ts'
import {initializeHostStateReservations,assertWorkspaceOutsideHostState} from './host-state.ts'
import {canonicalExistingDirectory,withinCanonical,type ResourcePathOptions} from './platform/resource-paths.ts'
import type { Config, RuntimeIdentity, SessionRow, SessionState, SessionSummary } from './types.ts'
export interface ProjectContext { project_id:string; workspace_id:string; root:string; common_dir:string|null }
/** Internal pure fixture options; profile/RPC callers cannot supply filesystem or Git adapters. */
export interface ProjectPathOptions extends ResourcePathOptions {git?:(directory:string,arg:string)=>string|null}
/** Canonical local project identity; remote URL is intentionally irrelevant. */
export function resolveProject(cwd:string, projectRoot?:string,options:ProjectPathOptions={}):ProjectContext {
  const platform=options.platform??process.platform,api=platform==='win32'?win32:posix
  const directory=canonicalExistingDirectory(cwd,options)
  const git=(arg:string):string|null=>{
    if(options.git)return options.git(directory,arg)
    const result=spawnSync('git',['--no-optional-locks','-C',directory,'rev-parse',arg],{encoding:'utf8',timeout:5000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})
    return result.status===0?result.stdout.trim():null
  }
  const top=git('--show-toplevel'),common=top?git('--git-common-dir'):null
  const selectedRoot=projectRoot===undefined?undefined:canonicalExistingDirectory(projectRoot,options)
  if(selectedRoot!==undefined&&!within(selectedRoot,directory,platform))fail('PATH_NOT_ALLOWED','Working directory is outside the explicit workspace root.')
  const root=canonicalExistingDirectory(top??selectedRoot??directory,options)
  if(selectedRoot!==undefined&&root!==selectedRoot)fail('PATH_NOT_ALLOWED','An explicit workspace root must match the resolved Git workspace; it cannot silently expand access.')
  if(!within(root,directory,platform))fail('PATH_NOT_ALLOWED','Working directory is outside the selected project root.')
  const common_dir=common?canonicalExistingDirectory(api.isAbsolute(common)?common:api.resolve(directory,common),options):null
  return {project_id:'project_'+digest(common_dir??root),workspace_id:'workspace_'+digest(root),root,common_dir}
}
export function within(root:string,path:string,platform:NodeJS.Platform=process.platform):boolean{return withinCanonical(root,path,platform)}
/** Never silently rehash pre-scheme Windows rows into a second protected domain. */
export function ensureWorkspaceIdentityScheme(store:Store,platform:NodeJS.Platform=process.platform):void {
  if(platform!=='win32')return
  const value=store.db.prepare("SELECT value FROM metadata WHERE key='windows_identity_scheme'").get()?.value
  if(value==='canonical-components-v1')return
  if(value!==undefined||store.db.prepare('SELECT 1 FROM workspaces LIMIT 1').get())fail('STORAGE_ERROR','Existing Windows workspace identities need an explicit offline migration; canonical spelling must not silently create a second collaboration domain.',{recovery_action:'Stop participating sessions, preserve the existing database/history, and use an audited identity migration. Do not delete old rows or reset the domain.'})
  store.db.prepare("INSERT INTO metadata(key,value) VALUES('windows_identity_scheme','canonical-components-v1')").run()
}
export interface RegisterRequest {session_id:string;cwd:string;project_root?:string;title?:string;task_summary?:string;expected_previous_incarnation?:string;takeover_authorized?:boolean}
/** Session ownership is an atomic logical-session CAS, independent of heartbeat presence. */
export class Identities {
  constructor(readonly store:Store, readonly config:Config){initializeHostStateReservations(store)}
  register(request:RegisterRequest):RuntimeIdentity {
    const context=resolveProject(request.cwd,request.project_root)
    const physicalDataDir=canonicalExistingDirectory(this.config.data_dir)
    if(within(context.root,physicalDataDir)||within(physicalDataDir,context.root))fail('PATH_NOT_ALLOWED','Coordinator storage and protected workspace must not overlap.')
    const machine=machineInstanceDirectory(),physicalMachine=existsSync(machine)?canonicalExistingDirectory(machine):resolve(canonicalExistingDirectory(dirname(machine)),basename(machine))
    if(within(context.root,physicalMachine)||within(physicalMachine,context.root))fail('PATH_NOT_ALLOWED','The reserved coordinator instance-control directory must remain outside protected workspaces.')
    return this.store.transaction(()=>{
      ensureWorkspaceIdentityScheme(this.store)
      assertWorkspaceOutsideHostState(this.store,context.root)
      const overlaps=this.store.db.prepare('SELECT * FROM workspaces').all() as object as {id:string;project_id:string;root:string}[]
      for(const other of overlaps)if(other.id!==context.workspace_id&&(within(other.root,context.root)||within(context.root,other.root)))fail('WORKSPACE_OVERLAP','Protected workspaces physically overlap.',{root:context.root,existing_root:other.root})
      this.store.db.prepare('INSERT OR IGNORE INTO workspaces(id,project_id,root) VALUES(?,?,?)').run(context.workspace_id,context.project_id,context.root)
      const old=this.store.db.prepare('SELECT * FROM sessions WHERE id=?').get(request.session_id) as SessionRow|undefined
      if(old){
        if(old.deleted)fail('SESSION_NOT_FOUND','Deleted sessions cannot be resumed.')
        if(old.project_id!==context.project_id||old.workspace_id!==context.workspace_id)fail('CROSS_PROJECT_DENIED','A logical session cannot change its original protected workspace.')
        if(!request.takeover_authorized&&request.expected_previous_incarnation!==old.incarnation_id)fail('STALE_INSTANCE','Session recovery requires the expected previous incarnation.')
      }else if(request.expected_previous_incarnation)fail('STALE_INSTANCE','Expected previous incarnation does not exist.')
      const token=secret();const id:RuntimeIdentity={session_id:request.session_id,incarnation_id:randomUUID(),execution_epoch:(old?.execution_epoch??0)+1,coordinator_epoch:this.store.epoch,coordinator_domain:this.store.domain,runtime_token:token}
      this.store.db.prepare(`INSERT INTO sessions(id,project_id,workspace_id,incarnation_id,execution_epoch,token_hash,title,task_summary,state,host_id,started_at,last_heartbeat_at,last_heartbeat_mono,owner_epoch)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET incarnation_id=excluded.incarnation_id,execution_epoch=excluded.execution_epoch,token_hash=excluded.token_hash,state='starting',last_heartbeat_at=excluded.last_heartbeat_at,last_heartbeat_mono=excluded.last_heartbeat_mono,owner_epoch=excluded.owner_epoch`).run(request.session_id,context.project_id,context.workspace_id,id.incarnation_id,id.execution_epoch,digest(token),request.title??'',request.task_summary??'','starting',hostname(),old?.started_at??this.store.clock.utc(),this.store.clock.utc(),this.store.clock.monotonic(),this.store.epoch)
      this.store.emitEvent({project_id:context.project_id,workspace_id:context.workspace_id,actor_session_id:request.session_id,type:old?'session.resumed':'session.registered',payload:{session_id:request.session_id,incarnation_id:id.incarnation_id}})
      return id
    })
  }
  heartbeat(identity:RuntimeIdentity):{presence:'online'} {this.store.assertIdentity(identity);this.store.db.prepare('UPDATE sessions SET last_heartbeat_at=?,last_heartbeat_mono=? WHERE id=?').run(this.store.clock.utc(),this.store.clock.monotonic(),identity.session_id);return{presence:'online'}}
  update(identity:RuntimeIdentity,state:SessionState,task_summary?:string):SessionSummary {if(!['starting','running','waiting','idle','interrupted','completed','failed'].includes(state))fail('INVALID_ARGUMENT','Unknown session state.');return this.store.transaction(()=>{const row=this.store.assertIdentity(identity);this.store.db.prepare('UPDATE sessions SET state=?,task_summary=? WHERE id=?').run(state,task_summary??row.task_summary,row.id);this.store.emitEvent({project_id:row.project_id,workspace_id:row.workspace_id,actor_session_id:row.id,type:'session.state',payload:{session_id:row.id,state}});return this.summary(this.store.session(row.id))})}
  close(identity:RuntimeIdentity,reason:SessionState='interrupted'):SessionSummary {return this.store.transaction(()=>{const value=this.update(identity,reason);this.store.db.prepare('UPDATE sessions SET last_heartbeat_mono=?,owner_epoch=0,token_hash=? WHERE id=?').run(-Number.MAX_SAFE_INTEGER,digest(secret()),identity.session_id);return{...value,presence:'offline'}})}
  summary(row:SessionRow):SessionSummary {return{id:row.id,project_id:row.project_id,workspace_id:row.workspace_id,title:row.title,task_summary:row.task_summary,state:row.state,presence:row.owner_epoch===this.store.epoch&&this.store.clock.monotonic()-row.last_heartbeat_mono<=this.config.offline_ms?'online':'offline',workspace:this.store.workspace(row.workspace_id).root,started_at:new Date(row.started_at).toISOString(),last_heartbeat_at:new Date(row.last_heartbeat_at).toISOString()}}
  list(identity:RuntimeIdentity,options:{scope?:'same_workspace'|'same_project';states?:SessionState[];include_offline?:boolean;cursor?:string;limit?:number}={}):{sessions:SessionSummary[];next_cursor:string|null} {
    const caller=this.store.assertIdentity(identity),limit=options.limit??20,scope=options.scope??'same_project'
    if(!Number.isInteger(limit)||limit<1||limit>100||!['same_project','same_workspace'].includes(scope))fail('INVALID_ARGUMENT','Invalid session listing options.')
    const filter=fingerprint({scope,states:options.states??[],include_offline:options.include_offline??false});let after=''
    if(options.cursor){const c=this.store.unsign(options.cursor);if(c.kind!=='sessions'||c.caller!==caller.id||c.filter!==filter||typeof c.after!=='string')fail('PERMISSION_REQUIRED','Listing cursor belongs to another caller or filter.');after=c.after}
    const rows=this.store.db.prepare('SELECT * FROM sessions WHERE project_id=? AND id>? AND deleted=0 ORDER BY id').all(caller.project_id,after) as object as SessionRow[]
    const sessions=rows.filter(row=>(scope!=='same_workspace'||row.workspace_id===caller.workspace_id)&&(!options.states||options.states.includes(row.state))).map(row=>this.summary(row)).filter(row=>options.include_offline||row.presence==='online')
    const page=sessions.slice(0,limit);return{sessions:page,next_cursor:sessions.length>limit?this.store.sign({kind:'sessions',caller:caller.id,filter,after:page.at(-1)!.id}):null}
  }
  status(identity:RuntimeIdentity,id:string):{session:SessionSummary;file_activity:unknown[]} {const caller=this.store.assertIdentity(identity),target=this.store.session(id);if(caller.project_id!==target.project_id)fail('CROSS_PROJECT_DENIED','Session is outside the caller project.');return{session:this.summary(target),file_activity:[]}}
}
