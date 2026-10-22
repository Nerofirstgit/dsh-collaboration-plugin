/** Detached GUI migration contract. Never grants active-profile authorization. */
import {win32} from 'node:path'
import {CoordinationError} from '../errors.ts'
import type {ProfileEntryEvidence} from './profile.ts'

/** Identity inventory from official dsh --profile web --dump-config, pin 687f282 / 0.2.1-rc.2.
 * This list records composition, not an assertion that every service has been audited. */
export const GUI_ROOT_MODULES:Readonly<Record<string,string>>=Object.freeze({
  "tool-plugin-manager": "@deepseek-ai/dsh-plugin-manager/tools",
  "plugin-manager": "@deepseek-ai/dsh-plugin-manager",
  "timer": "@deepseek-ai/cordis-plugin-timer",
  "hmr": "@deepseek-ai/dsh-hmr",
  "llm": "@deepseek-ai/dsh-llm",
  "deepseek-llm-api-extensions": "@deepseek-ai/dsh-deepseek-llm-api-extensions",
  "session": "@deepseek-ai/dsh-session",
  "session-log-deepseek": "@deepseek-ai/dsh-session-log-deepseek",
  "typert": "@deepseek-ai/dsh-typert-registry",
  "typert-loader": "@deepseek-ai/dsh-typert-loader",
  "typert-gateway": "@deepseek-ai/dsh-api-gateway",
  "remote-access": "@deepseek-ai/dsh-api-remote-access",
  "session-title": "@deepseek-ai/dsh-session-title",
  "session-title-llm": "@deepseek-ai/dsh-session-title-first-prompt-llm",
  "user-questions": "@deepseek-ai/dsh-user-questions",
  "agent": "@deepseek-ai/dsh-agent",
  "plugin-package-inventory-deepseek": "@deepseek-ai/dsh-plugin-package-inventory-deepseek",
  "agent-default-model": "@deepseek-ai/dsh-agent-default-model",
  "jobs": "@deepseek-ai/dsh-jobs-local",
  "llm-retry": "@deepseek-ai/dsh-llm-retry",
  "config-editor": "@deepseek-ai/dsh-config-editor",
  "settings": "@deepseek-ai/dsh-settings",
  "authorization": "@deepseek-ai/dsh-authorization",
  "deepseek-account": "@deepseek-ai/dsh-deepseek-account-platform",
  "credentials": "@deepseek-ai/dsh-credentials-local",
  "llm-pi-ai": "@deepseek-ai/dsh-llm-pi-ai",
  "session-persistence-jsonl": "@deepseek-ai/dsh-session-persistence-jsonl",
  "attachment-local": "@deepseek-ai/dsh-attachment-local",
  "session-query-sqlite": "@deepseek-ai/dsh-session-query-sqlite",
  "working-directory": "@deepseek-ai/dsh-working-directory",
  "tool-working-directory": "@deepseek-ai/dsh-tool-working-directory",
  "session-projection": "@deepseek-ai/dsh-session-projection",
  "storage": "@deepseek-ai/dsh-storage",
  "storage-json": "@deepseek-ai/dsh-storage-json",
  "storage-domain": "@deepseek-ai/dsh-storage-domain",
  "session-projection-cache": "@deepseek-ai/dsh-session-projection-cache",
  "otel": "@deepseek-ai/dsh-otel",
  "session-telemetry-otel": "@deepseek-ai/dsh-session-telemetry-otel",
  "subprocess": "@deepseek-ai/dsh-subprocess-local",
  "sandbox": "@deepseek-ai/dsh-sandbox-local",
  "sandbox-policy": "@deepseek-ai/dsh-sandbox-policy",
  "bash-sandbox": "@deepseek-ai/dsh-bash-sandbox",
  "pwsh-sandbox": "@deepseek-ai/dsh-pwsh-sandbox",
  "approval": "@deepseek-ai/dsh-user-approval",
  "permission": "@deepseek-ai/dsh-permission-presets",
  "shell-env": "@deepseek-ai/dsh-shell-env",
  "tool-bash": "@deepseek-ai/dsh-tool-bash",
  "tool-pwsh": "@deepseek-ai/dsh-tool-pwsh",
  "tool-jobs": "@deepseek-ai/dsh-tool-jobs",
  "fs-observation-policy": "@deepseek-ai/dsh-fs-observation-policy",
  "tool-fs": "@deepseek-ai/dsh-tool-fs",
  "tool-fs-search": "@deepseek-ai/dsh-tool-fs-search",
  "agent-instructions": "@deepseek-ai/dsh-agent-instructions",
  "skill": "@deepseek-ai/dsh-skill",
  "skill-filesystem": "@deepseek-ai/dsh-skill-filesystem",
  "tool-skill": "@deepseek-ai/dsh-tool-skill",
  "commands": "@deepseek-ai/dsh-commands",
  "command-feedback": "@deepseek-ai/dsh-command-feedback",
  "goal": "@deepseek-ai/dsh-goal",
  "goal-round-driver": "@deepseek-ai/dsh-goal-round-driver",
  "command-goal": "@deepseek-ai/dsh-command-goal",
  "plan-mode": "@deepseek-ai/dsh-plan-mode",
  "token-meter": "@deepseek-ai/dsh-token-meter",
  "compaction-basic": "@deepseek-ai/dsh-compaction-basic",
  "command-compact": "@deepseek-ai/dsh-command-compact",
  "subagent": "@deepseek-ai/dsh-subagent",
  "subagent-spawn-in-process": "@deepseek-ai/dsh-subagent-spawn-in-process",
  "subagent-fork-in-process": "@deepseek-ai/dsh-subagent-fork-in-process",
  "tool-subagent-control": "@deepseek-ai/dsh-tool-subagent-control",
  "tool-subagent-list-agents": "@deepseek-ai/dsh-tool-subagent-control/list-agents",
  "tool-subagent": "@deepseek-ai/dsh-tool-subagent",
  "tool-subagent-fork": "@deepseek-ai/dsh-tool-subagent",
  "ptc-runtime": "@deepseek-ai/dsh-ptc-runtime-node",
  "workflow-ptc": "@deepseek-ai/dsh-workflow-ptc",
  "tool-workflow": "@deepseek-ai/dsh-tool-workflow",
  "timeout-policy": "@deepseek-ai/dsh-tool-call-timeout-policy",
  "spill-local": "@deepseek-ai/dsh-spill-local",
  "spill-policy": "@deepseek-ai/dsh-spill-policy",
  "session-checkpoint-policy": "@deepseek-ai/dsh-session-checkpoint-policy",
  "tool-result-pruner": "@deepseek-ai/dsh-compaction-tool-result-pruner",
  "image-offload": "@deepseek-ai/dsh-compaction-image-offload",
  "tool-todo": "@deepseek-ai/dsh-tool-todo",
  "tool-goal": "@deepseek-ai/dsh-tool-goal",
  "repeat-tool-reminder": "@deepseek-ai/dsh-repeat-tool-reminder",
  "web": "@deepseek-ai/dsh-web",
  "web-search-deepseek": "@deepseek-ai/dsh-web-search-deepseek",
  "web-deepseek-api": "@deepseek-ai/dsh-web-deepseek-api",
  "web-fetch-http": "@deepseek-ai/dsh-web-fetch-http",
  "tool-web": "@deepseek-ai/dsh-tool-web",
  "mcp-resources": "@deepseek-ai/dsh-mcp-resources",
  "tools": "@deepseek-ai/dsh-tools",
  "system-prompt": "@deepseek-ai/dsh-system-prompt",
  "agent-loop": "@deepseek-ai/dsh-agent-loop",
  "fs-sandbox": "@deepseek-ai/dsh-fs-sandbox",
  "llm-deepseek": "@deepseek-ai/dsh-llm-deepseek-api-key",
  "llm-deepseek-account": "@deepseek-ai/dsh-llm-deepseek-account",
  "desktop-product-telemetry": "@deepseek-ai/dsh-host-product-telemetry-otel",
  "product-analytics": "@deepseek-ai/dsh-client-product-analytics",
  "subagent-model-selection-settings": "@deepseek-ai/dsh-tool-subagent/model-selection-settings",
  "message-feedback": "@deepseek-ai/dsh-message-feedback",
  "session-log-download": "@deepseek-ai/dsh-session-log-export",
  "open-in-app": "@deepseek-ai/dsh-host-open-in-app",
  "ui-open-in-app": "@deepseek-ai/dsh-client-ui-open-in-app",
  "workspace": "@deepseek-ai/dsh-workspace",
  "session-reference": "@deepseek-ai/dsh-session-reference",
  "file-reference-local": "@deepseek-ai/dsh-file-reference-local",
  "session-stats": "@deepseek-ai/dsh-session-stats",
  "session-turn-outline": "@deepseek-ai/dsh-session-turn-outline",
  "directory-picker": "@deepseek-ai/dsh-host-directory-picker-auto",
  "plugin-inventory": "@deepseek-ai/dsh-host-plugin-inventory",
  "session-controller": "@deepseek-ai/dsh-api-session-controller",
  "job-controller": "@deepseek-ai/dsh-api-job-controller",
  "terminal-controller": "@deepseek-ai/dsh-api-terminal-controller",
  "workspace-files": "@deepseek-ai/dsh-api-workspace-files",
  "schedule": "@deepseek-ai/dsh-schedule",
  "ui-settings-account": "@deepseek-ai/dsh-client-ui-settings-account",
  "account-controller": "@deepseek-ai/dsh-api-account-controller",
  "settings-controller": "@deepseek-ai/dsh-api-settings-controller",
  "workspace-controller": "@deepseek-ai/dsh-api-workspace-controller",
  "cordis-host-runner": "@deepseek-ai/dsh-cordis-host-runner",
  "cordis-inspect-providers": "@deepseek-ai/dsh-tool-cordis/host",
  "web-startup": "@deepseek-ai/dsh-web-app/startup",
  "webserver": "@deepseek-ai/dsh-host-webserver",
  "web-runtime": "@deepseek-ai/dsh-web-app",
  "harness-dev-context": "@deepseek-ai/dsh-harness-dev-context",
  "client-hmr": "@deepseek-ai/dsh-client-hmr",
  "modules": "@deepseek-ai/dsh-client-modules",
  "connection": "@deepseek-ai/dsh-client-connection",
  "file-upload": "@deepseek-ai/dsh-client-file-upload",
  "api-remotes": "@deepseek-ai/dsh-api-remotes",
  "cordis-client-runner": "@deepseek-ai/dsh-cordis-client-runner",
  "ui-theme": "@deepseek-ai/dsh-client-ui-theme",
  "locale": "@deepseek-ai/dsh-client-locale",
  "shortcuts": "@deepseek-ai/dsh-client-shortcuts",
  "ui-shortcuts": "@deepseek-ai/dsh-client-ui-shortcuts",
  "ui-layout": "@deepseek-ai/dsh-client-ui-layout",
  "ui-renderer": "@deepseek-ai/dsh-client-ui-renderer",
  "ui-session": "@deepseek-ai/dsh-client-ui-session",
  "resources": "@deepseek-ai/dsh-client-resources",
  "ui-sidebar": "@deepseek-ai/dsh-client-ui-sidebar",
  "ui-sidebar-right": "@deepseek-ai/dsh-client-ui-sidebar-right",
  "office-to-pdf": "@deepseek-ai/dsh-office-to-pdf",
  "ui-sidebar-documentpreview": "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
  "ui-sidebar-browser": "@deepseek-ai/dsh-client-ui-sidebar-browser",
  "ui-sidebar-terminal": "@deepseek-ai/dsh-client-ui-sidebar-terminal",
  "ui-sidebar-files": "@deepseek-ai/dsh-client-ui-sidebar-files",
  "ui-settings": "@deepseek-ai/dsh-client-ui-settings",
  "ui-settings-general": "@deepseek-ai/dsh-client-ui-settings-general",
  "ui-settings-models": "@deepseek-ai/dsh-client-ui-settings-models",
  "ui-plugin-manager": "@deepseek-ai/dsh-client-ui-plugin-manager",
  "ui-settings-plugin-inventory": "@deepseek-ai/dsh-client-ui-settings-plugin-inventory",
  "ui-conversation": "@deepseek-ai/dsh-client-ui-conversation",
  "ui-approval": "@deepseek-ai/dsh-client-ui-approval",
  "ui-chat": "@deepseek-ai/dsh-client-ui-chat",
  "ui-brand-official": "@deepseek-ai/dsh-client-ui-brand-official",
  "ui-attachment": "@deepseek-ai/dsh-client-ui-attachment",
  "ui-tool": "@deepseek-ai/dsh-client-ui-tool",
  "ui-cordis": "@deepseek-ai/dsh-client-ui-cordis",
  "ui-deliverables": "@deepseek-ai/dsh-client-ui-deliverables",
  "workspace-changes": "@deepseek-ai/dsh-workspace-changes",
  "ui-workspace": "@deepseek-ai/dsh-client-ui-workspace",
  "ui-workflow-run": "@deepseek-ai/dsh-client-ui-workflow-run",
  "ui-input-trigger": "@deepseek-ai/dsh-client-ui-input-trigger",
  "ui-commands": "@deepseek-ai/dsh-client-ui-commands",
  "ui-skill": "@deepseek-ai/dsh-client-ui-skill",
  "ui-subagent": "@deepseek-ai/dsh-client-ui-subagent",
  "ui-reference": "@deepseek-ai/dsh-client-ui-reference",
  "ui-secret-mask": "@deepseek-ai/dsh-client-ui-secret-mask",
  "ui-jobs": "@deepseek-ai/dsh-client-ui-jobs",
  "ui-schedule": "@deepseek-ai/dsh-client-ui-schedule",
  "ui-goal": "@deepseek-ai/dsh-client-ui-goal",
  "ui-message-feedback": "@deepseek-ai/dsh-client-ui-message-feedback",
  "ui-model-selection": "@deepseek-ai/dsh-client-ui-model-selection",
  "ui-deepseek-model-label-1017": "@deepseek-ai/dsh-client-ui-deepseek-model-label-1017",
  "ui-permission": "@deepseek-ai/dsh-client-ui-permission-presets",
  "ui-agent-preset": "@deepseek-ai/dsh-client-ui-agent-preset",
  "ui-settings-session-log": "@deepseek-ai/dsh-client-ui-settings-session-log",
  "ui-settings-plugins": "@deepseek-ai/dsh-client-ui-settings-plugins",
  "ui-settings-shell": "@deepseek-ai/dsh-client-ui-settings-shell",
  "ui-settings-agent-loop": "@deepseek-ai/dsh-client-ui-settings-agent-loop",
  "ui-settings-subagent": "@deepseek-ai/dsh-client-ui-settings-subagent",
  "ui-settings-web-search": "@deepseek-ai/dsh-client-ui-settings-web-search",
  "ui-plan": "@deepseek-ai/dsh-client-ui-plan",
  "ui-user-questions": "@deepseek-ai/dsh-client-ui-user-questions",
  "ui-trajectory": "@deepseek-ai/dsh-client-ui-trajectory",
  "agent-preset-registry": "@deepseek-ai/dsh-agent-preset-registry",
  "preset-standard": "@deepseek-ai/dsh-agent-preset",
  "preset-ptc": "@deepseek-ai/dsh-agent-preset",
  "preset-minimal": "@deepseek-ai/dsh-agent-preset",
  "preset-cordis": "@deepseek-ai/dsh-agent-preset",
  "session-collaboration": "@nerofirstgit/dsh-collaboration",
  "collaboration-filesystem": "@nerofirstgit/dsh-collaboration/filesystem",
  "preset-collaboration": "@deepseek-ai/dsh-agent-preset"
})

export const GUI_DISABLED_ENTRIES:readonly string[]=Object.freeze([
  'tool-plugin-manager','plugin-manager','hmr','config-editor','session-persistence-jsonl','fs-sandbox',
  'subprocess','sandbox','bash-sandbox','pwsh-sandbox','shell-env',
  'tool-bash','tool-pwsh','tool-jobs','tool-fs','tool-fs-search','tool-working-directory',
  'skill-filesystem','tool-skill','agent-instructions','command-goal','tool-goal','plan-mode',
  'goal-round-driver','subagent','subagent-spawn-in-process','subagent-fork-in-process',
  'tool-subagent-control','tool-subagent-list-agents','tool-subagent','tool-subagent-fork',
  'ptc-runtime','workflow-ptc','tool-workflow','compaction-basic','command-compact','tool-result-pruner',
  'timeout-policy','spill-local','spill-policy','session-checkpoint-policy','image-offload','tool-todo','tool-web','mcp-resources',
  'job-controller','terminal-controller','schedule','cordis-host-runner','cordis-inspect-providers','cordis-client-runner','client-hmr',
  'ui-plugin-manager','ui-settings-plugins','ui-settings-shell','ui-agent-preset','ui-cordis','ui-sidebar-terminal',
  'ui-jobs','ui-schedule','ui-subagent','ui-settings-subagent','ui-workflow-run',
  'preset-standard','preset-ptc','preset-minimal','preset-cordis',
  // Confirmed direct temporary writers/exporters and consumers of disabled executors.
  'office-to-pdf','workspace-changes','ui-deliverables',
  'otel','session-telemetry-otel','desktop-product-telemetry','product-analytics',
  'open-in-app','ui-open-in-app','permission','ui-permission','subagent-model-selection-settings',
  'ui-settings-plugin-inventory','ui-settings-agent-loop','ui-settings-web-search',
  // Auxiliary title generation has no admitted session model-request identity yet.
  'session-title-llm',
])
export const GUI_REQUIRED_INJECT:Readonly<Record<string,readonly string[]>>=Object.freeze({
  'agent-loop':['sessionPersistence','collaborationReady'],
  'session-controller':['collaborationReady'],'workspace-controller':['collaborationReady'],
  'file-upload':['collaborationReady'],
  'webserver':['webStartup'],'connection':['webStartup'],
  'web-runtime':['webStartup','collaborationReady'],
})
export interface GuiProfileCandidate {
  surface:'web'|'desktop'
  entries:ProfileEntryEvidence[]
  startup:{producer:'session-collaboration';awaits_loader_settlement:boolean}
  state:{harness_home:string;profile_root:string;storage_root:string;workspace_roots:string[]}
}
/** Known write paths found in the pinned source. Other enabled services still need review. */
export const GUI_WRITE_BOUNDARIES=Object.freeze([
  {entries:['storage-json','storage-domain','session-projection-cache','workspace'],kind:'host-state',source:'packages/storage/storage-json/src/index.ts',boundary:'Explicit storage-json.root; atomic JSON files and projection/workspace records stay outside projects.'},
  {entries:['attachment-local','file-upload'],kind:'host-state',source:'packages/attachment/attachment-local/src/index.ts',boundary:'Explicit dshHome; attachments/v1 and attachment cache, never a caller-selected project destination.'},
  {entries:['credentials'],kind:'host-state',source:'packages/credentials/credentials-local/src/index.ts',boundary:'Resolved credential filename and atomic-write lock must remain within reviewed host state; defaults/config still require runtime audit.'},
  {entries:['settings','config-editor','settings-controller'],kind:'configuration-code',source:'packages/settings/settings/src/index.ts',boundary:'Settings writes call configEditor.edit and can recompose code. Raw editor remains disabled; a restricted settings adapter is required.'},
  {entries:['session-controller'],kind:'human-workspace-create',source:'packages/api/session-controller/src/agent.ts',boundary:'createAgent mkdir(cwd) is explicit human workspace setup; agent writes cannot invoke this as an alternate file mutation API.'},
  {entries:['workspace-files'],kind:'read-only',source:'packages/api/workspace-files/src/index.ts',boundary:'Preview/list/change feed exposes no mutations; reads are not write-authorizing receipts.'},
  {entries:['session-persistence-jsonl'],kind:'replaced',source:'packages/session/session-persistence-jsonl/src/index.ts',boundary:'Disabled: canonical coordination persistence is the sole enabled session writer.'},
  {entries:['jobs'],kind:'in-memory-inspection',source:'packages/jobs/jobs-local/src/index.ts',boundary:'Retain the actual in-memory registry for Desktop quit/update inspection. No job controller or producer is admitted; start rejects before its run callback without an attached controller.'},
  {entries:['spill-local','image-offload','terminal-controller','tool-jobs','job-controller','schedule'],kind:'disabled-unmediated',source:'packages/spill/spill-local/src/store.ts',boundary:'Spill writes use direct fs; terminals and job producers can spawn writers. These execution/control entry paths remain disabled pending mediation.'},
] as const)
export interface GuiContractBlocker {readonly code:string;readonly detail:string}
export interface GuiContractInspection {
  readonly inventory_valid:true
  /** Deliberately a literal false: config inspection cannot authorize a running profile. */
  readonly activation_allowed:false
  readonly surface:'web'|'desktop'
  readonly entry_count:number
  readonly blockers:readonly GuiContractBlocker[]
}
function refuse(message:string):never {throw new CoordinationError('UNMEDIATED_WRITE_DENIED',`GUI candidate contract rejected: ${message}`)}
function config(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
function strings(value:unknown):string[]{if(value===undefined)return[];if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))refuse('dependencies must be explicit string lists');return value as string[]}
function sameMembers(actual:readonly string[],expected:readonly string[]):boolean{return actual.length===expected.length&&new Set(actual).size===actual.length&&actual.every(item=>expected.includes(item))}
/** Lexical Windows configuration check only. Runtime canonical path/provider checks remain blockers. */
function statePath(value:string):string {
  if(typeof value!=='string'||!value.match(/^[A-Za-z]:[\\/]/)||value.includes('\0')||value.slice(2).includes(':'))refuse('state/workspace roots must be explicit local absolute Windows paths')
  return win32.normalize(value).replace(/[\\/]+$/,'').toLowerCase()
}
function contains(parent:string,child:string):boolean{return child===parent||child.startsWith(parent+'\\')}

/**
 * Inspect a migration candidate, not live Cordis providers. No listener, Loader,
 * filesystem access, model call or plugin activation occurs. Never import this
 * result as a substitute for checkActiveProfile or collaborationReady.
 */
export function inspectGuiProfileContract(candidate:GuiProfileCandidate):GuiContractInspection {
  if(candidate.surface!=='web'&&candidate.surface!=='desktop')refuse('unknown host surface')
  if(candidate.startup.producer!=='session-collaboration'||candidate.startup.awaits_loader_settlement!==false)refuse('readiness producer must publish before whole-tree settlement')
  const rows=new Map<string,ProfileEntryEvidence>()
  for(const row of candidate.entries){
    if(rows.has(row.id))refuse('duplicate entry identity')
    if(GUI_ROOT_MODULES[row.id]!==row.name)refuse('unknown/replaced entry')
    if(typeof row.disabled!=='boolean'||row.scoped!==false)refuse('unresolved enablement or unreviewed scope')
    const packageName=row.name.split('/').slice(0,2).join('/')
    const version=packageName==='@nerofirstgit/dsh-collaboration'?'0.1.0-dev.0':row.id==='timer'?'1.1.7':'0.2.1-rc.2'
    if(row.package_name!==packageName||row.package_version!==version)refuse('package identity/version differs from pinned source')
    const disabled=GUI_DISABLED_ENTRIES.includes(row.id)
    if(row.disabled!==disabled)refuse(disabled?'unmediated entry must stay disabled':'required GUI/root entry is disabled')
    if(!sameMembers(strings(row.inject),GUI_REQUIRED_INJECT[row.id]??[]))refuse('missing or unexpected dependency barrier')
    rows.set(row.id,row)
  }
  if(rows.size!==Object.keys(GUI_ROOT_MODULES).length)refuse('required inventory entries are missing')
  const at=(id:string)=>config(rows.get(id)!.config)
  if(at('tools').mode!=='native')refuse('only guarded native tool dispatch is planned')
  const agents=at('agent-loop').agents
  if(!Array.isArray(agents)||agents.length!==0)refuse('declarative pre-barrier agents are forbidden')
  if(at('agent-preset-registry').default!=='collaboration')refuse('dedicated collaboration preset must be default')
  const preset=at('preset-collaboration')
  if(preset.id!=='collaboration'||!Array.isArray(preset.plugins)||preset.plugins.length!==0||!sameMembers(Object.keys(preset),['id','plugins']))refuse('preset must inherit root managed definitions without registering replacements')
  if(at('session-query-sqlite').path!==':memory:'||at('session-query-sqlite').openAt!=='never')refuse('unreviewed persistent query backend')
  const home=statePath(candidate.state.harness_home),profile=statePath(candidate.state.profile_root),storage=statePath(candidate.state.storage_root)
  if(!contains(home,profile)||!contains(home,storage)||profile===storage||profile===home||storage===home)refuse('profile/storage must have distinct declared locations under host home')
  if(candidate.state.workspace_roots.length===0)refuse('candidate needs explicit test workspaces')
  for(const raw of candidate.state.workspace_roots){const root=statePath(raw);if(contains(home,root)||contains(root,home))refuse('host state and project roots overlap')}
  if(statePath(String(at('storage-json').root??''))!==storage||statePath(String(at('attachment-local').dshHome??''))!==home)refuse('backend state roots do not match the declared domain')
  const blockers:GuiContractBlocker[]=[
    {code:'GUI_PROVIDER_COMPATIBILITY_UNVERIFIED',detail:'ProtectedFileSystem and canonical SessionPersistence have not been exercised with the actual GUI service graph.'},
    {code:'SETTINGS_ADAPTER_REQUIRED',detail:'This detached inventory cannot prove the actual namespace-restricted ConfigEditor. The live checker must verify its provider identity; raw configuration editing remains disabled.'},
    {code:'HOST_EFFECT_AUDIT_PENDING',detail:'Inventory is exact, not a complete behavioral audit. Review all retained service effects and their live canonical state paths.'},
    {code:'GUI_RUNTIME_GUARD_REQUIRED',detail:'This detached inventory cannot authorize GUI execution. The separate live checker must verify owned tool identities, the actual controller method guard and refusal during reconfiguration.'},
    {code:'GUI_CONTROLLER_GUARD_REQUIRED',detail:'Retaining the official controller preserves its browser and RPC package identity, but public carriers must wait for its verified live-method preflight guard.'},
    {code:'LOADER_READINESS_UNVERIFIED',detail:'Declared barriers have not been tested in an activated Loader graph; controller admission and disposal must be checked without whole-tree waiting in the producer.'},
    {code:'WINDOWS_RUNTIME_UNVERIFIED',detail:'Actual Windows IPC, filesystem, SQLite and two real Harness processes remain unverified.'},
  ]
  if(candidate.surface==='desktop')blockers.push({code:'DESKTOP_RUNTIME_UNVERIFIED',detail:'Desktop adds Electron Node-mode runtime, host lifecycle and ready IPC; a Web-only test does not cover them.'})
  return {inventory_valid:true,activation_allowed:false,surface:candidate.surface,entry_count:rows.size,blockers}
}
