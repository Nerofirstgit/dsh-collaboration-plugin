/** Offline overlay generation only: no Loader activation, socket, model or real profile edits. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import yaml from 'js-yaml'
import {entryListSchema} from '@deepseek-ai/cordis-plugin-include'
import {GUI_ROOT_MODULES} from '../src/host/gui-profile-contract.ts'
import {generateGuiOverlay,runGuiConfigure} from '../src/gui-configure.ts'

function base(){return Object.entries(GUI_ROOT_MODULES).filter(([id])=>id!=='preset-collaboration').map(([id,name])=>({id,name}))}
function args(home=resolve('/tmp/gui-config-home')){return {surface:'web' as const,home,profile_dir:join(home,'profiles','web'),data_dir:join(home,'coordinator')}}
test('offline generator accepts official inert JS tags without evaluating or copying credential secrets',()=>{
  const rows=base();rows.find(row=>row.id==='llm-deepseek')!.config={apiKey:'fixture-secret'} as never
  const input=yaml.dump(rows)+'\n'
  const text=generateGuiOverlay(input,args())
  assert.ok(text.includes('profile_mode: gui'));assert.ok(!text.includes('fixture-secret'))
  assert.ok(Array.isArray(yaml.load(text,{schema:entryListSchema})))
  const inert=generateGuiOverlay(input.replace('apiKey: fixture-secret','apiKey: !!js "throw new Error(\'never execute\')"'),args())
  assert.ok(!inert.includes('never execute'))
})
for(const input of ['null','{}','[1]','- id: tools\n  name: 42','[\n', '- id: unknown\n  name: unknown'])test('invalid/missing pinned input rejects without activation '+JSON.stringify(input),()=>{
  assert.throws(()=>generateGuiOverlay(input,args()))
})
test('CLI writes only a new explicit UTF-8 overlay and never overwrites the input or existing output',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dsh-gui-config-'))
  try{
    const input=join(dir,'dump.yml'),output=join(dir,'overlay.yml'),home=join(dir,'home'),original=yaml.dump(base())
    writeFileSync(input,original)
    const argv=['--input',input,'--surface','desktop','--home',home,'--profile-dir',join(home,'profiles','desktop'),'--data-dir',join(dir,'data'),'--output',output]
    const out:string[]=[],err:string[]=[];const io={out:(s:string)=>out.push(s),err:(s:string)=>err.push(s)}
    assert.equal(runGuiConfigure(argv,io),0);assert.equal(out.length,0);assert.equal(err.length,0)
    const generated=readFileSync(output,'utf8');assert.ok(generated.includes('gui_surface: desktop'));assert.equal(readFileSync(input,'utf8'),original)
    assert.equal(runGuiConfigure(argv,io),1);assert.equal(readFileSync(output,'utf8'),generated)
    assert.ok(err.join('').includes('GUI_CONFIG_FAILED'));assert.ok(!err.join('').includes(dir))
  }finally{rmSync(dir,{recursive:true,force:true})}
})
for(const argv of [[],['--help','--input','x'],['--input','x','--input','y'],['--unknown','x']])test('CLI refuses ambiguous/incomplete arguments '+argv.join(' '),()=>{
  const errors:string[]=[];assert.equal(runGuiConfigure(argv,{out:()=>assert.fail('unexpected output'),err:s=>errors.push(s)}),1)
  assert.ok(errors.join('').includes('GUI_CONFIG_FAILED'))
})
test('executable help runs without any profile or environment configuration',()=>{
  const result=spawnSync(process.execPath,['--import','tsx/esm','src/gui-configure.ts','--help'],{cwd:process.cwd(),encoding:'utf8',timeout:10_000})
  assert.equal(result.status,0,result.stderr);assert.ok(result.stdout.includes('--input'));assert.ok(result.stdout.includes('does not launch Harness'))
})
