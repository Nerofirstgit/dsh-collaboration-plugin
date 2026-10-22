/** Source/config contracts only. No GUI, plugin body, listener or model is started. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import yaml from 'js-yaml'
import {entryListSchema} from '@deepseek-ai/cordis-plugin-include'
import {ALLOWED_PROFILE_ENTRIES,checkProfileInventory,type ProfileEntryEvidence} from '../../src/host/profile.ts'

interface Row {id?:string;name?:string;disabled?:unknown;inject?:unknown;group?:boolean;isolate?:unknown;config?:unknown;insert?:Row[]}
const require=createRequire(import.meta.url)
const webManifestPath=require.resolve('@deepseek-ai/dsh-web-app/package.json')
const webDirectory=dirname(webManifestPath)
function rows(path:string):Row[]{const value:unknown=yaml.load(readFileSync(path,'utf8'),{schema:entryListSchema});assert.ok(Array.isArray(value));return value as Row[]}
function inserted(path:string):Row[]{return rows(path).flatMap(row=>row.insert??[])}
function record(value:unknown):Record<string,unknown>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>}
function preset(name:string):Row[]{const row=inserted(join(webDirectory,'presets',`${name}.patch.yml`)).find(row=>row.id===`preset-${name}`);assert.ok(row);const plugins=record(row.config).plugins;assert.ok(Array.isArray(plugins));return plugins as Row[]}
function walk(list:Row[]):Row[]{return list.flatMap(row=>[row,...Array.isArray(row.config)?walk(row.config as Row[]):[]])}
function headlessInventory():ProfileEntryEvidence[]{return Object.entries(ALLOWED_PROFILE_ENTRIES).map(([id,name])=>({id,name,disabled:false,scoped:false,package_name:name.split('/').slice(0,2).join('/'),package_version:name.startsWith('@nerofirstgit/')?'0.1.0-dev.0':id==='timer'?'1.1.7':'0.2.1-rc.2',config:id==='tools'?{mode:'native'}:id==='agent-loop'?{agents:[]}:id==='session-query-sqlite'?{path:':memory:',openAt:'never'}:{},inject:id==='agent-loop'?['sessionPersistence','collaborationReady']:id==='headless-runner'?['headlessStartup','collaborationReady']:undefined}))}

test('pinned Web bundle includes explicit host controller rows and four preset declarations',()=>{
  const manifest=JSON.parse(readFileSync(webManifestPath,'utf8'))
  assert.equal(manifest.version,'0.2.1-rc.2')
  assert.deepEqual(manifest.dsh.bundle.patch,['./cordis.patch.yml','./presets/standard.patch.yml','./presets/ptc.patch.yml','./presets/minimal.patch.yml','./presets/cordis.patch.yml'])
  const host=inserted(join(webDirectory,'cordis.patch.yml'))
  for(const [id,name]of Object.entries({'session-controller':'@deepseek-ai/dsh-api-session-controller','workspace-controller':'@deepseek-ai/dsh-api-workspace-controller','workspace':'@deepseek-ai/dsh-workspace','webserver':'@deepseek-ai/dsh-host-webserver','web-runtime':'@deepseek-ai/dsh-web-app','connection':'@deepseek-ai/dsh-client-connection','modules':'@deepseek-ai/dsh-client-modules','agent-preset-registry':'@deepseek-ai/dsh-agent-preset-registry'}))assert.equal(host.find(row=>row.id===id)?.name,name)
})

test('stock standard preset contains scoped groups and its own writable tool definitions',()=>{
  const standard=preset('standard'),all=walk(standard)
  assert.ok(standard.some(row=>row.name==='cordis:group'&&row.group===true&&row.isolate!==undefined))
  for(const name of ['@deepseek-ai/dsh-tool-fs','@deepseek-ai/dsh-tool-pwsh','@deepseek-ai/dsh-tool-bash','@deepseek-ai/dsh-compaction-tool-result-pruner'])assert.ok(all.some(row=>row.name===name),name)
  // Disabling a root tool row cannot erase the separate per-session definition.
  assert.equal(rows(join(webDirectory,'cordis.patch.yml')).find(row=>row.id==='tool-fs')?.disabled,true)
  assert.notEqual(all.find(row=>row.name==='@deepseek-ai/dsh-tool-fs')?.disabled,true)
})

test('stock minimal preset is not a ready-made mediated-write preset',()=>{
  const all=walk(preset('minimal'))
  assert.ok(all.some(row=>row.name==='@deepseek-ai/dsh-terminal'))
  assert.ok(all.some(row=>row.name==='@deepseek-ai/dsh-tool-pwsh-persistent'))
  assert.ok(all.some(row=>row.name==='@deepseek-ai/dsh-tool-bash-persistent'))
})

test('current headless verifier does not silently accept GUI controller additions or scoped presets',()=>{
  const entries=headlessInventory()
  assert.equal(checkProfileInventory(entries).profile,'pinned-minimal-headless')
  assert.throws(()=>checkProfileInventory([...entries,{id:'session-controller',name:'@deepseek-ai/dsh-api-session-controller',disabled:false,scoped:false,package_name:'@deepseek-ai/dsh-api-session-controller',package_version:'0.2.1-rc.2',config:{},inject:undefined}]),{code:'UNMEDIATED_WRITE_DENIED'})
  entries.find(row=>row.id==='tools')!.scoped=true
  assert.throws(()=>checkProfileInventory(entries),{code:'UNMEDIATED_WRITE_DENIED'})
})
