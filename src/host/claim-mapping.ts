/** Bind original host path spellings to the coordinator's durable canonical claim decision. */
import {CoordinationError} from '../errors.ts'
import type {ManagedClaim} from './claims.ts'
function invalid():never {
  throw new CoordinationError('STORAGE_ERROR','Rename requires the original durable path-to-lease mapping. Query the original mutation before retrying; do not infer aliases, acquire a new claim, or replay an uncertain rename.',{recovery_action:'Use get_mutation_status with the original mutation ID. For a legacy unmapped claim, reconcile that operation first and restart an upgraded coordinator before new work.'})
}
function object(value:unknown):Record<string,unknown>{if(value===null||typeof value!=='object'||Array.isArray(value))invalid();return value as Record<string,unknown>}
function positive(value:unknown):boolean{return typeof value==='number'&&Number.isSafeInteger(value)&&value>0}
export function renameClaimGroup(value:unknown,requestedSource:string,requestedTarget:string):{group:ManagedClaim[];source:ManagedClaim;destination:ManagedClaim}{
  const result=object(value)
  if(!Array.isArray(result.claims)||!Array.isArray(result.path_mappings))invalid()
  const group=result.claims as ManagedClaim[],paths=new Set<string>(),leases=new Set<string>()
  for(const raw of group){
    const claim=object(raw)
    if(typeof claim.path!=='string'||!claim.path||typeof claim.lease_id!=='string'||!claim.lease_id||!positive(claim.coordinator_epoch)||!positive(claim.fencing_token)||claim.active!==undefined&&typeof claim.active!=='boolean')invalid()
    if(paths.has(claim.path)||leases.has(claim.lease_id))invalid()
    paths.add(claim.path);leases.add(claim.lease_id)
  }
  const requested=new Set([requestedSource,requestedTarget]),mapped=new Map<string,ManagedClaim>(),used=new Set<ManagedClaim>()
  for(const raw of result.path_mappings){
    const mapping=object(raw)
    if(typeof mapping.requested_path!=='string'||!requested.has(mapping.requested_path)||mapped.has(mapping.requested_path))invalid()
    const claim=group.find(candidate=>candidate.path===mapping.path&&candidate.lease_id===mapping.lease_id)
    if(!claim)invalid()
    mapped.set(mapping.requested_path,claim);used.add(claim)
  }
  if(mapped.size!==requested.size||used.size!==group.length)invalid()
  const source=mapped.get(requestedSource)!,destination=mapped.get(requestedTarget)!
  if(source===destination)throw new CoordinationError('INVALID_ARGUMENT','Rename requires distinct canonical source and destination claims.')
  if(source.coordinator_epoch!==destination.coordinator_epoch)invalid()
  if(source.active===false||destination.active===false)throw new CoordinationError('LEASE_EXPIRED','Original rename claim group is no longer active; do not replay an uncertain rename.')
  return {group,source,destination}
}
