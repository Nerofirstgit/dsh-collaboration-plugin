/** Protocol data exchanged only by trusted runtime adapters. */
export interface RuntimeIdentity {
  session_id: string
  incarnation_id: string
  execution_epoch: number
  coordinator_epoch: number
  coordinator_domain: string
  runtime_token: string
}
export type SessionState = 'starting' | 'running' | 'waiting' | 'idle' | 'interrupted' | 'completed' | 'failed'
export interface Clock { utc(): number; monotonic(): number }
export const systemClock: Clock = { utc: () => Date.now(), monotonic: () => performance.now() }
export interface SessionRow {
  id: string; project_id: string; workspace_id: string; incarnation_id: string
  execution_epoch: number; token_hash: string; title: string; task_summary: string
  state: SessionState; host_id: string; started_at: number; last_heartbeat_at: number
  last_heartbeat_mono: number; owner_epoch: number; deleted: number; context_revision: number
}
export interface WorkspaceRow { id: string; project_id: string; root: string; protected: number; recovery_state: string }
export interface SessionSummary {
  id: string; project_id: string; workspace_id: string; title: string; task_summary: string
  state: SessionState; presence: 'online' | 'offline'; workspace: string; started_at: string; last_heartbeat_at: string
}
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonRecord = { [key: string]: Json }
export interface Config {
  enabled: boolean; data_dir: string; communication_policy: 'explicit_only' | 'same_project_enabled'
  heartbeat_ms: number; offline_ms: number; lease_ttl_ms: number; auto_renew: boolean
  message_limit_bytes: number; mailbox_limit_bytes: number; injection_budget: number
  fragment_bytes: number; max_snapshot_items: number; event_retention_ms: number; snapshot_ttl_ms: number; max_read_bytes: number
}
