/** Read-only host filesystem provider; model-facing managed writes use the daemon RPC instead. */
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox';
/**
 * Keeps normal internal read/watch/path APIs while refusing every direct mutation.
 * Ordinary provider reads never mint write-authorizing receipts. The replacement
 * model read tool requests its exact displayed range from the trusted writer.
 */
export class ProtectedFileSystem extends LocalFileSystem {
    override get sandboxMode(): SandboxMode { return 'read-only'; }
    override async writeText(_target: FsTarget, _content: string, _expected?: FsWriteIntent, _signal?: AbortSignal, _sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome> {
        throw new HarnessError('Direct filesystem writes are disabled in this protected profile. Use the coordinated write tool; no per-call escalation can bypass its writer.', 'UNMEDIATED_WRITE_DENIED');
    }
    override async editText(_target: FsTarget, _edit: FsEditRequest, _expected?: {
        version: FsVersion;
    }, _signal?: AbortSignal, _sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome> {
        throw new HarnessError('Direct filesystem edits are disabled in this protected profile. Use the coordinated edit tool; no per-call escalation can bypass its writer.', 'UNMEDIATED_WRITE_DENIED');
    }
}
export default ProtectedFileSystem;
