import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { fail } from './errors.ts'
import type { Config } from './types.ts'
export { coordinatorEndpoint } from './platform/ipc.ts'
/** Fixed OS-account namespace, independent of HOME/DSH_HOME/TMPDIR overrides. */
export function machineInstanceDirectory():string {
  return join(userInfo().homedir,'.dsh-collaboration-instance')
}
/** Deployment settings are validated once at the trusted plugin configuration boundary. */
export function resolveConfig(value: Partial<Config> = {}): Config {
  const config: Config = {
    enabled:true, data_dir:join(process.env.XDG_DATA_HOME??join(homedir(),'.local','share'),'deepseek-harness','collaboration'),
    communication_policy:'explicit_only',heartbeat_ms:10000,offline_ms:45000,lease_ttl_ms:60000,auto_renew:true,
    fragment_bytes:512,max_snapshot_items:10000,message_limit_bytes:8192,mailbox_limit_bytes:10*1024*1024,injection_budget:2000,event_retention_ms:7*86400000,
    snapshot_ttl_ms:60000,max_read_bytes:1024*1024,
  }
  // The plugin has per-process workspace/read-display options. Never persist
  // those as shared coordinator configuration or worktrees cannot share a domain.
  for(const key of Object.keys(config) as (keyof Config)[])if(value[key]!==undefined)(config as unknown as Record<string,unknown>)[key]=value[key]
  if(typeof config.enabled!=='boolean'||typeof config.auto_renew!=='boolean')fail('INVALID_ARGUMENT','enabled and auto_renew must be boolean.')
  if(!['explicit_only','same_project_enabled'].includes(config.communication_policy))fail('INVALID_ARGUMENT','Invalid communication policy.')
  for(const key of ['fragment_bytes','max_snapshot_items','heartbeat_ms','offline_ms','lease_ttl_ms','message_limit_bytes','mailbox_limit_bytes','injection_budget','event_retention_ms','snapshot_ttl_ms','max_read_bytes'] as const)if(!Number.isSafeInteger(config[key])||config[key]<=0)fail('INVALID_ARGUMENT',`${key} must be a positive safe integer.`)
  if(config.offline_ms<=config.heartbeat_ms)fail('INVALID_ARGUMENT','offline_ms must exceed heartbeat_ms.')
  if(typeof config.data_dir!=='string'||config.data_dir.length===0)fail('INVALID_ARGUMENT','data_dir is required.')
  config.data_dir=resolve(config.data_dir)
  return config
}
