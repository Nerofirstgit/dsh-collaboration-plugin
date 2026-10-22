/**
 * Durable, append-only exclusion of Harness GUI state from all participating
 * workspaces in this coordinator domain. This is not a model tool or a grant.
 * No automatic retirement: stopped profiles may still have writes or sessions.
 */
import {isAbsolute,normalize} from 'node:path'
import {Store} from './store.ts'
import {CoordinationError,fail} from './errors.ts'
import {noExtra,record,string} from './util.ts'
import {canonicalExistingDirectory,withinCanonical} from './platform/resource-paths.ts'

const TABLE='host_state_reservations'
const SCHEMA='host-state-roots-v1'
export interface HostStateReservation {roots:string[]}
function corrupt(message:string):never {
 fail('STORAGE_ERROR',message,{recovery_action:'Stop participating profiles and preserve the coordinator database. Restore the reserved directories or use an explicit audited state-root retirement/migration; never erase reservations to admit a workspace.'})
}
function storedPath(value:unknown):string {
 if(typeof value!=='string'||!value||!value.isWellFormed()||value.includes('\0')||!isAbsolute(value)||normalize(value)!==value)corrupt('Stored host-state/workspace root is not a canonical absolute path.')
 return value
}
function readRoots(store:Store):string[] {
 try{
  const rows=store.db.prepare(`SELECT singleton,snapshot FROM ${TABLE}`).all()
  if(rows.length!==1||rows[0]!.singleton!==1||typeof rows[0]!.snapshot!=='string')corrupt('Established host-state reservation singleton is missing or malformed.')
  const value=record(JSON.parse(rows[0]!.snapshot));noExtra(value,['schema','roots'])
  if(value.schema!==SCHEMA||!Array.isArray(value.roots))corrupt('Unsupported or malformed host-state reservation schema.')
  const roots:string[]=[],seen=new Set<string>()
  for(const valueRoot of value.roots){
   const root=storedPath(valueRoot)
   if(canonicalExistingDirectory(root)!==root||seen.has(root))corrupt('Stored host-state roots are not unique canonical existing directories.')
   seen.add(root);roots.push(root)
  }
  return roots
 }catch(error){
  if(error instanceof CoordinationError&&error.code==='STORAGE_ERROR')throw error
  return corrupt('Cannot validate the established host-state reservation snapshot; refusing admission and recovery.')
 }
}
function assertStoredWorkspacesDisjoint(store:Store,roots:readonly string[],code:'WORKSPACE_OVERLAP'|'STORAGE_ERROR'):void {
 const workspaces=store.db.prepare('SELECT root FROM workspaces').all()
 if(process.platform==='win32'&&workspaces.length&&store.db.prepare("SELECT value FROM metadata WHERE key='windows_identity_scheme'").get()?.value!=='canonical-components-v1')corrupt('Stored Windows workspace identities require an explicit offline canonical-identity migration.')
 for(const workspace of workspaces){
  // Historical/offline directories may be absent. Keep their canonical path
  // slots reserved; never discard a workspace because a session disconnected.
  const workspaceRoot=storedPath(workspace.root)
  for(const root of roots)if(withinCanonical(root,workspaceRoot)||withinCanonical(workspaceRoot,root))fail(code,'Harness state root overlaps an existing protected workspace.',{state_root:root,workspace_root:workspaceRoot})
 }
}
/** First feature migration is atomic; an existing table with a lost row is NOT new. */
export function initializeHostStateReservations(store:Store):void {
 store.transaction(()=>{
  const existing=store.db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(TABLE)
  if(existing===undefined){
   store.db.exec(`CREATE TABLE ${TABLE}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),snapshot TEXT NOT NULL)`)
   store.db.prepare(`INSERT INTO ${TABLE}(singleton,snapshot) VALUES(1,?)`).run(JSON.stringify({schema:SCHEMA,roots:[]}))
  }else if(existing.type!=='table')corrupt('Host-state reservation storage is not a table.')
  assertStoredWorkspacesDisjoint(store,readRoots(store),'STORAGE_ERROR')
 })
}
/** Caller is trusted runtime setup, before any GUI state provider is activated. */
export function reserveHostStateRoots(store:Store,input:unknown):HostStateReservation {
 const request=record(input);noExtra(request,['roots'])
 if(!Array.isArray(request.roots)||request.roots.length<1||request.roots.length>64)fail('INVALID_ARGUMENT','roots must contain 1–64 existing absolute Harness state directories.')
 const requested=[...new Set(request.roots.map(value=>canonicalExistingDirectory(string(value,'state root',131072))))].sort()
 return store.transaction(()=>{
  const previous=readRoots(store),roots=[...new Set([...previous,...requested])].sort()
  assertStoredWorkspacesDisjoint(store,roots,'WORKSPACE_OVERLAP')
  if(roots.length!==previous.length){
   const saved=store.db.prepare(`UPDATE ${TABLE} SET snapshot=? WHERE singleton=1`).run(JSON.stringify({schema:SCHEMA,roots}))
   if(Number(saved.changes)!==1||JSON.stringify(readRoots(store).sort())!==JSON.stringify(roots))corrupt('Host-state reservation was not durably recorded as requested; GUI readiness must remain blocked.')
  }
  return{roots:requested}
 })
}
/** Must be called INSIDE the same admission transaction that inserts a workspace. */
export function assertWorkspaceOutsideHostState(store:Store,canonicalWorkspaceRoot:string):void {
 for(const root of readRoots(store))if(withinCanonical(root,canonicalWorkspaceRoot)||withinCanonical(canonicalWorkspaceRoot,root))fail('PATH_NOT_ALLOWED','Protected workspace overlaps a durably reserved Harness state directory.',{state_root:root,workspace_root:canonicalWorkspaceRoot})
}
