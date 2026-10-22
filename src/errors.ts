/** Stable, actionable failures; no hidden raw-write or retry fallback. */
export const ERROR_CODES = [
  'SESSION_NOT_FOUND','CROSS_PROJECT_DENIED','PERMISSION_REQUIRED','PAYLOAD_TOO_LARGE','FILE_BUSY',
  'LEASE_EXPIRED','STALE_FENCING_TOKEN','VERSION_CONFLICT','READ_REQUIRED','PATCH_PRECONDITION_FAILED',
  'IDEMPOTENCY_CONFLICT','OPERATION_ABORTED','IDEMPOTENCY_WINDOW_EXPIRED','STALE_INSTANCE','CONTEXT_CONFLICT',
  'RESOURCE_RECOVERING','WORKSPACE_OVERLAP','UNSUPPORTED_ATOMIC_OPERATION','MAILBOX_FULL',
  'DELIVERY_BUDGET_UNSATISFIABLE','STORAGE_ERROR','PATH_NOT_ALLOWED','UNMEDIATED_WRITE_DENIED',
  'COORDINATOR_UNAVAILABLE','OUTCOME_UNKNOWN','RESYNC_REQUIRED','INVALID_ARGUMENT','UNSUPPORTED_PLATFORM',
] as const
export type ErrorCode = typeof ERROR_CODES[number]
export class CoordinationError extends Error {
  readonly code: ErrorCode; readonly details: Record<string, unknown>; readonly retryable: boolean
  readonly recovery_action: string; readonly stop_condition: string
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}, retryable = false) {
    super(message); this.name = 'CoordinationError'; this.code = code; this.details = details; this.retryable = retryable
    this.recovery_action = typeof details.recovery_action === 'string' ? details.recovery_action : recoveryAction(code)
    this.stop_condition = 'Do not retry with a new operation identifier until the original outcome is established.'
  }
}
function recoveryAction(code: ErrorCode): string {
  switch (code) {
    case 'VERSION_CONFLICT': case 'READ_REQUIRED': case 'PATCH_PRECONDITION_FAILED': return 'Read the current file and construct a new explicit change.'
    case 'FILE_BUSY': return 'Release unneeded claims, coordinate with the owner, or work on an independent file.'
    case 'OUTCOME_UNKNOWN': case 'RESOURCE_RECOVERING': return 'Query the original mutation; keep affected resources frozen pending evidence-based recovery.'
    case 'STALE_INSTANCE': return 'Stop this executor and reconnect using the current logical session owner.'
    case 'PERMISSION_REQUIRED': return 'Ask the human to authorize the scoped communication action.'
    case 'RESYNC_REQUIRED': return 'Obtain a new consistent coordination snapshot and then read events after its watermark.'
    case 'UNMEDIATED_WRITE_DENIED': return 'Use managed file tools; unisolated shell, MCP and plugin side effects are disabled.'
    default: return 'Inspect the diagnostic and correct the request or restore the required service before retrying.'
  }
}
export function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): never { throw new CoordinationError(code, message, details) }
export interface Result<T> {
  status: 'success' | 'warning' | 'error'; summary: string; data: T | null
  error: null | { code: ErrorCode; message: string; retryable: boolean; details: Record<string, unknown>; recovery_action: string; stop_condition: string }
  next_actions: string[]; artifacts: { type: string; id?: string; path?: string }[]; request_id: string
}
export function success<T>(data: T, request_id: string): Result<T> { return {status:'success',summary:'Operation completed.',data,error:null,next_actions:[],artifacts:[],request_id} }
export function failure(error: unknown, request_id: string): Result<never> {
  const e = error instanceof CoordinationError ? error : new CoordinationError('STORAGE_ERROR', 'The operation failed; query any accepted mutation before retrying.')
  return {status:'error',summary:e.message,data:null,error:{code:e.code,message:e.message,retryable:e.retryable,details:e.details,recovery_action:e.recovery_action,stop_condition:e.stop_condition},next_actions:[e.recovery_action],artifacts:[],request_id}
}
