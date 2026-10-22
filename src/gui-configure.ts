#!/usr/bin/env node
/** Offline, opt-in generation of an isolated pinned GUI candidate overlay. */
import {readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs'
import {isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {entryListSchema} from '@deepseek-ai/cordis-plugin-include'
import {buildGuiOverlay,type GuiBaseEntry,type GuiOverlayInput} from './host/gui-profile.ts'
import {CoordinationError} from './errors.ts'

// Keep the CLI boundary typed narrowly; the pinned package publishes no TypeScript declarations.
const yaml=createRequire(import.meta.url)('js-yaml') as {
  load(input:string,options:{schema:unknown}):unknown
  dump(input:unknown,options:{schema:unknown;noRefs:boolean;lineWidth:number}):string
}
const MAX_INPUT_BYTES=16*1024*1024
export const GUI_CONFIGURE_USAGE=`Usage: dsh-collaboration-gui-config --input <absolute composed-dump.yml> --surface web|desktop --home <absolute isolated DSH_HOME> --profile-dir <absolute profile directory> --data-dir <absolute coordinator directory> [--output <new absolute overlay.yml>]

Generate a pinned 0.2.1-rc.2 GUI candidate overlay only. This does not launch Harness,
activate plugins, change an existing profile, create credentials, or certify Windows.
The input must be an official --dump-config after the collaboration bundle is included.
Default output is stdout; --output creates a NEW UTF-8 file and refuses overwrite.
Use only isolated test profiles until native Windows and actual GUI acceptance pass.
`
export type GuiConfigureInput=Omit<GuiOverlayInput,'existing_entries'>
function invalid():never{throw new CoordinationError('INVALID_ARGUMENT','Invalid GUI overlay input or command arguments.')}
/** Official !!js expressions remain inert parser values; no expression is evaluated. */
export function generateGuiOverlay(input:string,options:GuiConfigureInput):string{
  if(Buffer.byteLength(input,'utf8')>MAX_INPUT_BYTES)invalid()
  let parsed:unknown
  try{parsed=yaml.load(input,{schema:entryListSchema})}catch{invalid()}
  if(!Array.isArray(parsed))invalid()
  const rows:GuiBaseEntry[]=parsed.map((row:unknown)=>{
    if(row===null||typeof row!=='object'||Array.isArray(row))invalid()
    const value=row as Record<string,unknown>
    if(typeof value.id!=='string'||typeof value.name!=='string'||(value.disabled!==undefined&&typeof value.disabled!=='boolean'))invalid()
    return {id:value.id,name:value.name,...(value.disabled!==undefined?{disabled:value.disabled as boolean}:{}),config:value.config,inject:value.inject}
  })
  const patches=buildGuiOverlay({...options,existing_entries:rows})
  return '# Generated candidate overlay; no Harness startup or Windows acceptance has been performed.\n'+yaml.dump(patches,{schema:entryListSchema,noRefs:true,lineWidth:120})
}
interface Output {out(text:string):void;err(text:string):void}
export function runGuiConfigure(argv:readonly string[],io:Output={out:text=>process.stdout.write(text),err:text=>process.stderr.write(text)}):number{
  try{
    if(argv.length===1&&argv[0]==='--help'){io.out(GUI_CONFIGURE_USAGE);return 0}
    const allowed=new Set(['--input','--surface','--home','--profile-dir','--data-dir','--output']),values=new Map<string,string>()
    for(let i=0;i<argv.length;i+=2){
      const key=argv[i]!,value=argv[i+1]
      if(!allowed.has(key)||values.has(key)||value===undefined||value.startsWith('--'))invalid()
      values.set(key,value)
    }
    const get=(key:string):string=>{const value=values.get(key);if(value===undefined)invalid();return value}
    const path=(key:string):string=>{const value=get(key);if(!isAbsolute(value)||value.includes('\0'))invalid();return value}
    const surface=get('--surface');if(surface!=='web'&&surface!=='desktop')invalid()
    const input=path('--input'),home=path('--home'),profile_dir=path('--profile-dir'),data_dir=path('--data-dir')
    const metadata=statSync(input)
    if(!metadata.isFile()||metadata.size>MAX_INPUT_BYTES)invalid()
    const output=generateGuiOverlay(readFileSync(input,'utf8'),{surface,home,profile_dir,data_dir})
    if(values.has('--output'))writeFileSync(path('--output'),output,{encoding:'utf8',flag:'wx',mode:0o600})
    else io.out(output)
    return 0
  }catch{
    // Never echo YAML excerpts, original config values, paths, credentials or a parser stack.
    io.err('GUI_CONFIG_FAILED: Check the required absolute paths, pinned composed input, and that the output does not already exist. Use --help.\n')
    return 1
  }
}
function invokedDirectly():boolean{
  if(!process.argv[1])return false
  try{return realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url))}catch{return false}
}
if(invokedDirectly())process.exitCode=runGuiConfigure(process.argv.slice(2))
