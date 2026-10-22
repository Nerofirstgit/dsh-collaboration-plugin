/** Pinned cooperative GUI component contract. Actual GUI/Windows acceptance is separate. */
import {createHash} from 'node:crypto'
import {isAbsolute,join,relative,resolve} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import {AgentPresetRegistry} from '@deepseek-ai/dsh-agent-preset-registry'
import {CoordinationError} from '../errors.ts'
import {GUI_ROOT_MODULES,GUI_DISABLED_ENTRIES} from './gui-profile-contract.ts'
import {ProtectedFileSystem} from './filesystem.ts'
import {CoordinationSessionPersistence} from './persistence.ts'
import {GuiConfigEditor} from './gui-config-editor.ts'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import {assertGuiSessionControllerGuard} from './gui-session-controller.ts'
import {createGuiStateRootsGuard,type GuiStateRootsGuard} from './gui-state-roots.ts'
import type {ProfileEntryEvidence} from './profile.ts'

const EDITOR='@nerofirstgit/dsh-collaboration/gui-config-editor'
const CONTROLLER_GUARD='@nerofirstgit/dsh-collaboration/gui-controller-guard'
const disabled=new Set(GUI_DISABLED_ENTRIES)
/** Fixed retained root identities. No blanket namespace/package-version authorization. */
export const GUI_PROFILE_MODULES:Readonly<Record<string,string>>=Object.freeze({
  ...Object.fromEntries(Object.entries(GUI_ROOT_MODULES).filter(([id])=>!disabled.has(id))),
  'collaboration-config-editor':EDITOR,
  'collaboration-gui-controller-guard':CONTROLLER_GUARD,
})
/** Only the producer and its non-writing prerequisites may initialize before ready.
 * Loader/pluginPackages/profileContext are provided by official app-boot outside Include.
 * No consumer waits for Loader.await() inside the producer's activation.
 */
export const GUI_BOOTSTRAP_ENTRIES:readonly string[]=Object.freeze([
  'timer','llm','session','agent','session-projection','system-prompt','tools',
  'collaboration-filesystem','session-collaboration',
])
// connection must initialize its carrier-neutral registry before fileUploads/controller.
// The actual /api carrier is attached only once webServer exists, after the guard.
export const GUI_PUBLIC_CARRIERS:readonly string[]=Object.freeze(['webserver','typert-gateway','web-runtime'])
export const GUI_PROFILE_INJECT:Readonly<Record<string,readonly string[]>>=Object.freeze(Object.fromEntries(
  Object.keys(GUI_PROFILE_MODULES).map(id=>[id,Object.freeze([
    ...(['webserver','connection','web-runtime'].includes(id)?['webStartup']:[]),
    ...(GUI_PUBLIC_CARRIERS.includes(id)?['collaborationGuiControllerReady']:[]),
    ...(id==='agent-loop'?['sessionPersistence']:[]),
    ...(GUI_BOOTSTRAP_ENTRIES.includes(id)?[]:['collaborationReady']),
  ])]),
))
export interface GuiBaseEntry {
  id:string;name:string;disabled?:boolean;config?:unknown;inject?:unknown
}
export type GuiOverlayPatch={id:string;disabled:boolean;inject?:string[];config?:Record<string,unknown>}|{insert:GuiBaseEntry[]}
export interface GuiOverlayInput {
  surface:'web'|'desktop';home:string;profile_dir:string;data_dir:string
  /** Actual official GUI dump after the current collaboration bundle was applied. */
  existing_entries:readonly GuiBaseEntry[]
}
export interface GuiInventoryEvidence {
  readonly profile:'pinned-cooperative-gui';readonly surface:'web'|'desktop';readonly host_version:'0.2.1-rc.2'
  readonly fingerprint:string;readonly entry_count:number
}
export interface GuiProfileEvidence extends GuiInventoryEvidence {
  readonly phase:'initial'|'ready'
  readonly state_roots_fingerprint:string
  readonly verification:'enabled-gui-component-contract'
  readonly full_gui_acceptance:false
}
function refuse(message:string,id?:string):never {
  throw new CoordinationError('UNMEDIATED_WRITE_DENIED',`Protected GUI profile refused: ${message}`,{...(id?{entry_id:id}:{}),recovery_action:'Use the pinned cooperative GUI overlay with concrete state paths and reviewed adapters; do not enable raw-write fallback.'})
}
function object(value:unknown):Record<string,unknown>{
  if(value===undefined)return{}
  if(value===null||typeof value!=='object'||Array.isArray(value))refuse('configuration must be an object')
  return value as Record<string,unknown>
}
function absolute(value:unknown,label:string):string{
  if(typeof value!=='string'||value.includes('\0')||!isAbsolute(value))refuse(`${label} must be an explicit absolute path, not an unresolved expression`)
  return resolve(value)
}
function inside(root:string,path:string):boolean{const part=relative(root,path);return part===''||(!isAbsolute(part)&&part!=='..'&&!part.startsWith(`..${process.platform==='win32'?'\\':'/'}`))}
function list(value:unknown):string[]{
  if(value===undefined)return[]
  if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))refuse('custom service injection/interception is unsupported')
  return value
}
function same(values:readonly string[],expected:readonly string[]):boolean{return values.length===expected.length&&new Set(values).size===values.length&&values.every(value=>expected.includes(value))}
function packageName(name:string):string{return name.split('/').slice(0,2).join('/')}
function version(name:string):string{return name==='@nerofirstgit/dsh-collaboration'?'0.1.0-dev.0':name==='@deepseek-ai/cordis-plugin-timer'?'1.1.7':'0.2.1-rc.2'}

/** Produce a persistent literal-path overlay, never mutate a running Loader or environment.
 * The collaboration bundle must already exist; only the restricted editor/controller guard and empty
 * preset are inserted when absent. Reapplying this function cannot duplicate them.
 * Rows without a config override retain their config. Official patch semantics
 * replace each overridden config object; this is a fixed initial composition,
 * not a generic merge of arbitrary user settings. Runtime checks remain required.
 */
export function buildGuiOverlay(input:GuiOverlayInput):GuiOverlayPatch[]{
  if(input.surface!=='web'&&input.surface!=='desktop')refuse('unsupported GUI surface')
  const home=absolute(input.home,'home'),profile=absolute(input.profile_dir,'profile_dir'),data=absolute(input.data_dir,'data_dir')
  if(!inside(home,profile)||home===profile)refuse('profile_dir must be a child of the selected Harness home')
  const identities:Readonly<Record<string,string>>={...GUI_ROOT_MODULES,'collaboration-config-editor':EDITOR,'collaboration-gui-controller-guard':CONTROLLER_GUARD}
  const seen=new Set<string>()
  for(const row of input.existing_entries){
    if(seen.has(row.id))refuse('duplicate base identity',row.id);seen.add(row.id)
    if(!Object.hasOwn(identities,row.id)){if(row.disabled!==true)refuse('unknown or unresolved base entry',row.id);continue}
    if(identities[row.id]!==row.name)refuse('base identity does not match the pinned module',row.id)
  }
  for(const id of Object.keys(GUI_ROOT_MODULES))if(id!=='preset-collaboration'&&!seen.has(id))refuse('expected installed GUI/collaboration base entry is missing',id)
  const configs:Record<string,Record<string,unknown>>={
    tools:{mode:'native'},'agent-loop':{agents:[]},
    'agent-preset-registry':{default:'collaboration',selectedDefault:null},
    'preset-collaboration':{id:'collaboration',plugins:[]},
    'storage-json':{root:join(home,'storages')},'storage-domain':{backend:'json',routes:{}},
    'attachment-local':{dshHome:home},credentials:{dshHome:home,path:join(home,'.credentials.yaml')},
    'session-query-sqlite':{path:':memory:',openAt:'never'},
    // The real stock controller remains enabled: both its generated RPC schema
    // and browser companion are discovered normally, without arbitrary extra packages.
    'typert-loader':{packages:[]},
    'collaboration-filesystem':{cwd:profile},'session-controller':{nativeOpen:false},
    'session-collaboration':{enabled:true,profile_mode:'gui',gui_surface:input.surface,data_dir:data,communication_policy:'explicit_only'},
    // Fixed local-only initial composition; public/TLS/CLI bind overrides are not enabled.
    webserver:{host:'127.0.0.1',port:0},
  }
  const patches:GuiOverlayPatch[]=[],insert:GuiBaseEntry[]=[]
  for(const[id,name]of Object.entries(identities)){
    if(disabled.has(id)){if(seen.has(id))patches.push({id,disabled:true});continue}
    const row={id,name,disabled:false,inject:[...GUI_PROFILE_INJECT[id]!],...(configs[id]?{config:configs[id]}:{})}
    if(seen.has(id)){const{name:_,...patch}=row;patches.push(patch)}else insert.push(row)
  }
  if(insert.length)patches.push({insert})
  return patches
}

/** Pure input validator for tests/diagnostics. Only checkActiveGuiProfile grants component evidence. */
export function checkGuiProfileInventory(entries:readonly ProfileEntryEvidence[],surface:'web'|'desktop'):GuiInventoryEvidence{
  if(surface!=='web'&&surface!=='desktop')refuse('unsupported GUI surface')
  const seen=new Set<string>(),active:ProfileEntryEvidence[]=[]
  for(const entry of entries){
    if(seen.has(entry.id))refuse('duplicate entry identity',entry.id);seen.add(entry.id)
    if(entry.disabled)continue
    active.push(entry)
    if(!Object.hasOwn(GUI_PROFILE_MODULES,entry.id)||GUI_PROFILE_MODULES[entry.id]!==entry.name)refuse('enabled entry is outside the pinned GUI composition',entry.id)
    if(entry.scoped)refuse('root service scopes/groups/interception are forbidden',entry.id)
    if(entry.package_name!==packageName(entry.name)||entry.package_version!==version(packageName(entry.name)))refuse('installed package identity/version mismatch',entry.id)
    if(!same(list(entry.inject),GUI_PROFILE_INJECT[entry.id]!))refuse('exact startup dependencies are required',entry.id)
  }
  const byId=new Map(active.map(entry=>[entry.id,entry]))
  for(const id of Object.keys(GUI_PROFILE_MODULES))if(!byId.has(id))refuse('required GUI component is missing or disabled',id)
  const at=(id:string)=>object(byId.get(id)!.config)
  if(list(at('typert-loader').packages).length)refuse('extra RPC manifest packages are not admitted')
  if(at('session-controller').nativeOpen!==false)refuse('native external-app openers are not admitted in this initial GUI composition')
  if(at('tools').mode!=='native')refuse('native managed-tool dispatch is required')
  if(!Array.isArray(at('agent-loop').agents)||(at('agent-loop').agents as unknown[]).length)refuse('declarative pre-start agents are forbidden')
  if(at('agent-preset-registry').default!=='collaboration')refuse('dedicated collaboration preset must be default')
  const selected=at('agent-preset-registry').selectedDefault
  // A real activated Volatile default is verified through registry.defaultId below.
  if(selected!==undefined&&selected!==null&&selected!=='collaboration'&&!(typeof selected==='object'&&typeof (selected as {get?:unknown}).get==='function'))refuse('selected preset default is not the dedicated preset')
  const preset=at('preset-collaboration')
  if(preset.id!=='collaboration'||!Array.isArray(preset.plugins)||preset.plugins.length||Object.keys(preset).some(key=>!['id','plugins'].includes(key)))refuse('only the empty inheriting collaboration preset is supported')
  if(at('session-query-sqlite').path!==':memory:'||at('session-query-sqlite').openAt!=='never')refuse('writing session-query indexes are not admitted')
  absolute(at('storage-json').root,'storage-json.root');absolute(at('attachment-local').dshHome,'attachment-local.dshHome')
  absolute(at('credentials').dshHome,'credentials.dshHome');absolute(at('credentials').path,'credentials.path')
  const domain=at('storage-domain')
  if(domain.backend!=='json'||Object.values(object(domain.routes)).some(value=>value!=='json'))refuse('only reviewed JSON storage routes are supported')
  const collaboration=at('session-collaboration')
  if(collaboration.enabled!==true||collaboration.profile_mode!=='gui'||collaboration.gui_surface!==surface)refuse('GUI collaboration must be explicitly enabled for the actual surface')
  absolute(collaboration.data_dir,'collaboration.data_dir')
  if(at('webserver').host!=='127.0.0.1'||at('webserver').port!==0)refuse('initial GUI composition requires a local-only ephemeral webserver')
  const fingerprint=createHash('sha256').update(JSON.stringify(active.map(entry=>({id:entry.id,name:entry.name,version:entry.package_version,inject:GUI_PROFILE_INJECT[entry.id]})).sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex')
  return Object.freeze({profile:'pinned-cooperative-gui',surface,host_version:'0.2.1-rc.2',entry_count:active.length,fingerprint})
}
const stateGuards=new WeakMap<Context,GuiStateRootsGuard>()
/** Obtain only the guard already established from the real profile, never caller-supplied paths. */
export function guiStateRootsGuard(ctx:Context):GuiStateRootsGuard{
  const guard=stateGuards.get(ctx.root);if(!guard)refuse('GUI state roots have not passed the active profile checker')
  guard.assertUnchanged();return guard
}
function hasScope(value:unknown):boolean{return value!==undefined&&value!==null&&(typeof value!=='object'||Object.keys(value).length>0)}
/** Validate actual Loader topology, installed packages, actual provider classes and retained presets.
 * Initial inspection runs before publishing collaborationReady. Every managed boundary
 * reruns this check, at which time real editor and preset services must exist.
 * This is not proof of a booted GUI, native Windows I/O or whole-feature acceptance.
 */
export function checkActiveGuiProfile(ctx:Context):GuiProfileEvidence{
  const loader=ctx.get('loader'),packages=ctx.get('pluginPackages'),profile=ctx.get('profileContext')
  if(!loader||!packages||!profile)refuse('actual Loader, package inventory and profileContext are required')
  if(profile.name!=='web'&&profile.name!=='desktop')refuse('actual launcher profile must be web or desktop')
  if(!(ctx.get('fs') instanceof ProtectedFileSystem))refuse('actual filesystem provider is not ProtectedFileSystem')
  if(!(ctx.get('sessionPersistence') instanceof CoordinationSessionPersistence))refuse('actual session persistence is not CoordinationSessionPersistence')
  const entries=[...loader.entries()],roots=entries.filter(entry=>entry.options.id==='include'&&entry.options.name==='cordis:include'&&!entry.disabled)
  if(roots.length!==1||roots[0]!.parent!==loader.root||!roots[0]!.subtree)refuse('expected one official root Include')
  const include=roots[0]!,rows:ProfileEntryEvidence[]=[]
  const includeOptions=include.options as unknown as Record<string,unknown>
  if(Boolean(includeOptions.group)||hasScope(includeOptions.isolate)||hasScope(includeOptions.intercept)||list(includeOptions.inject).length)refuse('root Include scopes or custom dependencies are forbidden')
  for(const entry of entries){
    if(entry===include)continue
    const options=entry.options as unknown as Record<string,unknown>,baseUrl=entry.ctx.baseUrl
    if(!baseUrl&&!entry.disabled)refuse('enabled entry has no module-resolution base',entry.options.id)
    const pkg=entry.disabled?undefined:packages.packageOf(entry.options.name,baseUrl!)
    rows.push({id:entry.options.id,name:entry.options.name,disabled:entry.disabled,package_name:pkg?.name,package_version:pkg?.version,
      scoped:entry.parent.tree!==include.subtree||Boolean(entry.subgroup)||Boolean(entry.subtree)||Boolean(options.group)||hasScope(options.isolate)||hasScope(options.intercept),
      config:entry.fiber?.config??entry.options.config,inject:entry.options.inject})
  }
  const evidence=checkGuiProfileInventory(rows,profile.name),readiness=ctx.get('collaborationReady'),ready=readiness!==undefined
  if(ready&&readiness.ready!==true)refuse('readiness service must be explicitly ready')
  const controller=ctx.get('sessionController')
  if((ready||controller!==undefined)&&!(controller instanceof SessionController))refuse('actual pinned session controller is required after readiness')
  // Stock browser/schema identity is retained. Never authorize execution merely
  // from a claimed readiness flag: assert the installed owned live method wrapper.
  if(ready)assertGuiSessionControllerGuard(ctx)
  const jobs=ctx.get('jobs')
  if((ready||jobs!==undefined)&&!(jobs instanceof LocalJobRegistry))refuse('actual pinned jobs registry is required for Desktop lifecycle inspection')
  const editor=ctx.get('configEditor')
  if((ready||editor!==undefined)&&!(editor instanceof GuiConfigEditor))refuse('the actual restricted GUI ConfigEditor is required after readiness')
  const registry=ctx.get('agentPresets')
  if(ready||registry!==undefined){
    if(!(registry instanceof AgentPresetRegistry))refuse('the actual pinned AgentPresetRegistry is required after readiness')
    if(registry.defaultId!=='collaboration')refuse('actual registry default is not collaboration')
    const compositions=registry.inspectCompositions()
    if((ready&&compositions.length!==1)||compositions.some(row=>row.id!=='collaboration'||row.modules.length!==0||row.leakedServices.length!==0))refuse('actual preset revisions must contain only the empty collaboration composition')
  }
  // Cache only after the other checks succeeded. Changes require a fresh startup;
  // repeated inspections must not silently bless relocated credentials/storage.
  let guard=stateGuards.get(ctx.root)
  if(guard)guard.assertUnchanged();else guard=createGuiStateRootsGuard(ctx)
  if(ready&&(readiness.gui?.state_fingerprint!==guard.evidence.fingerprint||typeof readiness.gui.assertWorkspacePathAllowed!=='function'))refuse('GUI readiness is not tied to the verified state roots')
  stateGuards.set(ctx.root,guard)
  return Object.freeze({...evidence,phase:ready?'ready':'initial',state_roots_fingerprint:guard.evidence.fingerprint,verification:'enabled-gui-component-contract',full_gui_acceptance:false})
}
