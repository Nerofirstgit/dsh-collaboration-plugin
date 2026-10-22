/** Restricted presentation settings over the pinned host's real config-write lifecycle. */
import {isDeepStrictEqual} from 'node:util'
import type {Entry} from '@deepseek-ai/cordis-plugin-loader'
import {ConfigEditor} from '@deepseek-ai/dsh-config-editor'
import {CoordinationError} from '../errors.ts'

const MODULES:Readonly<Record<string,string>>=Object.freeze({
  'ui-theme':'@deepseek-ai/dsh-client-ui-theme',
  locale:'@deepseek-ai/dsh-client-locale',
})
const FONT_RANGES:Readonly<Record<string,readonly[number,number]>>=Object.freeze({
  fontSize:[10,22],codeFontSize:[10,16],terminalFontSize:[10,20],
})
const FONT_FAMILIES=new Set(['textFontFamily','codeFontFamily','terminalFontFamily'])
const LOCALE_ID=/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
function refuse(message:string):never {
  throw new CoordinationError('UNMEDIATED_WRITE_DENIED',`Protected GUI settings refused: ${message}`)
}
function identity(entry:Entry,expected?:string):string {
  const {id,name}=entry.options
  if(!Object.hasOwn(MODULES,id)||name!==MODULES[id]||(expected!==undefined&&id!==expected))refuse('namespace/module is outside the reviewed presentation settings')
  return id
}
function record(value:unknown):asserts value is Record<string,unknown> {
  if(value===null||typeof value!=='object'||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))refuse('callback must return an ordinary configuration object')
  for(const key of Reflect.ownKeys(value)){
    const property=Object.getOwnPropertyDescriptor(value,key)!
    if(typeof key!=='string'||!property.enumerable||!Object.hasOwn(property,'value'))refuse('configuration must contain enumerable data fields only')
  }
}
function copy(value:Record<string,unknown>):Record<string,unknown>{
  try{return structuredClone(value)}catch{refuse('configuration is not cloneable data')}
}
function accepts(namespace:string,field:string,value:unknown):boolean {
  // Removal/undefined resets a raw override; the base editor still applies the
  // real schema/defaults and verifies the effective composed configuration.
  if(namespace==='locale')return field==='preference'&&(value===undefined||typeof value==='string'&&LOCALE_ID.test(value))
  if(field==='preference')return value===undefined||value==='light'||value==='dark'||value==='system'
  const range=Object.hasOwn(FONT_RANGES,field)?FONT_RANGES[field]:undefined
  if(range!==undefined)return value===undefined||typeof value==='number'&&Number.isInteger(value)&&value>=range[0]&&value<=range[1]
  return FONT_FAMILIES.has(field)&&(value===undefined||typeof value==='string')
}

/**
 * Mount instead of the stock ConfigEditor, never beside it. Stock SettingsForms
 * remains responsible for redaction, volatile-field projection and revisions.
 * Only ui-theme presentation fields and locale.preference may change here.
 *
 * This does not authorize a GUI profile, validate its state roots, sandbox
 * arbitrary plugins, or certify the base editor's Windows I/O implementation.
 */
export class GuiConfigEditor extends ConfigEditor {
  override async edit(
    entry:Entry,
    change:(current:Record<string,unknown>,inherited:Record<string,unknown>)=>Record<string,unknown>,
  ):Promise<void>{
    const namespace=identity(entry)
    await super.edit(entry,(current,inherited)=>{
      // Run after the base editor obtains its normal lock and refreshes the
      // current profile, not against a stale pre-lock configuration snapshot.
      identity(entry,namespace)
      record(current)
      const before=copy(current)
      const next=change(current,copy(inherited))
      identity(entry,namespace)
      record(next)
      for(const field of new Set([...Object.keys(before),...Object.keys(next)])){
        if(Object.hasOwn(before,field)===Object.hasOwn(next,field)&&isDeepStrictEqual(before[field],next[field]))continue
        // Changed values can only be primitives. Structural __jsExpr / YAML
        // code-tag objects cannot enter the base editor's expression serializer.
        if(!accepts(namespace,field,next[field]))refuse('only reviewed presentation fields may change')
      }
      // Detach callback-owned references before super.edit reaches an await.
      // Unknown fields are preserved, not reconstructed from an allowlist.
      return copy(next)
    })
  }
}
export default GuiConfigEditor
