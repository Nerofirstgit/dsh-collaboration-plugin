/** Restricted editor tests. Delegation doubles do not prove Loader/file durability. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ConfigEditor} from '@deepseek-ai/dsh-config-editor'
import type {Entry} from '@deepseek-ai/cordis-plugin-loader'
import GuiConfigEditor from '../../src/host/gui-config-editor.ts'

const denied={code:'UNMEDIATED_WRITE_DENIED'}
function entry(id='ui-theme',name=id==='locale'?'@deepseek-ai/dsh-client-locale':'@deepseek-ai/dsh-client-ui-theme'):Entry{return{options:{id,name}}as Entry}
function delegate(t:test.TestContext,current:Record<string,unknown>={preference:'system',fontSize:14},inherited:Record<string,unknown>={}){
  const ctx=new Context(),editor=new GuiConfigEditor(ctx)
  t.after(()=>ctx.fiber.dispose())
  const writes:Record<string,unknown>[]=[]
  let called=0
  t.mock.method(ConfigEditor.prototype,'edit',async(_entry:Entry,change:(current:Record<string,unknown>,inherited:Record<string,unknown>)=>Record<string,unknown>)=>{
    called++;const next=change(current,inherited)
    await Promise.resolve() // Deliberately model the real base method's post-callback await.
    writes.push(structuredClone(next))
  })
  return {editor,writes,current,inherited,get called(){return called}}
}
test('delegates harmless theme edit while preserving unchanged non-form configuration',async t=>{
  const d=delegate(t,{preference:'system',fontSize:14,opaque:{token:'private',path:'unchanged'}})
  await d.editor.edit(entry(),current=>({...current,preference:'dark',fontSize:18,codeFontSize:12,terminalFontSize:16,textFontFamily:'Inter',codeFontFamily:'Consolas',terminalFontFamily:''}))
  assert.equal(d.called,1);assert.deepEqual(d.writes[0]!.opaque,{token:'private',path:'unchanged'});assert.equal(d.writes[0]!.fontSize,18)
})
test('locale supports an explicit language and reset to inherited/browser preference',async t=>{
  const d=delegate(t,{preference:'en'})
  await d.editor.edit(entry('locale'),current=>({...current,preference:'zh-Hans'}))
  await d.editor.edit(entry('locale'),()=>({}))
  assert.deepEqual(d.writes,[{preference:'zh-Hans'},{}])
})
for(const [label,id,name]of [
  ['unknown namespace','storage-json','@deepseek-ai/dsh-storage-json'],
  ['module substitution','ui-theme','@deepseek-ai/dsh-plugin-manager'],
  ['model configuration not yet authorized','agent-default-model','@deepseek-ai/dsh-agent-default-model'],
])test(`rejects ${label} before delegating`,async t=>{const d=delegate(t);await assert.rejects(d.editor.edit(entry(id,name),()=>({})),denied);assert.equal(d.called,0)})
for(const [label,change]of Object.entries({
  'new state path':(c:Record<string,unknown>)=>({...c,path:'C:\\project'}),
  'remove unchanged secret field':(_c:Record<string,unknown>)=>({preference:'dark',fontSize:14}),
  'in-place non-form mutation':(c:Record<string,unknown>)=>{(c.opaque as Record<string,unknown>).path='C:\\project';return c},
  'structural expression':(c:Record<string,unknown>)=>({...c,textFontFamily:{__jsExpr:'not executable input'}}),
  'code tag object':(c:Record<string,unknown>)=>({...c,preference:{tag:'tag:yaml.org,2002:js',value:'not executable input'}}),
  'nested font object':(c:Record<string,unknown>)=>({...c,codeFontFamily:{value:'Consolas'}}),
  'nonfinite font size':(c:Record<string,unknown>)=>({...c,fontSize:Infinity}),
  'out-of-range code font':(c:Record<string,unknown>)=>({...c,codeFontSize:17}),
  'fractional terminal font':(c:Record<string,unknown>)=>({...c,terminalFontSize:12.5}),
  'unknown theme enum':(c:Record<string,unknown>)=>({...c,preference:'arbitrary'}),
  'array result':(_c:Record<string,unknown>)=>[] as unknown as Record<string,unknown>,
  'Promise result':(c:Record<string,unknown>)=>Promise.resolve(c)as unknown as Record<string,unknown>,
}))test(`rejects ${label} inside normal serialized callback`,async t=>{
  const d=delegate(t,{preference:'system',fontSize:14,opaque:{path:'unchanged'}})
  await assert.rejects(d.editor.edit(entry(),change),denied);assert.equal(d.called,1);assert.equal(d.writes.length,0)
})
test('late mutation of returned config cannot change the validated object handed to the base editor',async t=>{
  const d=delegate(t)
  await d.editor.edit(entry(),current=>{const next={...current,preference:'dark'};queueMicrotask(()=>{(next as Record<string,unknown>).path='C:\\project'});return next})
  assert.deepEqual(d.writes,[{preference:'dark',fontSize:14}])
})
test('callback cannot change inherited data that the base editor uses to remove overrides',async t=>{
  const inherited={preference:'system'},d=delegate(t,{preference:'dark'},inherited)
  await d.editor.edit(entry(),(current,base)=>{base.preference='light';return{...current,preference:'system'}})
  assert.deepEqual(inherited,{preference:'system'})
})
test('identity is checked again in callback, not only before waiting for the base editor',async t=>{
  const ctx=new Context(),editor=new GuiConfigEditor(ctx),row=entry();t.after(()=>ctx.fiber.dispose())
  t.mock.method(ConfigEditor.prototype,'edit',async(_entry:Entry,change:(c:Record<string,unknown>,i:Record<string,unknown>)=>Record<string,unknown>)=>{row.options.name='replacement';change({preference:'system'}, {})})
  await assert.rejects(editor.edit(row,c=>({...c,preference:'dark'})),denied)
})
test('normal callback failures propagate without a custom retry or write fallback',async t=>{
  const d=delegate(t),failure=new Error('read-only test failure')
  await assert.rejects(d.editor.edit(entry(),()=>{throw failure}),error=>error===failure)
  assert.equal(d.called,1);assert.equal(d.writes.length,0)
})

test('prototype-named unknown fields are not presentation settings',async t=>{
  const d=delegate(t,{preference:'system',constructor:'preserved'})
  await assert.rejects(d.editor.edit(entry(),current=>({...current,constructor:undefined})),denied)
})

/** Real minimal profile with official UI config consumers and stock SettingsForms.
 * No HTTP server, GUI runtime, HMR watcher, model or coordinator is mounted.
 * The editor itself is installed as a source builtin, not an installed plugin tarball.
 */
async function configurationFixture(t:test.TestContext){
  const {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync}=await import('node:fs')
  const {tmpdir}=await import('node:os')
  const {join,resolve}=await import('node:path')
  const {boot,initProfile,readProfilePatches}=await import('@deepseek-ai/dsh-app-boot')
  const {default:z}=await import('@deepseek-ai/schemastery')
  const home=mkdtempSync(join(tmpdir(),'dsh-gui-editor-')),dir=join(home,'profile'),bundle=join(dir,'node_modules','fixture-bundle')
  let ctx:Context|undefined
  t.after(async()=>{await ctx?.fiber.dispose();rmSync(home,{recursive:true,force:true})})
  initProfile(dir,['fixture-bundle']);mkdirSync(bundle,{recursive:true})
  symlinkSync(resolve('node_modules/@deepseek-ai'),join(dir,'node_modules','@deepseek-ai'),process.platform==='win32'?'junction':'dir')
  writeFileSync(join(home,'package.json'),JSON.stringify({name:'isolated-gui-editor-fixture'}))
  writeFileSync(join(bundle,'package.json'),JSON.stringify({name:'fixture-bundle',version:'1.0.0',dsh:{bundle:{patch:'cordis.patch.yml'}}}))
  writeFileSync(join(bundle,'cordis.patch.yml'),JSON.stringify([{insert:[
    {id:'config-editor',name:'cordis:gui-editor'},
    {id:'settings',name:'@deepseek-ai/dsh-settings'},
    {id:'ui-theme',name:'@deepseek-ai/dsh-client-ui-theme',config:{preference:'system',fontSize:14}},
    {id:'locale',name:'@deepseek-ai/dsh-client-locale',config:{preference:'en'}},
    {id:'secret-probe',name:'cordis:secret-probe',config:{token:'fixture-private-value'}},
  ]}]))
  writeFileSync(join(dir,'cordis.yml'),'[]\n')
  const profile={name:'test',startedBundles:['fixture-bundle'],dir,patchPath:join(dir,'cordis.patch.yml'),installAnchor:join(home,'package.json'),cwd:home,home,overlays:[],telemetryDisabledEnv:'1'}
  ctx=await boot('test',join(dir,'cordis.yml'),readProfilePatches('test',profile),ctx=>{
    ctx.provide('profileContext',profile)
    ctx.provide('appReady',{onReady:(listener:()=>void)=>{listener();return()=>{}}})
    Object.assign(ctx.loader.builtins,{'gui-editor':GuiConfigEditor,'secret-probe':{Config:z.object({token:z.string().role('secret').volatile()}),apply(){}}})
  })
  return{ctx,profile}
}
test('real isolated profile persists allowed UI preferences through stock SettingsForms and rejects stale revisions',async t=>{
  const {readFileSync}=await import('node:fs')
  const {ctx,profile}=await configurationFixture(t)
  assert.ok(ctx.configEditor instanceof GuiConfigEditor)
  const before=ctx.settings.describe({redactSecrets:true})
  assert.ok(!JSON.stringify(before).includes('fixture-private-value'))
  const theme=before.find(row=>row.ns==='ui-theme')!
  await ctx.settings.update(theme.ns,{preference:'dark',fontSize:18},theme.revision)
  const actual=ctx.settings.describe({redactSecrets:true}).find(row=>row.ns==='ui-theme')!
  assert.equal(actual.value.preference,'dark');assert.equal(actual.value.fontSize,18)
  const patch=readFileSync(profile.patchPath,'utf8')
  assert.match(patch,/preference: dark/);assert.match(patch,/fontSize: 18/)
  await assert.rejects(ctx.settings.update(theme.ns,{preference:'light'},theme.revision),{code:'SETTINGS_CONFLICT'})
  assert.equal(readFileSync(profile.patchPath,'utf8'),patch)
  const locale=ctx.settings.describe({redactSecrets:true}).find(row=>row.ns==='locale')!
  await ctx.settings.mutate(locale.ns,[{op:'set',path:['preference'],value:'zh-Hans'}],locale.revision)
  assert.equal(ctx.settings.describe().find(row=>row.ns==='locale')!.value.preference,'zh-Hans')
})
test('real base editor never persists forbidden configuration or an in-place forbidden mutation',async t=>{
  const {readFileSync}=await import('node:fs')
  const {ctx,profile}=await configurationFixture(t)
  const row=ctx.configEditor.entries().find(row=>row.options.id==='ui-theme')!
  const before=readFileSync(profile.patchPath,'utf8')
  await assert.rejects(ctx.configEditor.edit(row,current=>{current.path='C:\\project';return current}),denied)
  await assert.rejects(ctx.configEditor.edit(row,current=>({...current,preference:{__jsExpr:'inert rejected fixture'}})),denied)
  assert.equal(readFileSync(profile.patchPath,'utf8'),before)
  const secret=ctx.settings.describe().find(row=>row.ns==='secret-probe')!
  await assert.rejects(ctx.settings.update(secret.ns,{token:'new-value'},secret.revision),denied)
  assert.equal(readFileSync(profile.patchPath,'utf8'),before)
})

test('base persistence errors propagate unchanged without retry or alternate writes',async t=>{
  const ctx=new Context(),editor=new GuiConfigEditor(ctx),failure=Object.assign(new Error('fixture storage failure'),{code:'ENOSPC'});t.after(()=>ctx.fiber.dispose())
  let calls=0
  t.mock.method(ConfigEditor.prototype,'edit',async()=>{calls++;throw failure})
  await assert.rejects(editor.edit(entry(),current=>({...current,preference:'dark'})),error=>error===failure)
  assert.equal(calls,1)
})
test('validation snapshots the latest serialized current config, not a pre-lock value',async t=>{
  const ctx=new Context(),editor=new GuiConfigEditor(ctx);t.after(()=>ctx.fiber.dispose())
  const current={preference:'system',fontSize:14,opaque:{revision:'old'}},ready=Promise.withResolvers<void>()
  let saved:Record<string,unknown>|undefined
  t.mock.method(ConfigEditor.prototype,'edit',async(_row:Entry,change:(c:Record<string,unknown>,i:Record<string,unknown>)=>Record<string,unknown>)=>{await ready.promise;saved=change(current,{})})
  const editing=editor.edit(entry(),c=>({...c,preference:'dark'}))
  current.fontSize=16;current.opaque.revision='latest';ready.resolve();await editing
  assert.deepEqual(saved,{preference:'dark',fontSize:16,opaque:{revision:'latest'}})
})
test('real parallel SettingsForms writes with one revision serialize and retain one winning value',async t=>{
  const {readFileSync}=await import('node:fs')
  const {ctx,profile}=await configurationFixture(t),theme=ctx.settings.describe().find(row=>row.ns==='ui-theme')!
  const outcomes=await Promise.allSettled([
    ctx.settings.update(theme.ns,{preference:'dark'},theme.revision),
    ctx.settings.update(theme.ns,{preference:'light'},theme.revision),
  ])
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1)
  const failed=outcomes.find(result=>result.status==='rejected')as PromiseRejectedResult
  assert.equal(failed.reason.code,'SETTINGS_CONFLICT')
  const final=ctx.settings.describe().find(row=>row.ns==='ui-theme')!.value.preference
  assert.ok(final==='dark'||final==='light')
  assert.match(readFileSync(profile.patchPath,'utf8'),new RegExp(`preference: ${final}`))
})
