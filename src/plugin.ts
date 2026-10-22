/** Installable Cordis adapter. Only a verified enabled host composition may write. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition,ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-approval'
import { resolve } from 'node:path'
import { connectCoordinator } from './bootstrap.ts'
import {CoordinatorClient} from './client.ts'
import { writerCapabilities } from './writer.ts'
import { resolveConfig } from './config.ts'
import type { Config as CoordinatorConfig,RuntimeIdentity } from './types.ts'
import { CoordinationError,ERROR_CODES,failure,success } from './errors.ts'
import type { ErrorCode,Result } from './errors.ts'
import { record,string,integer } from './util.ts'
import { CoordinationSessionPersistence } from './host/persistence.ts'
import type { HostCoordinatorTransport } from './host/persistence.ts'
import { applyHostRuntime } from './host/runtime.ts'
import { mountClaimManager } from './host/claims.ts'
import { renameClaimGroup } from './host/claim-mapping.ts'
import type { ManagedClaim } from './host/claims.ts'
import { checkActiveProfile } from './host/profile.ts'
import type { ProfileEvidence } from './host/profile.ts'
import {checkActiveGuiProfile,guiStateRootsGuard,type GuiProfileEvidence} from './host/gui-profile.ts'
import {createGuiSessionAdmission} from './host/gui-admission.ts'

import type {} from './host/readiness.ts'
export interface PluginConfig extends Partial<CoordinatorConfig> {workspace_root?:string;read_limit_lines?:number;read_output_bytes?:number;profile_mode?:'headless'|'gui';gui_surface?:'web'|'desktop'}
export const name='session-collaboration'
export const inject=['tools','sessions','agents','sessionProjections','fs','loader','pluginPackages']
export const Config:z<PluginConfig>=z.object({
  enabled:z.boolean().default(true),workspace_root:z.string(),data_dir:z.string(),profile_mode:z.union(['headless','gui']).default('headless'),gui_surface:z.union(['web','desktop']),
  communication_policy:z.union(['explicit_only','same_project_enabled']).default('explicit_only'),
  heartbeat_ms:z.number().default(10000),offline_ms:z.number().default(45000),lease_ttl_ms:z.number().default(60000),auto_renew:z.boolean().default(true),
  message_limit_bytes:z.number().default(8192),mailbox_limit_bytes:z.number().default(10485760),injection_budget:z.number().default(2000),
  fragment_bytes:z.number().default(512),max_snapshot_items:z.number().default(10000),event_retention_ms:z.number().default(604800000),snapshot_ttl_ms:z.number().default(60000),max_read_bytes:z.number().default(1048576),
  read_limit_lines:z.number().default(200),read_output_bytes:z.number().default(16384),
})
const output:ToolDefinition['output']={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]}
const s=(description:string,required=false)=>({type:'string',description,...required?{required:true}:{}})
const n=(description:string)=>({type:'integer',description})
const list=(description:string)=>({type:'array',items:{type:'string'},description})
interface Receipt {version:string;read_token:string;truncated:boolean;content:string;byte_range:{start:number;end:number}}
/** The only model-visible entrypoint is a normal dsh plugin loaded by a profile. */
export async function apply(ctx:Context,input:PluginConfig={}):Promise<void>{
  if(input.enabled===false)throw new CoordinationError('UNMEDIATED_WRITE_DENIED','This bundle replaces the host filesystem and persistence services. Stop this profile and deselect the complete bundle to disable it; a partial config toggle is not a runnable profile. Disabled-plugin collaboration is outside the supported guarantee.')
  const config=resolveConfig(input),client=await connectCoordinator(config)
  ctx.effect(()=>()=>client.close())
  await mount(ctx,client,input,()=>input.profile_mode==='gui'?checkActiveGuiProfile(ctx):checkActiveProfile(ctx))
}
/** Explicit composition helper for host component tests; production always uses the original private Node IPC transport. */
export function applyWithClient(ctx:Context,client:HostCoordinatorTransport,input:PluginConfig={}):void|Promise<void> {
  return mount(ctx,client,input,input.profile_mode==='gui'?()=>checkActiveGuiProfile(ctx):ctx.get('loader')?()=>checkActiveProfile(ctx):undefined)
}
type EnabledProfileEvidence=ProfileEvidence|GuiProfileEvidence
function mount(ctx:Context,client:HostCoordinatorTransport,input:PluginConfig,profileChecker?:(()=>EnabledProfileEvidence)):void|Promise<void> {
  if(input.profile_mode!==undefined&&!['headless','gui'].includes(input.profile_mode))throw new CoordinationError('INVALID_ARGUMENT','Unknown collaboration host profile mode.')
  const gui=input.profile_mode==='gui'
  if(gui&&input.gui_surface!=='web'&&input.gui_surface!=='desktop')throw new CoordinationError('INVALID_ARGUMENT','GUI mode requires the explicit web or desktop host surface.')
  let admissionComplete=false,disposed=false
  ctx.effect(()=>()=>{disposed=true;admissionComplete=false})
  const config=resolveConfig(input),workspaceRoot=input.workspace_root===undefined?undefined:resolve(input.workspace_root)
  const readLines=integer(input.read_limit_lines??200,'read_limit_lines',1,10000),readBytes=integer(input.read_output_bytes??16384,'read_output_bytes',128,1048576)
  const persistence=new CoordinationSessionPersistence(ctx,client,{workspaceRoot,...gui?{admitSession:request=>{
    if(!admissionComplete)throw new CoordinationError('UNMEDIATED_WRITE_DENIED','GUI startup has not reserved its host-state roots yet.')
    // Recheck the actual live controller guard too: its fiber can stop while a
    // previously admitted stock create is awaiting mkdir/workspace preparation.
    verifyProfile()
    createGuiSessionAdmission(guiStateRootsGuard(ctx))(request)
  }}:{}})
  const runtime=applyHostRuntime(ctx,client,persistence,{heartbeatMs:config.heartbeat_ms,injectionBudget:config.injection_budget})
  const receipts=new Map<string,Receipt>(),owned=new Set<ToolDefinition>()
  const claims=mountClaimManager(ctx,client,{autoRenew:config.auto_renew,heartbeatMs:config.heartbeat_ms,leaseTtlMs:config.lease_ttl_ms,identityFor(id){const agent=ctx.agents.get(SessionId(id));if(!agent)throw new CoordinationError('STALE_INSTANCE','The claim owner is no longer active.');return runtime.identity(agent)},onError(id,error){ctx.logger.warn(`Collaboration lease renewal paused for ${id}: ${error instanceof Error?error.message:String(error)}`)}})
  let profile:EnabledProfileEvidence|undefined
  function verifyProfile(startup=false):void {
    if(disposed||gui&&!startup&&!admissionComplete)throw new CoordinationError('UNMEDIATED_WRITE_DENIED','The collaboration profile is not ready or has stopped.')
    if(!profileChecker)return
    const current=profileChecker()
    if(gui&&(current.profile!=='pinned-cooperative-gui'||current.surface!==input.gui_surface))throw new CoordinationError('UNMEDIATED_WRITE_DENIED','Configured GUI surface differs from the actual launcher.')
    if(profile&&profile.fingerprint!==current.fingerprint)throw new CoordinationError('UNMEDIATED_WRITE_DENIED','The enabled profile changed after verification. Restart the audited composition before continuing.')
    profile=current
  }
  const key=(id:RuntimeIdentity,path:string)=>id.session_id+'\0'+path
  function identity(exec:ToolRunContext):RuntimeIdentity {if(!exec.agent)throw new CoordinationError('STALE_INSTANCE','This tool requires an active host session.');return runtime.identity(exec.agent)}
  async function writable<T>(exec:ToolRunContext,run:()=>Promise<T>):Promise<T> {
    verifyProfile()
    if(!profile||!admissionComplete)throw new CoordinationError('UNMEDIATED_WRITE_DENIED','Managed writes require a verified pinned host profile and completed startup admission. This component composition alone does not prove enabled workspace protection.',{recovery_action:'Use the complete reviewed composition and restart. Do not enable raw filesystem, shell, MCP or plugin fallbacks.'})
    identity(exec);return run()
  }
  function tool(toolName:string,description:string,parameters:Record<string,unknown>,run:(args:Record<string,unknown>,exec:ToolRunContext)=>Promise<unknown>):void {
    const definition:ToolDefinition={name:toolName,description,parameters,output,
      async execute(args,exec){const requestId=runtime.operationId(exec);try{exec.signal.throwIfAborted();return success(await run(record(args),exec),requestId)}catch(error){const result=failure(error,requestId);throw new HarnessError(JSON.stringify(result),result.error!.code)}},
      finalizeContent(exec,result){if(!result.isError)return;let body:Result<never>;try{const parsed=record(JSON.parse(result.error.message));if(parsed.status==='error'&&parsed.request_id)return[{type:'text',text:JSON.stringify(parsed)}]}catch(error){/* Registry policy failures also receive the stable public error envelope. */}const code=ERROR_CODES.includes(result.error.info?.code as ErrorCode)?result.error.info!.code as ErrorCode:'UNMEDIATED_WRITE_DENIED';body=failure(new CoordinationError(code,result.error.message),String(exec.callId));return[{type:'text',text:JSON.stringify(body)}]},
      presentCall:args=>({card:'generic',title:toolName,rawInput:args}),
    };owned.add(definition);ctx.tools.register(definition)
  }
  const rpc=(method:string)=>(args:Record<string,unknown>,exec:ToolRunContext)=>client.call(method,args,identity(exec))
  tool('session_list_sessions','Discover project sessions without revealing private conversations.',{scope:{type:'string',enum:['same_workspace','same_project']},states:list('Session state filters'),include_offline:{type:'boolean'},cursor:s('Caller-bound cursor'),limit:n('1–100; default 20')},rpc('list_sessions'))
  tool('session_get_session_status','Read a same-project session summary and managed file activity.',{session_id:s('Discovered logical session ID',true)},rpc('get_session_status'))
  tool('session_send_message','Send durable coordination data, not a task or human instruction. Idle recipients are not awakened. Human communication authorization is required.',{to_session_id:s('Discovered recipient session ID',true),body:s('Exact message, at most configured 8 KiB',true),related_paths:list('Paths relative to this source workspace'),in_reply_to:s('Visible prior message ID'),idempotency_key:s('Stable key for this logical message; reuse on retry',true)},async(args,exec)=>{
    const id=identity(exec)
    try{return await client.call('send_message',args,id)}catch(error){if(!(error instanceof CoordinationError)||error.code!=='PERMISSION_REQUIRED')throw error}
    const approval=ctx.get('approval')
    if(!approval||!exec.agent)throw new CoordinationError('PERMISSION_REQUIRED','Human communication authorization is required and no approval answerer is available.')
    const recipient=string(args.to_session_id,'to_session_id'),messageKey=string(args.idempotency_key,'idempotency_key')
    const decision=await approval.request({agent:exec.agent,toolName:exec.name,callId:exec.callId,signal:exec.signal,reason:`Allow this one coordination message and its eventual delivery/read/acknowledgment to session ${recipient}? This does not authorize tasks, conversation history or control, nor future messages.`})
    if(decision!=='allowed-once')throw new CoordinationError('PERMISSION_REQUIRED','The human did not authorize this coordination message.')
    await ctx.sessions.flush(exec.agent.session)
    const status=record(await client.call('get_session_status',{session_id:id.session_id},id)),self=record(status.session)
    await client.call('grant_communication',{project_id:self.project_id,grant_id:'human-message:'+id.session_id+':'+runtime.operationId(exec),from_session_id:id.session_id,to_session_id:recipient,idempotency_key:messageKey},id)
    return client.call('send_message',args,id)
  })
  tool('session_get_message_status','Read delivered/acknowledged/resolved as separate facts.',{message_id:s('Message ID',true)},rpc('get_message_status'))
  tool('session_read_message','Retrieve bounded authorized message text without consuming automatic delivery.',{message_id:s('Message ID',true),cursor:s('Caller-bound body cursor'),max_tokens:n('1–2000 conservative tokens; default 1000. Fails if metadata framing cannot fit.')},rpc('read_message'))
  tool('session_mark_message_handled','Explicitly acknowledge or resolve a received message; never grants other actions.',{message_id:s('Message ID',true),action:{type:'string',enum:['acknowledge','resolve'],required:true},resolution:s('Required nonempty conclusion when resolving')},rpc('mark_message_handled'))
  tool('session_poll_events','Query visible events independently of automatic context delivery.',{cursor:s('Bound event cursor'),limit:n('1–100; default 20'),wait_ms:n('0–30000'),scope:{type:'string',enum:['same_workspace','same_project']}},rpc('poll_events'))
  tool('session_get_coordination_snapshot','Read a consistent paged collaboration snapshot and its event watermark.',{cursor:s('Snapshot continuation'),limit:n('1–100; default 20'),scope:{type:'string',enum:['same_workspace','same_project']}},rpc('get_coordination_snapshot'))
  tool('session_collaboration_status','Show actual enabled-profile verification and incomplete acceptance status.',{},async()=>({enabled:true,host_version:'0.2.1-rc.2',write_protection:profile?'verified-enabled-profile-component-contract':'unsupported-unverified-profile',profile:profile??null,platform:process.platform,cooperation_scope:'participating-enabled-dsh-sessions',external_program_prevention:false,writer_capabilities:writerCapabilities(),gui_integration:gui?'enabled-component-candidate-native-acceptance-pending':'not-selected',communication_policy:config.communication_policy,limitations:['Full two-process P0 acceptance is not complete.','Only audited enabled participants are covered; unmediated tools are denied. Native Windows and real GUI acceptance remain pending.','Disabled plugins, human external processes and arbitrary installed host code are outside this guarantee.']}))
  tool('claim_files','Atomically claim all listed ordinary files; nonblocking and never a content-version guarantee.',{paths:{...list('Workspace-relative ordinary files'),required:true},purpose:s('Why this task needs the files',true),request_id:s('Stable idempotency ID',true),ttl_ms:n('Lease TTL')},async(args,exec)=>writable(exec,async()=>{const id=identity(exec);try{const result=record(await client.call('claim_files',args,id));if(Array.isArray(result.claims))claims.record(id,result.claims as ManagedClaim[],{ttlMs:args.ttl_ms===undefined?config.lease_ttl_ms:integer(args.ttl_ms,'ttl_ms',1,3600000)});return result}catch(error){if(error instanceof CoordinationError&&error.code==='FILE_BUSY')claims.conflict(id.session_id);throw error}}))
  tool('release_files','Release current owned claims; does not reset fencing counters.',{lease_ids:{...list('Opaque lease IDs'),required:true},request_id:s('Stable idempotency ID',true)},async(args,exec)=>writable(exec,async()=>{const id=identity(exec),result=await client.call('release_files',args,id);if(Array.isArray(args.lease_ids))claims.forget(id.session_id,args.lease_ids as string[]);return result}))
  tool('read','Read exact UTF-8 file bytes with full SHA-256 and a receipt for the displayed range. A truncated read cannot authorize whole-file replacement. For a long line, continue at the returned byte_range.end using byte_start/byte_end instead of line offsets.',{file_path:s('Workspace-relative ordinary text file',true),offset:n('1-based first line; default 1'),limit:n('Maximum lines; default 200'),byte_start:n('Optional inclusive byte offset; requires byte_end, excludes offset/limit'),byte_end:n('Optional exclusive byte offset; requires byte_start, excludes offset/limit')},async(args,exec)=>{
    const id=identity(exec),path=string(args.file_path,'file_path'),byteMode=args.byte_start!==undefined||args.byte_end!==undefined
    if(byteMode&&(args.offset!==undefined||args.limit!==undefined))throw new CoordinationError('INVALID_ARGUMENT','Choose either line offsets or byte range, not both.')
    const range=byteMode?{range:{start:integer(args.byte_start,'byte_start',0,Number.MAX_SAFE_INTEGER),end:integer(args.byte_end,'byte_end',0,Number.MAX_SAFE_INTEGER)}}:{line_range:{offset:args.offset??1,limit:args.limit??readLines}}
    const result=record(await client.call('read_file',{path,...range,max_bytes:readBytes},id))
    const receipt=result as object as Receipt;receipts.set(key(id,path),receipt);return result
  })
  async function lease(exec:ToolRunContext,path:string):Promise<ManagedClaim>{const id=identity(exec);try{const result=record(await client.call('claim_files',{paths:[path],purpose:'Managed file tool',request_id:runtime.operationId(exec)+':claim'},id));if(!Array.isArray(result.claims)||!result.claims[0])throw new CoordinationError('STORAGE_ERROR','Claim result lacks its lease.');const value=record(result.claims[0]) as object as ManagedClaim;if(value.active===false)throw new CoordinationError('LEASE_EXPIRED','The original implicit claim is no longer active; do not replay its unknown mutation.');claims.record(id,[value],{explicit:false});return value}catch(error){if(error instanceof CoordinationError&&error.code==='FILE_BUSY')claims.conflict(id.session_id);throw error}}
  async function change(exec:ToolRunContext,path:string,fields:Record<string,unknown>):Promise<unknown>{return writable(exec,async()=>{
    const id=identity(exec)
    if(fields.operation==='rename'){
      const target=string(fields.target_path,'target_path')
      let result:Record<string,unknown>
      try{result=record(await client.call('claim_files',{paths:[path,target],purpose:'Managed ordinary-file rename',request_id:runtime.operationId(exec)+':claim'},id))}catch(error){if(error instanceof CoordinationError&&error.code==='FILE_BUSY')claims.conflict(id.session_id);throw error}
      const {group,source,destination}=renameClaimGroup(result,path,target)
      claims.record(id,group,{explicit:false})
      return client.call('apply_file_change',{path,...fields,lease_id:source.lease_id,coordinator_epoch:source.coordinator_epoch,fencing_token:source.fencing_token,target_lease_id:destination.lease_id,target_fencing_token:destination.fencing_token,mutation_id:runtime.operationId(exec)},id)
    }
    const claim=await lease(exec,path);return client.call('apply_file_change',{path,...fields,lease_id:claim.lease_id,coordinator_epoch:claim.coordinator_epoch,fencing_token:claim.fencing_token,mutation_id:runtime.operationId(exec)},id)
  })}
  tool('write','Create or replace an ordinary UTF-8 file through the trusted writer. Existing files require a complete prior read. An unverified enabled profile fails closed.',{file_path:s('Workspace-relative file',true),content:s('Complete new content',true)},async(args,exec)=>{const path=string(args.file_path,'file_path'),receipt=receipts.get(key(identity(exec),path));if(receipt?.truncated)throw new CoordinationError('READ_REQUIRED','A partial display cannot authorize whole-file replacement.');return change(exec,path,{operation:receipt?'replace':'create',expected_version:receipt?.version??null,...receipt?{read_token:receipt.read_token}:{},content:args.content})})
  tool('edit','Apply one exact unique literal edit within the prior displayed bytes; never fuzzy-matches or blindly overwrites.',{file_path:s('Workspace-relative file',true),old_string:s('Exact unique old text',true),new_string:s('Replacement text',true)},async(args,exec)=>{const path=string(args.file_path,'file_path'),receipt=receipts.get(key(identity(exec),path));if(!receipt)throw new CoordinationError('READ_REQUIRED','Read the file region before editing.');const old=string(args.old_string,'old_string'),at=receipt.content.indexOf(old);if(at<0||receipt.content.indexOf(old,at+1)>=0)throw new CoordinationError('PATCH_PRECONDITION_FAILED','Old text must appear exactly once in the displayed region.');return change(exec,path,{operation:'patch',expected_version:receipt.version,read_token:receipt.read_token,patch:{start:receipt.byte_range.start+Buffer.byteLength(receipt.content.slice(0,at)),old_text:old,new_text:args.new_string}})})
  tool('rename','Move one ordinary file atomically within this filesystem without overwriting a destination. Requires a prior source read and explicit absent-target precondition; no directory or copy/delete fallback.',{file_path:s('Workspace-relative source file',true),target_path:s('Workspace-relative absent destination',true),expected_target_version:{type:'null',required:true}},async(args,exec)=>{const path=string(args.file_path,'file_path'),receipt=receipts.get(key(identity(exec),path));if(!receipt)throw new CoordinationError('READ_REQUIRED','Read the source before renaming.');return change(exec,path,{operation:'rename',target_path:args.target_path,expected_target_version:args.expected_target_version,expected_version:receipt.version,read_token:receipt.read_token})})
  tool('apply_file_change','Managed create/replace/strict byte patch/delete/no-overwrite rename. Runtime supplies stable mutation identity and current claimed credentials.',{path:s('Workspace-relative file',true),operation:{type:'string',enum:['create','replace','patch','delete','rename'],required:true},expected_version:{oneOf:[{type:'string'},{type:'null'}],required:true},read_token:s('Receipt from read'),target_path:s('Destination for ordinary rename'),expected_target_version:{type:'null',description:'Required explicit null for rename; overwrite is not supported'},content:s('UTF-8 content for create/replace'),patch:{type:'object',properties:{start:{type:'integer',required:true},old_text:s('Exact old bytes as text',true),new_text:s('Replacement',true)}}},async(args,exec)=>{const path=string(args.path,'path'),fields={...args};delete fields.path;return change(exec,path,fields)})
  tool('get_mutation_status','Inspect the original operation after a timeout/restart; never replay an unknown mutation under a new ID.',{mutation_id:s('Original mutation ID',true)},rpc('get_mutation_status'))
  ctx.on('agent/created',({agent})=>{agent.ctx.tools.restrict({allow:[...owned].map(t=>t.name)});return undefined})
  ctx.tools.guard(exec=>owned.has(ctx.tools.get(exec.name,exec.agent)!)?undefined:'UNMEDIATED_WRITE_DENIED: this profile permits only its audited coordination/read/managed-write definitions; shell, MCP, dynamic plugins and alternate tools are not authorized.')
  // The host resolves the actual definition again after awaited around-dispatch
  // hooks. Recheck after our persistence/RPC awaits, with no yielding gap before
  // the pinned dispatch body. Unknown late around-dispatch hooks are unsupported.
  ctx.on('tools/execute',(exec,next)=>{verifyProfile();if(!owned.has(ctx.tools.get(exec.name,exec.agent)!))throw new HarnessError('Tool definition changed after admission; refusing unmediated dispatch.','UNMEDIATED_WRITE_DENIED');return next()})
  ctx.on('agent/pre-step',(_request,next)=>{verifyProfile();return next()})
  ctx.on('llm/stream',(_request,next)=>{verifyProfile();return next()})
  ctx.on('agent/disposed',({agent})=>{for(const k of receipts.keys())if(k.startsWith(agent.id+'\0'))receipts.delete(k)})
  verifyProfile(true)
  function publishReady():void {
    if(disposed)throw new CoordinationError('COORDINATOR_UNAVAILABLE','The profile stopped during startup admission.')
    verifyProfile(true)
    const guard=gui?guiStateRootsGuard(ctx):undefined
    admissionComplete=true
    try{ctx.provide('collaborationReady',{ready:true,...guard?{gui:{state_fingerprint:guard.evidence.fingerprint,assertWorkspacePathAllowed:(path:string)=>guard.assertWorkspacePathAllowed(path)}}:{}})}catch(error){admissionComplete=false;throw error}
  }
  if(gui){
    const guard=guiStateRootsGuard(ctx),root=guard.evidence.home
    // State providers and UI consumers are blocked on readiness. Reserve their
    // state domain against EVERY participating profile, not only local sessions.
    // Production retains and re-establishes the reservation on every transport generation.
    // In-process component transports exercise the same coordinator RPC explicitly.
    const reservation=client instanceof CoordinatorClient?client.ensureHostStateRoots([root]):client.call('reserve_host_state_roots',{roots:[root]})
    return reservation.then(value=>{
      const roots=record(value).roots
      if(!Array.isArray(roots)||roots.length!==1||roots[0]!==root)throw new CoordinationError('STORAGE_ERROR','Coordinator did not confirm the exact GUI host-state root reservation. Restart compatible components; no UI state writer was admitted.')
      guard.assertUnchanged();publishReady()
    })
  }
  publishReady()
}
