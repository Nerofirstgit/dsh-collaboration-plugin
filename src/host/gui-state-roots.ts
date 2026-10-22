/**
 * Filesystem write destinations of the pinned GUI's retained state providers.
 * Source pin: deepseek-harness 687f282e8625c6b8d11ff58211a90524be2e4317.
 *
 * This is a location/admission check, NOT proof of provider identity, Loader
 * topology, or startup ordering. The GUI assembly must check those separately
 * and gate state providers before their first constructor/init write. Pending
 * fibers' resolved config is usable; unresolved !!js expressions are refused.
 */
import {createHash} from 'node:crypto'
import {lstatSync} from 'node:fs'
import {homedir} from 'node:os'
import {basename,dirname,isAbsolute,join,resolve} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {ProfileContext} from '@deepseek-ai/dsh-app-boot'
import type {Entry} from '@deepseek-ai/cordis-plugin-loader'
import {CoordinationError} from '../errors.ts'
import {canonicalExistingDirectory,resolveResourcePath,withinCanonical} from '../platform/resource-paths.ts'

export interface GuiStateRoot {
  readonly id:string
  /** A whole directory is reserved, including atomic-write/SQLite siblings. */
  readonly path:string
  readonly providers:readonly string[]
}
export interface GuiStateRootsEvidence {
  readonly schema:'gui-state-roots-v1'
  readonly home:string
  readonly profile_root:string
  readonly profile_patch:string
  readonly storage_root:string
  readonly attachment_root:string
  readonly attachment_cache_root:string
  readonly credentials_file:string
  readonly query_database:string|null
  readonly roots:readonly GuiStateRoot[]
  readonly fingerprint:string
}
export interface GuiSessionLocation {
  readonly cwd:string
  /** Trusted resolveProject(...).root, NOT a model-supplied narrowed cwd. */
  readonly workspace_root:string
}
export interface GuiStateRootsGuard {
  readonly evidence:GuiStateRootsEvidence
  /** Re-derive destinations from current actual Loader/profile state. */
  assertUnchanged():void
  /** Must run before canonical coordinator session create/write-open. */
  assertSessionAllowed(location:GuiSessionLocation):void
  /** For explicit human workspace setup, BEFORE its mkdir. No mkdir here. */
  assertWorkspacePathAllowed(path:string):string
}

function refuse(message:string):never {
  throw new CoordinationError('UNMEDIATED_WRITE_DENIED',message,{
    recovery_action:'Keep Harness state outside every protected workspace; correct concrete GUI provider paths and restart the reviewed profile before admitting sessions.',
  })
}
function record(value:unknown,label:string):Record<string,unknown> {
  if(value===undefined)return{}
  if(typeof value!=='object'||value===null||Array.isArray(value))refuse(`${label} requires a resolved configuration object.`)
  return value as Record<string,unknown>
}
function string(value:unknown,label:string):string {
  if(typeof value!=='string'||!value||!value.isWellFormed()||value.includes('\0'))refuse(`${label} requires a concrete nonempty path/value; unresolved expressions are not accepted.`)
  return value
}
function absolute(value:unknown,label:string):string {
  const path=string(value,label)
  if(!isAbsolute(path))refuse(`${label} must be an absolute launcher-owned path.`)
  return resolve(path)
}

/**
 * A missing suffix is only planned under a canonical existing directory.
 * No directory is created. Existing directory aliases are resolved using the
 * same canonical-component policy as managed workspace/resource admission.
 * Existing files use their canonical parent + ordinary final leaf; a symlink
 * file or a file-as-parent is refused rather than assumed to be a directory.
 */
function canonicalPlanned(path:string,kind:'directory'|'file'):string {
  const missing:string[]=[]
  let current=path
  for(let depth=0;depth<256;depth++){
    let info:ReturnType<typeof lstatSync>
    try{info=lstatSync(current)}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
      const parent=dirname(current)
      if(parent===current)refuse('No existing ancestor is available for a GUI state location.')
      missing.unshift(basename(current));current=parent;continue
    }
    if(missing.length>0||kind==='directory'){
      // canonicalExistingDirectory also proves that a symlink target is a directory.
      const parent=canonicalExistingDirectory(current)
      return join(parent,...missing)
    }
    if(!info.isFile())refuse('A configured GUI state filename must be an ordinary file, not a link or special entry.')
    const parent=canonicalExistingDirectory(dirname(current))
    return resolveResourcePath(parent,basename(current)).path
  }
  return refuse('GUI state path has too many components.')
}
function planned(value:unknown,kind:'directory'|'file',label:string):string {
  try{return canonicalPlanned(resolve(string(value,label)),kind)}catch(error){
    if(error instanceof CoordinationError&&error.code==='UNMEDIATED_WRITE_DENIED')throw error
    return refuse(`Cannot completely canonicalize ${label} using an existing ordinary directory ancestor.`)
  }
}
function existingDirectory(value:unknown,label:string):string {
  try{return canonicalExistingDirectory(absolute(value,label))}catch(error){
    if(error instanceof CoordinationError&&error.code==='UNMEDIATED_WRITE_DENIED')throw error
    return refuse(`${label} must be an existing canonical local directory.`)
  }
}
function contains(root:string,path:string,label:string):void {
  if(!withinCanonical(root,path))refuse(`${label} must remain inside the selected Harness state directory.`)
}

/** Mirrors home-paths/src/index.ts resolveRoot/resolveDshHome exactly for these providers. */
function providerHome(value:unknown):string {
  const configured=value===undefined?undefined:string(value,'provider dshHome')
  const environment=process.env.DSH_HOME
  let selected=configured??(environment!==undefined&&environment.trim().length>0?environment:join(homedir(),'.dsh'))
  if(selected==='~')selected=homedir()
  else if(selected.startsWith('~/')||selected.startsWith('~\\'))selected=join(homedir(),selected.slice(2))
  return planned(resolve(selected),'directory','provider dshHome')
}
function config(entries:readonly Entry[],id:string,name:string):Record<string,unknown> {
  const matches=entries.filter(entry=>entry.options.id===id&&!entry.disabled)
  if(matches.length!==1||matches[0]!.options.name!==name)refuse(`Expected one enabled pinned ${id} state provider.`)
  // No ACTIVE requirement: GUI readiness must run while state writers are pending.
  const entry=matches[0]!
  return record(entry.fiber?.config??entry.options.config,id)
}

function derive(ctx:Context):GuiStateRootsEvidence {
  const loader=ctx.get('loader'),profile=ctx.get('profileContext') as ProfileContext|undefined
  if(!loader||!profile)refuse('Actual GUI Loader and launcher profileContext are required for state-root admission.')
  const entries=[...loader.entries()]
  if(entries.some(entry=>entry.options.id==='office-to-pdf'&&!entry.disabled)){
    // document/office-to-pdf/src/index.ts:248 writes under os.tmpdir(), not a configurable profile-owned root.
    refuse('Office conversion uses an unmodeled temporary-file writer; disable office-to-pdf in this GUI profile.')
  }
  // boot/app-boot/src/profile-context.ts: ProfileContext.dir/patchPath/home.
  // boot/config-editor/src/index.ts:93,142: package.json.lock and atomic patch siblings.
  const home=planned(absolute(profile.home,'profileContext.home'),'directory','Harness home')
  const profile_root=planned(absolute(profile.dir,'profileContext.dir'),'directory','profile directory')
  const profile_patch=planned(absolute(profile.patchPath,'profileContext.patchPath'),'file','profile patch')
  contains(home,profile_root,'Profile directory');contains(profile_root,profile_patch,'Profile patch')

  // storage/storage-json/src/index.ts Config.root + openUnit(): every unit is below root.
  // storage/storage-domain/src/index.ts Config.backend/routes + open(): every route must be the same audited backend.
  // workspace/workspace/src/spec.ts name='workspace'; session/session-projection-cache/src/spec.ts name='session_projcache'.
  const storage=config(entries,'storage-json','@deepseek-ai/dsh-storage-json')
  const domain=config(entries,'storage-domain','@deepseek-ai/dsh-storage-domain')
  if(domain.backend!=='json')refuse('GUI storage-domain default backend must be the audited JSON backend.')
  const routes=record(domain.routes,'storage-domain.routes')
  if(Object.values(routes).some(route=>route!=='json'))refuse('Every GUI storage-domain route must use the audited JSON backend.')
  const storage_root=planned(storage.root,'directory','storage-json.root')

  // attachment/attachment-local/src/index.ts:61,173–177: dshHome, attachments/v1, cache/attachments.
  // file-upload delegates to that attachment provider; no caller-selected destination is accepted.
  const attachment=config(entries,'attachment-local','@deepseek-ai/dsh-attachment-local')
  const attachmentHome=providerHome(attachment.dshHome)
  const attachment_root=planned(join(attachmentHome,'attachments','v1'),'directory','attachment root')
  const attachment_cache_root=planned(join(attachmentHome,'cache','attachments'),'directory','attachment cache')

  // credentials/credentials-local/src/index.ts resolveSpec(): explicit path wins;
  // default resolveDshHome is environment based, NOT profileContext.home.
  // util/atomic-write/src/index.ts writes filename.lock, takeover and temporary siblings.
  const credentials=config(entries,'credentials','@deepseek-ai/dsh-credentials-local')
  const credentials_file=planned(credentials.path===undefined?join(providerHome(credentials.dshHome),'.credentials.yaml'):credentials.path,'file','credentials filename')

  // session-query/session-query-sqlite/src/index.ts Config.path/openAt;
  // schema.ts openSearchDatabase(): resolve(path), mkdir(parent), SQLite WAL/SHM siblings.
  const query=config(entries,'session-query-sqlite','@deepseek-ai/dsh-session-query-sqlite')
  const queryPath=string(query.path,'session-query path'),phase=query.openAt??'startup'
  if(!['startup','first-search','never'].includes(String(phase)))refuse('Unknown session-query openAt phase.')
  const query_database=phase==='never'||queryPath===':memory:'?null:planned(queryPath,'file','session-query database')

  // Session telemetry's anonymous-user-id helper writes one file under the real
  // default home (identity/anonymous-user-id/src/index.ts:68–80). No content/key is read here.
  if(entries.some(entry=>entry.options.id==='session-telemetry-otel'&&!entry.disabled)){
    contains(home,providerHome(undefined),'Session telemetry anonymous identity home')
  }
  const roots:GuiStateRoot[]=[
    {id:'harness-home',path:home,providers:['profileContext','session-telemetry-otel']},
    {id:'profile',path:profile_root,providers:['settings','collaboration-config-editor']},
    {id:'storage',path:storage_root,providers:['storage-json','storage-domain','workspace','session-projection-cache']},
    {id:'attachments',path:attachment_root,providers:['attachment-local','file-upload']},
    {id:'attachment-cache',path:attachment_cache_root,providers:['attachment-local']},
    {id:'credentials',path:dirname(credentials_file),providers:['credentials']},
    ...(query_database===null?[]:[{id:'session-query',path:dirname(query_database),providers:['session-query-sqlite']}]),
  ]
  for(const root of roots)contains(home,root.path,`GUI ${root.id} state`)
  // attachment-local creates its configured home itself before object staging.
  contains(home,attachmentHome,'Attachment provider home')
  const values={schema:'gui-state-roots-v1' as const,home,profile_root,profile_patch,storage_root,
    attachment_root,attachment_cache_root,credentials_file,query_database,roots}
  const fingerprint=createHash('sha256').update(JSON.stringify({...values,routes:Object.entries(routes).sort(([a],[b])=>a.localeCompare(b))})).digest('hex')
  for(const root of roots){Object.freeze(root.providers);Object.freeze(root)}
  Object.freeze(roots)
  return Object.freeze({...values,fingerprint})
}

/**
 * Reserve the whole Harness state domain outside all protected workspaces.
 * Its providers may create missing approved leaves after the assembly's
 * readiness check; existence changes alone do not change the fingerprint.
 * Session locations MUST come from trusted host metadata + resolveProject,
 * not UI/model declarations. Normal user workspace creation remains separate
 * from model writes and can use the planned-path precheck before mkdir.
 */
export function createGuiStateRootsGuard(ctx:Context):GuiStateRootsGuard {
  const evidence=derive(ctx)
  function assertUnchanged():void {
    if(derive(ctx).fingerprint!==evidence.fingerprint)refuse('GUI state provider roots changed after admission; restart and revalidate before further sessions or writes.')
  }
  function assertSeparate(path:string):void {
    for(const root of evidence.roots){
      if(withinCanonical(path,root.path)||withinCanonical(root.path,path)){
        refuse('Harness state and protected session/workspace directories must not overlap.')
      }
    }
  }
  return Object.freeze({evidence,assertUnchanged,
    assertSessionAllowed(location:GuiSessionLocation):void {
      assertUnchanged()
      const cwd=existingDirectory(location.cwd,'Session cwd'),workspace=existingDirectory(location.workspace_root,'Resolved workspace root')
      if(!withinCanonical(workspace,cwd))refuse('Session cwd is outside its trusted resolved workspace root.')
      assertSeparate(workspace);assertSeparate(cwd)
    },
    assertWorkspacePathAllowed(path:string):string {
      assertUnchanged()
      const canonical=planned(absolute(path,'Workspace directory'),'directory','planned workspace directory')
      assertSeparate(canonical)
      return canonical
    },
  })
}
