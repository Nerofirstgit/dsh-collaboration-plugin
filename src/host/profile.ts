/** Enabled-mode protection is supported only for this pinned, closed headless composition. */
import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-app-boot'
import {CoordinationError} from '../errors.ts'
import {CoordinationSessionPersistence} from './persistence.ts'
import {ProtectedFileSystem} from './filesystem.ts'

/** Exact configured plugin identities; everything else must be disabled, not merely hidden from tools. */
export const ALLOWED_PROFILE_ENTRIES:Readonly<Record<string,string>>=Object.freeze({
  timer:'@deepseek-ai/cordis-plugin-timer',
  llm:'@deepseek-ai/dsh-llm',
  session:'@deepseek-ai/dsh-session',
  agent:'@deepseek-ai/dsh-agent',
  'session-projection':'@deepseek-ai/dsh-session-projection',
  'system-prompt':'@deepseek-ai/dsh-system-prompt',
  tools:'@deepseek-ai/dsh-tools',
  'agent-loop':'@deepseek-ai/dsh-agent-loop',
  'agent-default-model':'@deepseek-ai/dsh-agent-default-model',
  'working-directory':'@deepseek-ai/dsh-working-directory',
  'headless-startup':'@deepseek-ai/dsh-headless/startup',
  'headless-runner':'@deepseek-ai/dsh-headless',
  'session-query-sqlite':'@deepseek-ai/dsh-session-query-sqlite',
  'llm-deepseek':'@deepseek-ai/dsh-llm-deepseek-api-key',
  'deepseek-llm-api-extensions':'@deepseek-ai/dsh-deepseek-llm-api-extensions',
  'session-log-deepseek':'@deepseek-ai/dsh-session-log-deepseek',
  'token-meter':'@deepseek-ai/dsh-token-meter',
  'compaction-basic':'@deepseek-ai/dsh-compaction-basic',
  'collaboration-filesystem':'@nerofirstgit/dsh-collaboration/filesystem',
  'session-collaboration':'@nerofirstgit/dsh-collaboration',
})
const REQUIRED=new Set(['llm','session','agent','session-projection','system-prompt','tools','agent-loop','agent-default-model','headless-startup','headless-runner','collaboration-filesystem','session-collaboration'])
const PACKAGE_VERSIONS:Readonly<Record<string,string>>=Object.freeze({'@deepseek-ai/cordis-plugin-timer':'1.1.7','@nerofirstgit/dsh-collaboration':'0.1.0-dev.0'})
/** Detached inventory data used by the runtime checker and pure contract tests. Not an activation bypass. */
export interface ProfileEntryEvidence {
  id:string;name:string;disabled:boolean;package_name:string|undefined;package_version:string|undefined
  scoped:boolean;config:unknown;inject:unknown
}
/** Public diagnostics contain no runtime credential or daemon path. */
export interface ProfileEvidence {fingerprint:string;entry_count:number;profile:'pinned-minimal-headless';host_version:'0.2.1-rc.2'}
function refuse(reason:string,entry?:string):never {
  throw new CoordinationError('UNMEDIATED_WRITE_DENIED',`Enabled collaboration profile verification failed: ${reason}`,{
    ...(entry?{entry}:{}),recovery_action:'Use the shipped pinned minimal headless profile; disable unreviewed plugins, dynamic configuration, service overrides, and external tools, then restart all participating sessions. No raw-write fallback is permitted.',
  })
}
function object(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
function packageName(specifier:string):string{return specifier.split('/').slice(0,2).join('/')}
function dependencies(value:unknown):string[]{if(value===undefined||value===null)return[];if(!Array.isArray(value)||value.some(v=>typeof v!=='string'))refuse('custom service injection/interception is unsupported');return value}
/** Pure inventory validation; production always supplies evidence from the real loader below. */
export function checkProfileInventory(entries:readonly ProfileEntryEvidence[]):ProfileEvidence {
  const active=entries.filter(entry=>!entry.disabled),seen=new Set<string>()
  for(const entry of active){
    if(seen.has(entry.id))refuse('duplicate plugin identity',entry.id)
    seen.add(entry.id)
    if(ALLOWED_PROFILE_ENTRIES[entry.id]!==entry.name)refuse('an enabled plugin is outside the audited composition',entry.id)
    if(entry.scoped)refuse('nested/scoped service overrides are unsupported',entry.id)
    if(entry.package_name!==packageName(entry.name))refuse('resolved package identity does not match the audited module',entry.id)
    const expected=PACKAGE_VERSIONS[packageName(entry.name)]??'0.2.1-rc.2'
    if(entry.package_version!==expected)refuse(`plugin package is not pinned to ${expected}`,entry.id)
    const inject=dependencies(entry.inject),config=object(entry.config)
    const expectedInject=entry.id==='agent-loop'?['sessionPersistence','collaborationReady']:entry.id==='headless-runner'?['headlessStartup','collaborationReady']:[]
    if(inject.length!==expectedInject.length||inject.some(name=>!expectedInject.includes(name)))refuse('custom service dependencies are unsupported',entry.id)
    if(entry.id==='tools'&&config.mode!=='native')refuse('only native tool dispatch is supported',entry.id)
    if(entry.id==='agent-loop'){
      if(!inject.includes('sessionPersistence')||!inject.includes('collaborationReady'))refuse('agent factory lacks the collaboration startup barrier',entry.id)
      if(!Array.isArray(config.agents)||config.agents.length!==0)refuse('declarative pre-start agents are unsupported; use the guarded headless runner',entry.id)
    }
    if(entry.id==='headless-runner'&&(!inject.includes('headlessStartup')||!inject.includes('collaborationReady')))refuse('headless runner lacks the collaboration startup barrier',entry.id)
    if(entry.id==='session-query-sqlite'&&(config.path!==':memory:'||config.openAt!=='never'))refuse('only non-writing session-query configuration is supported',entry.id)
  }
  for(const required of REQUIRED)if(!seen.has(required))refuse('required guarded host component is missing or disabled',required)
  // Include only the safety-relevant normalized settings: unrelated volatile
  // model settings are opaque reference objects and can contain credentials.
  const fingerprint=createHash('sha256').update(JSON.stringify(active.map(e=>{
    const c=object(e.config)
    return {id:e.id,name:e.name,version:e.package_version,inject:e.inject,
      config:e.id==='tools'?{mode:c.mode}:e.id==='agent-loop'?{agents:c.agents}:e.id==='session-query-sqlite'?{path:c.path,openAt:c.openAt}:{}}
  }).sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex')
  return {fingerprint,entry_count:active.length,profile:'pinned-minimal-headless',host_version:'0.2.1-rc.2'}
}

/**
 * Verify real loader topology, installed package versions and actual providers.
 * Run synchronously before publishing collaborationReady and before every
 * enabled model/tool boundary. This is not an OS sandbox for arbitrary plugins:
 * unknown configured host code is refused rather than executed under a promise.
 */
export function checkActiveProfile(ctx:Context):ProfileEvidence {
  const loader=ctx.get('loader'),packages=ctx.get('pluginPackages')
  if(!loader||!packages)refuse('the supported dsh profile loader and package inventory are required')
  if(!(ctx.get('fs') instanceof ProtectedFileSystem))refuse('the actual filesystem provider is not the protected read-only provider')
  if(!(ctx.get('sessionPersistence') instanceof CoordinationSessionPersistence))refuse('the actual session persistence provider is not the canonical coordinator provider')
  const entries=[...loader.entries()],roots=entries.filter(e=>e.options.id==='include'&&e.options.name==='cordis:include'&&!e.disabled)
  if(roots.length!==1||roots[0]!.parent!==loader.root||!roots[0]!.subtree)refuse('expected one official root Include without nested profile groups')
  const include=roots[0]!,evidence:ProfileEntryEvidence[]=[]
  for(const entry of entries){
    if(entry===include)continue
    const options=entry.options as unknown as Record<string,unknown>
    const baseUrl=entry.ctx.baseUrl
    if(!baseUrl&&!entry.disabled)refuse('loader entry has no module-resolution base',entry.options.id)
    const pkg=entry.disabled?undefined:packages.packageOf(entry.options.name,baseUrl!)
    evidence.push({id:entry.options.id,name:entry.options.name,disabled:entry.disabled,package_name:pkg?.name,package_version:pkg?.version,
      scoped:entry.parent.tree!==include.subtree||Boolean(entry.subgroup)||Boolean(entry.subtree)||Boolean(options.group)||Object.keys(object(options.isolate)).length>0||Object.keys(object(options.intercept)).length>0,
      config:entry.fiber?.config??entry.options.config,inject:entry.options.inject,
    })
  }
  return checkProfileInventory(evidence)
}
