/** Linux-only trusted single-daemon writer. No client receives direct filesystem authority. */
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, writeSync, fsyncSync, mkdirSync, fchmodSync, renameSync, unlinkSync, linkSync, rmdirSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import type { Config, RuntimeIdentity, SessionRow, WorkspaceRow } from './types.ts';
import { CoordinationError, fail } from './errors.ts';
import { renameNoReplace } from './native-rename.ts';
import { canonical, digest, fingerprint, integer, noExtra, record, string } from './util.ts';
export interface ReadRange {
    start: number;
    end: number;
}
export interface ReadRequest {
    path: string;
    range?: ReadRange;
    line_range?: {
        offset: number;
        limit: number;
    };
    max_bytes?: number;
}
export interface ReadResult {
    content: string;
    version: string;
    read_token: string;
    truncated: boolean;
    byte_range: ReadRange;
    total_lines: number;
    offset: number;
    file_activity: {
        owner_session_id: string | null;
    };
}
export interface Claim {
    path: string;
    lease_id: string;
    coordinator_epoch: number;
    fencing_token: number;
    expires_at: string;
    active?: boolean;
}
export interface StructuredPatch {
    start: number;
    old_text: string;
    new_text: string;
}
export interface FileChange {
    path: string;
    operation: 'create' | 'replace' | 'patch' | 'delete' | 'rename';
    expected_version: string | null;
    read_token?: string;
    lease_id: string;
    coordinator_epoch: number;
    fencing_token: number;
    mutation_id: string;
    content?: string;
    patch?: StructuredPatch;
    target_path?: string;
    expected_target_version?: string | null;
    target_lease_id?: string;
    target_fencing_token?: number;
}
export interface MutationResult {
    mutation_id: string;
    previous_version: string | null;
    new_version: string | null;
    event_cursor: string;
    no_op: boolean;
    destination_path?: string;
    destination_version?: string;
}
export interface MutationStatus {
    state: 'not_found' | 'prepared' | 'applied' | 'committed' | 'aborted' | 'needs_recovery';
    original_result: MutationResult | null;
    recovery_action: string | null;
    affected_paths?: string[];
    recovery_reason?: string | null;
}
export type FaultPoint = 'after_prepared' | 'after_temp_flush' | 'after_evidence' | 'before_publish' | 'after_publish' | 'after_publish_evidence' | 'after_directory_flush' | 'before_commit' | 'after_durable_commit_before_cleanup' | 'after_commit';
interface LeaseRow {
    lease_id: string;
    workspace_id: string;
    resource_key: string;
    owner_session_id: string;
    owner_incarnation_id: string;
    execution_epoch: number;
    coordinator_epoch: number;
    fencing_token: number;
    expires_mono: number;
    expires_at: number;
    active: number;
}
interface FileInfo {
    dev: string;
    ino: string;
    mode: number;
    size: number;
    mtime: string;
    ctime: string;
    nlink: number;
}
interface Snapshot {
    bytes: Buffer;
    version: string;
    info: FileInfo;
}
interface Evidence {
    old: FileInfo | null;
    old_version: string | null;
    new_version: string | null;
    staged: FileInfo | null;
    artifact: string;
    directory: FileInfo | null;
    published: boolean;
    no_op: boolean;
    rename?: {target:string;source_parent:FileInfo;target_parent:FileInfo};
}
interface MutationRow {
    mutation_id: string;
    workspace_id: string;
    session_id: string;
    incarnation_id: string;
    coordinator_epoch: number;
    request_fingerprint: string;
    operation: FileChange['operation'];
    resource_key: string;
    request: string;
    state: Exclude<MutationStatus['state'], 'not_found'>;
    evidence: string;
    original_result: string | null;
    error: string | null;
    created_at: number;
}
const INFO_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
function fsCode(error: unknown): string | undefined {
    return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}
function info(s: BigIntStats): FileInfo {
    return { dev: String(s.dev), ino: String(s.ino), mode: Number(s.mode & 511n), size: Number(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs), nlink: Number(s.nlink) };
}
function sameInode(a: FileInfo | null, b: FileInfo | null): boolean {
    return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}
function stable(a: FileInfo, b: FileInfo): boolean {
    return sameInode(a, b) && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;
}
function leaseRow(value: unknown): LeaseRow | undefined {
    if (value === undefined)
        return undefined;
    const row = record(value);
    for (const key of ['lease_id', 'workspace_id', 'resource_key', 'owner_session_id', 'owner_incarnation_id'])
        if (typeof row[key] !== 'string')
            fail('STORAGE_ERROR', 'Invalid persisted lease identity.');
    for (const key of ['execution_epoch', 'coordinator_epoch', 'fencing_token', 'expires_mono', 'expires_at', 'active'])
        if (typeof row[key] !== 'number' || !Number.isFinite(row[key]))
            fail('STORAGE_ERROR', 'Invalid persisted lease fields.');
    return value as LeaseRow;
}
function mutationRow(value: unknown): MutationRow | undefined {
    if (value === undefined)
        return undefined;
    const row = record(value);
    for (const key of ['mutation_id', 'workspace_id', 'session_id', 'incarnation_id', 'request_fingerprint', 'resource_key', 'request', 'evidence'])
        if (typeof row[key] !== 'string')
            fail('STORAGE_ERROR', 'Invalid persisted mutation fields.');
    if (!['create', 'replace', 'patch', 'delete', 'rename'].includes(String(row.operation)) || !['prepared', 'applied', 'committed', 'aborted', 'needs_recovery'].includes(String(row.state)))
        fail('STORAGE_ERROR', 'Invalid persisted mutation state.');
    return value as MutationRow;
}
function resourceKey(root: string, path: string): string {
    if (typeof path !== 'string' || path.length === 0 || !path.isWellFormed() || path.includes('\0'))
        fail('PATH_NOT_ALLOWED', 'Invalid file path.');
    const candidate = isAbsolute(path) ? relative(root, path) : path, segments = candidate.split('/');
    if (segments.some(s => s === '' || s === '.' || s === '..' || s === '.git' || s.startsWith('.dsh-collab-')) || isAbsolute(candidate))
        fail('PATH_NOT_ALLOWED', 'Path escapes the workspace or names an unsupported reserved resource.');
    return segments.join('/');
}
function version(bytes: Uint8Array): string {
    return 'sha256:' + digest(bytes);
}
function parseText(bytes: Uint8Array): string {
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    catch {
        fail('PATH_NOT_ALLOWED', 'Only well-formed UTF-8 regular files are supported.');
    }
}
function textBytes(value: unknown, field: string, maximum: number): Buffer {
    if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0'))
        fail('INVALID_ARGUMENT', `${field} must be well-formed UTF-8 text without NUL.`);
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > maximum)
        fail('PAYLOAD_TOO_LARGE', `${field} exceeds the managed file limit.`);
    return bytes;
}
function evidenceOf(row: MutationRow): Evidence {
    const value = record(JSON.parse(row.evidence)), request = record(JSON.parse(row.request));
    const validVersion = (v: unknown): boolean => v === null || (typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v));
    const fileInfo = (v: unknown): FileInfo | null => {
        if (v === null)
            return null;
        const item = record(v);
        for (const field of ['dev', 'ino'])
            if (typeof item[field] !== 'string' || !/^\d+$/.test(item[field] as string))
                fail('STORAGE_ERROR', 'Invalid persisted inode evidence.');
        for (const field of ['mtime', 'ctime'])
            if (typeof item[field] !== 'string' || !/^[-]?\d+$/.test(item[field] as string))
                fail('STORAGE_ERROR', 'Invalid persisted timestamp evidence.');
        for (const field of ['mode', 'size', 'nlink'])
            if (!Number.isSafeInteger(item[field]) || Number(item[field]) < 0)
                fail('STORAGE_ERROR', 'Invalid persisted file metadata.');
        if (Number(item.mode) > 0o777)
            fail('STORAGE_ERROR', 'Unsupported persisted file permissions.');
        return v as FileInfo;
    };
    if (typeof value.artifact !== 'string' || !/^\.dsh-collab-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.artifact) || typeof value.published !== 'boolean' || typeof value.no_op !== 'boolean' || !validVersion(value.old_version) || !validVersion(value.new_version))
        fail('STORAGE_ERROR', 'Corrupt mutation evidence.');
    const evidence: Evidence = { artifact: value.artifact, published: value.published, no_op: value.no_op, old_version: value.old_version as string | null, new_version: value.new_version as string | null, old: fileInfo(value.old), staged: fileInfo(value.staged), directory: fileInfo(value.directory) };
    if(row.operation==='rename'){
        const rename=record(value.rename),sourceParent=fileInfo(rename.source_parent),targetParent=fileInfo(rename.target_parent);
        if(typeof rename.target!=='string'||rename.target!==request.target_path||request.expected_target_version!==null||sourceParent===null||targetParent===null||evidence.no_op||evidence.directory!==null||evidence.staged!==null)fail('STORAGE_ERROR','Corrupt rename namespace evidence.');
        evidence.rename={target:rename.target,source_parent:sourceParent,target_parent:targetParent};
    }else if(value.rename!==undefined)fail('STORAGE_ERROR','Non-rename mutation carries rename evidence.');
    if (request.path !== row.resource_key || request.operation !== row.operation || fingerprint(request) !== row.request_fingerprint || request.expected_version !== evidence.old_version)
        fail('STORAGE_ERROR', 'Persisted request and recovery evidence disagree.');
    if ((row.operation === 'create') !== (evidence.old === null) || ((evidence.old === null) !== (evidence.old_version === null)) || ((row.operation === 'delete'||row.operation==='rename') !== (evidence.new_version === null)) || (evidence.staged !== null && evidence.directory === null))
        fail('STORAGE_ERROR', 'Persisted existence/type evidence is inconsistent.');
    if (evidence.no_op && (evidence.old === null || evidence.old_version !== evidence.new_version || evidence.staged !== null || evidence.directory !== null))
        fail('STORAGE_ERROR', 'Persisted no-op evidence is inconsistent.');
    if ((row.operation === 'replace' || row.operation === 'create') && (typeof request.content !== 'string' || !request.content.isWellFormed() || version(Buffer.from(request.content)) !== evidence.new_version))
        fail('STORAGE_ERROR', 'Persisted intended bytes and new version disagree.');
    return evidence;
}
/** A bounded read of a single opened inode; pathname and bytes must remain one snapshot. */
function regularSnapshot(path: string, maximum: number, maximumLinks = 1): Snapshot | null {
    let fd: number | undefined;
    try {
        const entry = lstatSync(path, { bigint: true });
        if (!entry.isFile() || entry.nlink < 1n || entry.nlink > BigInt(maximumLinks))
            fail('PATH_NOT_ALLOWED', 'Only supported single-link ordinary files are allowed.');
        fd = openSync(path, INFO_FLAGS);
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink < 1n || before.nlink > BigInt(maximumLinks) || !sameInode(info(entry), info(before)))
            fail('PATH_NOT_ALLOWED', 'File alias or type changed during open.');
        if (before.size > BigInt(maximum))
            fail('PAYLOAD_TOO_LARGE', 'File exceeds the managed read limit.');
        // A concurrent grow can consume at most one byte beyond the admitted size.
        const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
        let length = 0;
        while (length < buffer.length) {
            const count = readSync(fd, buffer, length, buffer.length - length, length);
            if (count === 0)
                break;
            length += count;
        }
        const after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
        if (length > maximum)
            fail('PAYLOAD_TOO_LARGE', 'File exceeds the managed read limit.');
        if (length !== Number(after.size) || !current.isFile() || !stable(info(before), info(after)) || !stable(info(after), info(current)) || after.nlink < 1n || after.nlink > BigInt(maximumLinks))
            fail('VERSION_CONFLICT', 'File changed during its byte snapshot; reread before modifying it.');
        const bytes = buffer.subarray(0, length);
        return { bytes, version: version(bytes), info: info(after) };
    }
    catch (error) {
        if (fsCode(error) === 'ENOENT' && fd === undefined)
            return null;
        if (error instanceof CoordinationError)
            throw error;
        return fail('PATH_NOT_ALLOWED', 'Cannot safely snapshot the regular file.', { cause: fsCode(error) ?? String(error) });
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
/** Descriptor chain pins every parent; managed directory/link operations are never exposed. */
class AnchoredPath {
    readonly key: string;
    readonly target: string;
    readonly parent: string;
    readonly leaf: string;
    private readonly descriptors: number[] = [];
    private readonly identities: FileInfo[] = [];
    private readonly segments: string[];
    private readonly root: string;
    constructor(root: string, path: string) {
        if (process.platform !== 'linux')
            fail('UNSUPPORTED_PLATFORM', 'Protected writer currently requires Linux /proc/self/fd and O_NOFOLLOW.');
        this.root = root;
        this.key = resourceKey(root, path);
        const segments = this.key.split('/');
        this.segments = segments.slice(0, -1);
        this.leaf = segments.at(-1)!;
        try {
            const fd = openSync(root, INFO_FLAGS | constants.O_DIRECTORY);
            this.descriptors.push(fd);
            this.identities.push(info(fstatSync(fd, { bigint: true })));
            for (const segment of this.segments) {
                const next = openSync(`/proc/self/fd/${this.descriptors.at(-1)!}/${segment}`, INFO_FLAGS | constants.O_DIRECTORY);
                this.descriptors.push(next);
                this.identities.push(info(fstatSync(next, { bigint: true })));
            }
            this.parent = `/proc/self/fd/${this.descriptors.at(-1)!}`;
            this.target = `${this.parent}/${this.leaf}`;
            this.revalidate();
        }
        catch (error) {
            this.close();
            if (error instanceof CoordinationError)
                throw error;
            fail('PATH_NOT_ALLOWED', 'Parent paths must be existing ordinary directories without links.', { cause: fsCode(error) ?? String(error) });
        }
    }
    revalidate(): void {
        try {
            const root = lstatSync(this.root, { bigint: true });
            if (!root.isDirectory() || !sameInode(info(root), this.identities[0]!))
                fail('PATH_NOT_ALLOWED', 'Workspace root changed during the operation.');
            for (let i = 0; i < this.segments.length; i++) {
                const current = lstatSync(`/proc/self/fd/${this.descriptors[i]!}/${this.segments[i]!}`, { bigint: true });
                if (!current.isDirectory() || !sameInode(info(current), this.identities[i + 1]!))
                    fail('PATH_NOT_ALLOWED', 'A parent directory changed during the operation.');
            }
        }
        catch (error) {
            if (error instanceof CoordinationError)
                throw error;
            fail('PATH_NOT_ALLOWED', 'Parent namespace changed during the operation.');
        }
    }
    snapshot(maximum: number, maximumLinks = 1): Snapshot | null {
        this.revalidate();
        const snapshot = regularSnapshot(this.target, maximum, maximumLinks);
        this.revalidate();
        return snapshot;
    }
    flush(): void {
        fsyncSync(this.descriptors.at(-1)!);
    }
    get parentFd():number{return this.descriptors.at(-1)!;}
    get parentInfo():FileInfo{return this.identities.at(-1)!;}
    close(): void {
        for (const fd of this.descriptors.splice(0).reverse())
            closeSync(fd);
    }
}
/** A private artifact directory is pinned and identity-checked just like target parents. */
class ArtifactDirectory {
    readonly entry: string;
    readonly path: string;
    readonly identity: FileInfo;
    private readonly fd: number;
    constructor(anchor: AnchoredPath, name: string, expected: FileInfo | null, create = false) {
        this.entry = `${anchor.parent}/${name}`;
        if (create)
            mkdirSync(this.entry, { mode: 0o700 });
        this.fd = openSync(this.entry, INFO_FLAGS | constants.O_DIRECTORY);
        try {
            this.identity = info(fstatSync(this.fd, { bigint: true }));
            if (expected !== null && !sameInode(expected, this.identity))
                fail('PATH_NOT_ALLOWED', 'Recovery artifact identity changed.');
            this.path = `/proc/self/fd/${this.fd}`;
            this.revalidate();
            if (create)
                fchmodSync(this.fd, 0o700);
        }
        catch (error) {
            closeSync(this.fd);
            throw error;
        }
    }
    revalidate(): void {
        const current = lstatSync(this.entry, { bigint: true });
        if (!current.isDirectory() || !sameInode(info(current), this.identity))
            fail('PATH_NOT_ALLOWED', 'Recovery artifact namespace changed.');
    }
    flush(): void {
        fsyncSync(this.fd);
    }
    close(): void {
        closeSync(this.fd);
    }
}
/** SQLite intents and fencing remain inside the process holding the coordinator OS instance lock. */
export class Writer {
    readonly store: Store;
    private readonly maximum: number;
    private readonly ttl: number;
    private readonly held = new Set<string>();
    /** Test-only failure injection. Production composition never exposes it to model tools or RPC. */
    fault: ((point: FaultPoint) => void) | undefined;
    constructor(store: Store, config: Partial<Config> = {}) {
        this.store = store;
        this.maximum = config.max_read_bytes ?? 8 * 1024 * 1024;
        this.ttl = config.lease_ttl_ms ?? 60000;
        integer(this.maximum, 'max_read_bytes', 1, 128 * 1024 * 1024);
        integer(this.ttl, 'lease_ttl_ms', 1, 3600000);
        store.db.exec(`CREATE TABLE IF NOT EXISTS resource_guards(workspace_id TEXT NOT NULL,resource_key TEXT NOT NULL,last_fencing_token INTEGER NOT NULL DEFAULT 0,recovery_state TEXT NOT NULL DEFAULT 'ready',PRIMARY KEY(workspace_id,resource_key));
      CREATE TABLE IF NOT EXISTS writer_leases(lease_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,resource_key TEXT NOT NULL,owner_session_id TEXT NOT NULL,owner_incarnation_id TEXT NOT NULL,execution_epoch INTEGER NOT NULL,coordinator_epoch INTEGER NOT NULL,fencing_token INTEGER NOT NULL,expires_mono REAL NOT NULL,expires_at INTEGER NOT NULL,active INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS writer_lease_resources ON writer_leases(workspace_id,resource_key,active);
      CREATE TABLE IF NOT EXISTS writer_requests(session_id TEXT NOT NULL,request_id TEXT NOT NULL,request_fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(session_id,request_id));
      CREATE TABLE IF NOT EXISTS file_mutations(mutation_id TEXT NOT NULL,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,incarnation_id TEXT NOT NULL,coordinator_epoch INTEGER NOT NULL,request_fingerprint TEXT NOT NULL,operation TEXT NOT NULL,resource_key TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,evidence TEXT NOT NULL,original_result TEXT,error TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,session_id,mutation_id));`);
    }
    private context(identity: RuntimeIdentity): {
        session: SessionRow;
        workspace: WorkspaceRow;
    } {
        const session = this.store.assertIdentity(identity), workspace = this.store.workspace(session.workspace_id);
        if (workspace.recovery_state !== 'ready')
            fail('RESOURCE_RECOVERING', 'Workspace is frozen pending recovery.');
        return { session, workspace };
    }
    private lock<T>(workspace: string, paths: string[], run: () => T): T {
        const keys = [...new Set(paths)].sort().map(p => workspace + '\0' + p);
        if (keys.some(k => this.held.has(k)))
            fail('RESOURCE_RECOVERING', 'Resource has an in-flight writer.');
        for (const key of keys)
            this.held.add(key);
        try {
            return run();
        }
        finally {
            for (const key of keys)
                this.held.delete(key);
        }
    }
    private guard(workspace: string, path: string): void {
        this.store.db.prepare('INSERT OR IGNORE INTO resource_guards(workspace_id,resource_key) VALUES(?,?)').run(workspace, path);
        const row = this.store.db.prepare('SELECT recovery_state FROM resource_guards WHERE workspace_id=? AND resource_key=?').get(workspace, path);
        if (row?.recovery_state !== 'ready')
            fail('RESOURCE_RECOVERING', 'Resource has an unresolved mutation.', { path });
    }
    private withPath<T>(root: string, path: string, run: (anchor: AnchoredPath) => T): T {
        const anchor = new AnchoredPath(root, path);
        try {
            return run(anchor);
        }
        finally {
            anchor.close();
        }
    }
    private key(root: string, path: string): string {
        return resourceKey(root, path);
    }
    private cachedRequest<T>(session: string, id: string, fp: string): T | undefined {
        const found = this.store.db.prepare('SELECT * FROM writer_requests WHERE session_id=? AND request_id=?').get(session, id);
        if (!found)
            return undefined;
        if (found.request_fingerprint !== fp)
            fail('IDEMPOTENCY_CONFLICT', 'Request ID already belongs to a different logical operation.');
        return JSON.parse(String(found.result)) as T;
    }
    private remember(session: string, id: string, fp: string, value: unknown): void {
        this.store.db.prepare('INSERT INTO writer_requests(session_id,request_id,request_fingerprint,result) VALUES(?,?,?,?)').run(session, id, fp, canonical(value));
    }
    private active(lease: LeaseRow): boolean {
        if(lease.active!==1||lease.coordinator_epoch!==this.store.epoch||lease.expires_mono<=this.store.clock.monotonic())return false;
        const owner=this.store.db.prepare('SELECT incarnation_id,execution_epoch,owner_epoch,deleted,state FROM sessions WHERE id=?').get(lease.owner_session_id);
        return owner!==undefined&&owner.deleted===0&&owner.owner_epoch===this.store.epoch&&owner.incarnation_id===lease.owner_incarnation_id&&owner.execution_epoch===lease.execution_epoch&&['running','starting'].includes(String(owner.state));
    }
    private claimView(lease: LeaseRow): Claim {
        return { path: lease.resource_key, lease_id: lease.lease_id, coordinator_epoch: lease.coordinator_epoch, fencing_token: lease.fencing_token, expires_at: new Date(lease.expires_at).toISOString() };
    }
    claimFiles(identity: RuntimeIdentity, input: {
        paths: string[];
        purpose: string;
        request_id: string;
        ttl_ms?: number;
    }): {
        claims: Claim[];
    } {
        noExtra(record(input), ['paths', 'purpose', 'request_id', 'ttl_ms']);
        const { session, workspace } = this.context(identity);
        string(input.request_id, 'request_id', 256);
        string(input.purpose, 'purpose', 4096);
        if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > 100)
            fail('INVALID_ARGUMENT', 'paths must contain 1–100 files.');
        const paths = [...new Set(input.paths.map(p => this.key(workspace.root, p)))].sort(), ttl = integer(input.ttl_ms ?? this.ttl, 'ttl_ms', 1, 3600000), fp = fingerprint({ action: 'claim', paths, purpose: input.purpose, ttl: input.ttl_ms ?? null });
        return this.lock(workspace.id, paths, () => this.store.transaction(() => {
            this.store.assertIdentity(identity);
            const cached = this.cachedRequest<{
                claims: Claim[];
            }>(session.id, input.request_id, fp);
            if (cached)
                return { claims: cached.claims.map(c => {
                        const lease = this.store.db.prepare('SELECT * FROM writer_leases WHERE lease_id=?').get(c.lease_id) as LeaseRow | undefined;
                        return { ...c, active: lease !== undefined && this.active(lease) && lease.owner_incarnation_id === identity.incarnation_id && lease.execution_epoch === identity.execution_epoch };
                    }) };
            if(!['running','starting'].includes(this.store.assertIdentity(identity).state))fail('LEASE_EXPIRED','Stopped or waiting work cannot begin a new file claim.');
            for (const path of paths) {
                this.guard(workspace.id, path);
                this.withPath(workspace.root, path, a => a.snapshot(this.maximum));
                const leases = this.store.db.prepare('SELECT * FROM writer_leases WHERE workspace_id=? AND resource_key=? AND active=1').all(workspace.id, path).map(row => leaseRow(row)!);
                for (const lease of leases) {
                    if (this.active(lease) && !(lease.owner_session_id === session.id && lease.owner_incarnation_id === identity.incarnation_id && lease.execution_epoch === identity.execution_epoch))
                        fail('FILE_BUSY', 'File is held by another session.', { path, owner_session_id: lease.owner_session_id });
                }
            }
            const claims = paths.map(path => {
                const own = this.store.db.prepare('SELECT * FROM writer_leases WHERE workspace_id=? AND resource_key=? AND active=1 AND owner_session_id=? AND owner_incarnation_id=? AND execution_epoch=? AND coordinator_epoch=? AND expires_mono>?').get(workspace.id, path, session.id, identity.incarnation_id, identity.execution_epoch, this.store.epoch, this.store.clock.monotonic()) as LeaseRow | undefined;
                if (own)
                    return this.claimView(own);
                this.store.db.prepare('UPDATE writer_leases SET active=0 WHERE workspace_id=? AND resource_key=?').run(workspace.id, path);
                this.store.db.prepare('UPDATE resource_guards SET last_fencing_token=last_fencing_token+1 WHERE workspace_id=? AND resource_key=?').run(workspace.id, path);
                const token = Number(this.store.db.prepare('SELECT last_fencing_token FROM resource_guards WHERE workspace_id=? AND resource_key=?').get(workspace.id, path)!.last_fencing_token);
                const lease: LeaseRow = { lease_id: randomUUID(), workspace_id: workspace.id, resource_key: path, owner_session_id: session.id, owner_incarnation_id: identity.incarnation_id, execution_epoch: identity.execution_epoch, coordinator_epoch: this.store.epoch, fencing_token: token, expires_mono: this.store.clock.monotonic() + ttl, expires_at: this.store.clock.utc() + ttl, active: 1 };
                this.store.db.prepare('INSERT INTO writer_leases VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(lease.lease_id, workspace.id, path, session.id, identity.incarnation_id, identity.execution_epoch, this.store.epoch, token, lease.expires_mono, lease.expires_at, 1);
                return this.claimView(lease);
            });
            const result = { claims };
            this.remember(session.id, input.request_id, fp, result);
            this.store.emitEvent({ project_id: session.project_id, workspace_id: workspace.id, actor_session_id: session.id, type: 'files.claimed', payload: result });
            return result;
        }));
    }
    releaseFiles(identity: RuntimeIdentity, input: {
        lease_ids: string[];
        request_id: string;
    }): {
        released: string[];
        already_released: string[];
    } {
        noExtra(record(input), ['lease_ids', 'request_id']);
        const { session, workspace } = this.context(identity);
        string(input.request_id, 'request_id', 256);
        if (!Array.isArray(input.lease_ids) || input.lease_ids.length > 100)
            fail('INVALID_ARGUMENT', 'Invalid lease list.');
        const ids = [...new Set(input.lease_ids.map(id => string(id, 'lease_id', 256)))].sort(), fp = fingerprint({ action: 'release', ids });
        const resources = ids.map(id => String(this.store.db.prepare('SELECT resource_key FROM writer_leases WHERE lease_id=?').get(id)?.resource_key ?? 'missing:' + id));
        return this.lock(workspace.id, resources, () => this.store.transaction(() => {
            this.store.assertIdentity(identity);
            const cached = this.cachedRequest<{
                released: string[];
                already_released: string[];
            }>(session.id, input.request_id, fp);
            if (cached)
                return cached;
            const result: {
                released: string[];
                already_released: string[];
            } = { released: [], already_released: [] };
            for (const id of ids) {
                const lease = this.store.db.prepare('SELECT * FROM writer_leases WHERE lease_id=?').get(id) as LeaseRow | undefined;
                if (!lease) {
                    result.already_released.push(id);
                    continue;
                }
                if (lease.owner_session_id !== session.id || lease.owner_incarnation_id !== identity.incarnation_id || lease.execution_epoch !== identity.execution_epoch)
                    fail('STALE_FENCING_TOKEN', 'Cannot release another runtime instance’s lease.');
                if (lease.active === 0) {
                    result.already_released.push(id);
                    continue;
                }
                this.store.db.prepare('UPDATE writer_leases SET active=0 WHERE lease_id=?').run(id);
                result.released.push(id);
            }
            this.remember(session.id, input.request_id, fp, result);
            this.store.emitEvent({ project_id: session.project_id, workspace_id: workspace.id, actor_session_id: session.id, type: 'files.released', payload: result });
            return result;
        }));
    }
    renewClaims(identity: RuntimeIdentity, input: {
        lease_ids: string[];
        request_id: string;
        ttl_ms?: number;
    }): {
        claims: Claim[];
    } {
        noExtra(record(input), ['lease_ids', 'request_id', 'ttl_ms']);
        const { session, workspace } = this.context(identity);
        if (!['running', 'starting'].includes(session.state))
            fail('LEASE_EXPIRED', 'Stopped or waiting work cannot renew file claims.');
        string(input.request_id, 'request_id', 256);
        if (!Array.isArray(input.lease_ids) || input.lease_ids.length > 100)
            fail('INVALID_ARGUMENT', 'Invalid lease list.');
        const ids = [...new Set(input.lease_ids.map(id => string(id, 'lease_id', 256)))].sort(), ttl = integer(input.ttl_ms ?? this.ttl, 'ttl_ms', 1, 3600000), fp = fingerprint({ action: 'renew', ids, ttl: input.ttl_ms ?? null });
        const resources = ids.map(id => String(this.store.db.prepare('SELECT resource_key FROM writer_leases WHERE lease_id=?').get(id)?.resource_key ?? 'missing:' + id));
        return this.lock(workspace.id, resources, () => this.store.transaction(() => {
            this.store.assertIdentity(identity);
            const cached = this.cachedRequest<{
                claims: Claim[];
            }>(session.id, input.request_id, fp);
            if (cached)
                return cached;
            const leases = ids.map(id => {
                const l = this.store.db.prepare('SELECT * FROM writer_leases WHERE lease_id=?').get(id) as LeaseRow | undefined;
                if (!l || l.owner_session_id !== session.id || l.owner_incarnation_id !== identity.incarnation_id || l.execution_epoch !== identity.execution_epoch || !this.active(l))
                    fail('STALE_FENCING_TOKEN', 'Cannot renew an expired or superseded lease.');
                this.guard(workspace.id, l.resource_key);
                return l;
            });
            const claims = leases.map(l => {
                l.expires_mono = this.store.clock.monotonic() + ttl;
                l.expires_at = this.store.clock.utc() + ttl;
                this.store.db.prepare('UPDATE writer_leases SET expires_mono=?,expires_at=? WHERE lease_id=?').run(l.expires_mono, l.expires_at, l.lease_id);
                return this.claimView(l);
            });
            const result = { claims };
            this.remember(session.id, input.request_id, fp, result);
            return result;
        }));
    }
    /** Runtime close releases only this incarnation; does not finish or relabel uncertain mutations. */
    releaseSession(identity: RuntimeIdentity): void {
        const session = this.store.assertIdentity(identity);
        const paths = this.store.db.prepare('SELECT resource_key FROM writer_leases WHERE owner_session_id=? AND owner_incarnation_id=? AND execution_epoch=? AND active=1').all(identity.session_id, identity.incarnation_id, identity.execution_epoch).map(row => String(row.resource_key));
        this.lock(session.workspace_id, paths, () => {
            this.store.assertIdentity(identity);
            this.store.db.prepare('UPDATE writer_leases SET active=0 WHERE owner_session_id=? AND owner_incarnation_id=? AND execution_epoch=?').run(identity.session_id, identity.incarnation_id, identity.execution_epoch);
        });
    }
    readFile(identity: RuntimeIdentity, input: ReadRequest): ReadResult {
        noExtra(record(input), ['path', 'range', 'line_range', 'max_bytes']);
        if (input.range !== undefined)
            noExtra(record(input.range), ['start', 'end']);
        if (input.line_range !== undefined)
            noExtra(record(input.line_range), ['offset', 'limit']);
        if (input.range !== undefined && input.line_range !== undefined)
            fail('INVALID_ARGUMENT', 'Choose either a byte range or a line range, not both.');
        const maximumDisplay = integer(input.max_bytes ?? this.maximum, 'max_bytes', 1, this.maximum), requestedOffset = input.line_range ? integer(input.line_range.offset, 'line_range.offset', 1, Number.MAX_SAFE_INTEGER) : 1, requestedLimit = input.line_range ? integer(input.line_range.limit, 'line_range.limit', 1, Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
        const { session, workspace } = this.context(identity);
        return this.withPath(workspace.root, input.path, anchor => this.lock(workspace.id, [anchor.key], () => {
            this.store.assertIdentity(identity);
            this.guard(workspace.id, anchor.key);
            const snapshot = anchor.snapshot(this.maximum);
            if (snapshot === null)
                fail('READ_REQUIRED', 'File does not exist; create requires expected_version: null.');
            if (snapshot.bytes.includes(0))
                fail('PATH_NOT_ALLOWED', 'Binary files are not supported.');
            parseText(snapshot.bytes);
            let start = input.range ? integer(input.range.start, 'range.start', 0, snapshot.bytes.length) : 0, end = input.range ? integer(input.range.end, 'range.end', start, snapshot.bytes.length) : snapshot.bytes.length, totalLines = 0, offset = 1;
            // Count lines and select original byte boundaries without normalizing BOM/CRLF.
            for (let index = 0; index < snapshot.bytes.length; index++)
                if (snapshot.bytes[index] === 10) {
                    totalLines++;
                    if (input.line_range) {
                        if (totalLines === requestedOffset - 1)
                            start = index + 1;
                        if (totalLines - requestedOffset + 1 === requestedLimit)
                            end = index + 1;
                    }
                    else if (index < start)
                        offset++;
                }
            if (snapshot.bytes.length > 0 && snapshot.bytes.at(-1) !== 10)
                totalLines++;
            if (input.line_range) {
                offset = requestedOffset;
                if (requestedOffset > totalLines && !(totalLines === 0 && requestedOffset === 1))
                    fail('INVALID_ARGUMENT', 'Requested line offset is beyond the end of the file.', { total_lines: totalLines });
            }
            const capped = end - start > maximumDisplay;
            end = Math.min(end, start + maximumDisplay);
            // The display cap may fall inside a UTF-8 scalar; move only this cap backward.
            if (capped && end < snapshot.bytes.length)
                while (end > start && (snapshot.bytes[end]! & 0xc0) === 0x80)
                    end--;
            const full = start === 0 && end === snapshot.bytes.length, content = parseText(snapshot.bytes.subarray(start, end));
            const lease = this.store.db.prepare('SELECT * FROM writer_leases WHERE workspace_id=? AND resource_key=? AND active=1 AND coordinator_epoch=? AND expires_mono>?').all(workspace.id, anchor.key, this.store.epoch, this.store.clock.monotonic()).map(row=>leaseRow(row)!).find(row=>this.active(row));
            return { content, version: snapshot.version, read_token: this.store.sign({ kind: 'read', domain: this.store.domain, epoch: this.store.epoch, session: session.id, incarnation: identity.incarnation_id, execution_epoch: identity.execution_epoch, workspace: workspace.id, path: anchor.key, version: snapshot.version, start, end, full }), truncated: !full, byte_range: { start, end }, total_lines: totalLines, offset, file_activity: { owner_session_id: lease?.owner_session_id ?? null } };
        }));
    }
    private lease(identity: RuntimeIdentity, workspace: string, path: string, input: FileChange): void {
        const l = this.store.db.prepare('SELECT * FROM writer_leases WHERE lease_id=?').get(input.lease_id) as LeaseRow | undefined;
        if (!l || l.workspace_id !== workspace || l.resource_key !== path || l.owner_session_id !== identity.session_id || l.owner_incarnation_id !== identity.incarnation_id || l.execution_epoch !== identity.execution_epoch || l.coordinator_epoch !== this.store.epoch || input.coordinator_epoch !== this.store.epoch || input.fencing_token !== l.fencing_token || l.active !== 1)
            fail('STALE_FENCING_TOKEN', 'Lease or fencing token is no longer owned by this runtime.');
        if (l.expires_mono <= this.store.clock.monotonic())
            fail('LEASE_EXPIRED', 'File lease expired before the write boundary.');
        const guard = this.store.db.prepare('SELECT last_fencing_token FROM resource_guards WHERE workspace_id=? AND resource_key=?').get(workspace, path);
        if (Number(guard?.last_fencing_token) !== input.fencing_token)
            fail('STALE_FENCING_TOKEN', 'A newer lease already fenced this writer.');
    }
    private readReceipt(identity: RuntimeIdentity, workspace: string, path: string, input: FileChange): Record<string, unknown> {
        if (!input.read_token)
            fail('READ_REQUIRED', 'A current read receipt is required.');
        let receipt: Record<string, unknown>;
        try {
            receipt = this.store.unsign(input.read_token);
        }
        catch {
            fail('READ_REQUIRED', 'Invalid read receipt.');
        }
        if (receipt.kind !== 'read' || receipt.domain !== this.store.domain || receipt.epoch !== this.store.epoch || receipt.session !== identity.session_id || receipt.incarnation !== identity.incarnation_id || receipt.execution_epoch !== identity.execution_epoch || receipt.workspace !== workspace || receipt.path !== path || receipt.version !== input.expected_version)
            fail('READ_REQUIRED', 'Read receipt does not bind this caller, file and version.');
        if (input.operation === 'replace' && receipt.full !== true)
            fail('READ_REQUIRED', 'Whole-file replacement requires a complete read.');
        return receipt;
    }
    private mutation(workspace: string, session: string, id: string): MutationRow | undefined {
        return mutationRow(this.store.db.prepare('SELECT * FROM file_mutations WHERE workspace_id=? AND session_id=? AND mutation_id=?').get(workspace, session, id));
    }
    private status(row: MutationRow | undefined): MutationStatus {
        return { state: row?.state ?? 'not_found', original_result: row?.original_result ? JSON.parse(row.original_result) as MutationResult : null, recovery_action: row && ['prepared', 'applied', 'needs_recovery'].includes(row.state) ? 'Keep affected resources frozen and reconcile the original mutation; never replay an uncertain operation.' : null, ...(row?.operation==='rename'?{affected_paths:this.mutationPaths(row),recovery_reason:row.error}:{}) };
    }
    private mutationPaths(row:MutationRow):string[]{return row.operation==='rename'?[row.resource_key,string(record(JSON.parse(row.request)).target_path,'persisted target_path')]:[row.resource_key];}
    mutationStatus(identity: RuntimeIdentity, input: {
        mutation_id: string;
    }): MutationStatus {
        const { session, workspace } = this.context(identity);
        string(input.mutation_id, 'mutation_id', 256);
        return this.status(this.mutation(workspace.id, session.id, input.mutation_id));
    }
    private validateChange(input: FileChange): void {
        const value = record(input);
        if (!['create', 'replace', 'patch', 'delete', 'rename'].includes(String(value.operation)))
            fail('UNSUPPORTED_ATOMIC_OPERATION', 'Only ordinary-file create, replace, strict patch, delete and same-filesystem no-overwrite rename are supported.');
        noExtra(value, ['path', 'operation', 'expected_version', 'read_token', 'lease_id', 'coordinator_epoch', 'fencing_token', 'mutation_id', 'content', 'patch','target_path','expected_target_version','target_lease_id','target_fencing_token']);
        string(input.path, 'path', 4096);
        string(input.mutation_id, 'mutation_id', 256);
        string(input.lease_id, 'lease_id', 256);
        integer(input.coordinator_epoch, 'coordinator_epoch', 1, Number.MAX_SAFE_INTEGER);
        integer(input.fencing_token, 'fencing_token', 1, Number.MAX_SAFE_INTEGER);
        if (!Object.hasOwn(value, 'expected_version'))
            fail('INVALID_ARGUMENT', 'expected_version is required, including explicit null for create.');
        if (input.operation === 'create') {
            if (input.expected_version !== null)
                fail('INVALID_ARGUMENT', 'Create requires expected_version: null.');
        }
        else if (typeof input.expected_version !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.expected_version))
            fail('INVALID_ARGUMENT', 'Existing-file changes require a complete SHA-256 version.');
        if (input.operation === 'create' || input.operation === 'replace') {
            textBytes(input.content, 'content', this.maximum);
            if (input.patch !== undefined)
                fail('INVALID_ARGUMENT', 'content and patch are mutually exclusive.');
        }
        else if (input.operation === 'patch') {
            if (input.content !== undefined)
                fail('INVALID_ARGUMENT', 'Patch cannot also carry content.');
            const patch = record(input.patch);
            noExtra(patch, ['start', 'old_text', 'new_text']);
            integer(patch.start, 'patch.start', 0, this.maximum);
            textBytes(patch.old_text, 'patch.old_text', this.maximum);
            textBytes(patch.new_text, 'patch.new_text', this.maximum);
        }
        else if (input.content !== undefined || input.patch !== undefined)
            fail('INVALID_ARGUMENT', 'Delete/rename cannot carry content or patch.');
        if(input.operation==='rename'){
            string(input.target_path,'target_path',4096);string(input.target_lease_id,'target_lease_id',256);integer(input.target_fencing_token,'target_fencing_token',1,Number.MAX_SAFE_INTEGER);
            if(!Object.hasOwn(value,'expected_target_version')||input.expected_target_version===undefined)fail('INVALID_ARGUMENT','Rename requires explicit expected_target_version: null.');
            if(input.expected_target_version!==null)fail('UNSUPPORTED_ATOMIC_OPERATION','Destination overwrite is not supported: rename uses an atomic no-replace primitive, not check-then-overwrite.');
        }else if(['target_path','expected_target_version','target_lease_id','target_fencing_token'].some(key=>Object.hasOwn(value,key)))fail('INVALID_ARGUMENT','Destination fields are valid only for rename.');
    }
    applyFileChange(identity: RuntimeIdentity, input: FileChange): MutationResult {
        this.validateChange(input);
        const { session, workspace } = this.context(identity);
        const requestKey = resourceKey(workspace.root, input.path), targetKey=input.operation==='rename'?resourceKey(workspace.root,input.target_path!):undefined;
        const request={ path: requestKey, operation: input.operation, expected_version: input.expected_version, content: input.content, patch: input.patch,...targetKey?{target_path:targetKey,expected_target_version:null}:{} },requestFingerprint = fingerprint(request), prior = this.mutation(workspace.id, session.id, input.mutation_id);
        if (prior) {
            if (prior.request_fingerprint !== requestFingerprint)
                fail('IDEMPOTENCY_CONFLICT', 'Mutation ID already belongs to different content.');
            if (prior.state === 'committed')
                return JSON.parse(prior.original_result!) as MutationResult;
            if (prior.state === 'aborted')
                fail('OPERATION_ABORTED', 'The original operation was aborted; it cannot be executed again.', { original_reason: prior.error });
            fail('OUTCOME_UNKNOWN', 'Original mutation is unresolved; reconcile it without executing another write.', { state: prior.state, mutation_id: input.mutation_id });
        }
        if(targetKey!==undefined)return this.applyRename(identity,input,session,workspace,requestKey,targetKey,request,requestFingerprint);
        return this.withPath(workspace.root, input.path, anchor => this.lock(workspace.id, [anchor.key], () => {
            this.store.assertIdentity(identity);
            const fp = fingerprint({ path: anchor.key, operation: input.operation, expected_version: input.expected_version, content: input.content, patch: input.patch }), existing = this.mutation(workspace.id, session.id, input.mutation_id);
            if (existing) {
                if (existing.request_fingerprint !== fp)
                    fail('IDEMPOTENCY_CONFLICT', 'Mutation ID already belongs to different content.');
                if (existing.state === 'committed')
                    return JSON.parse(existing.original_result!) as MutationResult;
                if (existing.state === 'aborted')
                    fail('OPERATION_ABORTED', 'The original operation was aborted; it cannot be executed again.', { original_reason: existing.error });
                fail('OUTCOME_UNKNOWN', 'Original mutation is unresolved; reconcile it without executing another write.', { state: existing.state, mutation_id: input.mutation_id });
            }
            if(!['running','starting'].includes(this.store.assertIdentity(identity).state))fail('LEASE_EXPIRED','Stopped or waiting work cannot begin a new file mutation.');
            this.guard(workspace.id, anchor.key);
            this.lease(identity, workspace.id, anchor.key, input);
            const old = anchor.snapshot(this.maximum);
            if ((old?.version ?? null) !== input.expected_version)
                fail('VERSION_CONFLICT', 'File changed since the supplied base version.', { current_version: old?.version ?? null, path: anchor.key, origin: 'external/unknown' });
            const receipt = input.operation === 'create' ? null : this.readReceipt(identity, workspace.id, anchor.key, input);
            let bytes: Buffer | null;
            if (input.operation === 'delete')
                bytes = null;
            else if (input.operation === 'patch') {
                const patch = input.patch!, oldText = textBytes(patch.old_text, 'patch.old_text', this.maximum), newText = textBytes(patch.new_text, 'patch.new_text', this.maximum), start = patch.start, end = start + oldText.length;
                if (!old || end > old.bytes.length || !old.bytes.subarray(start, end).equals(oldText) || start < Number(receipt!.start) || end > Number(receipt!.end))
                    fail('PATCH_PRECONDITION_FAILED', 'Patch old text or exact byte location does not match the admitted read range.');
                bytes = Buffer.concat([old.bytes.subarray(0, start), newText, old.bytes.subarray(end)]);
                if (bytes.length > this.maximum)
                    fail('PAYLOAD_TOO_LARGE', 'Patch result exceeds the managed file limit.');
                parseText(bytes);
            }
            else
                bytes = textBytes(input.content, 'content', this.maximum);
            const next = bytes === null ? null : version(bytes), noOp = old !== null && bytes !== null && old.bytes.equals(bytes);
            const evidence: Evidence = { old: old?.info ?? null, old_version: old?.version ?? null, new_version: next, staged: null, artifact: '.dsh-collab-' + randomUUID(), directory: null, published: false, no_op: noOp };
            const row: MutationRow = { mutation_id: input.mutation_id, workspace_id: workspace.id, session_id: session.id, incarnation_id: identity.incarnation_id, coordinator_epoch: this.store.epoch, request_fingerprint: fp, operation: input.operation, resource_key: anchor.key, request: canonical({ path: anchor.key, operation: input.operation, expected_version: input.expected_version, content: input.content, patch: input.patch }), state: 'prepared', evidence: canonical(evidence), original_result: null, error: null, created_at: this.store.clock.utc() };
            this.store.transaction(() => {
                this.store.db.prepare('INSERT INTO file_mutations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.mutation_id, row.workspace_id, row.session_id, row.incarnation_id, row.coordinator_epoch, row.request_fingerprint, row.operation, row.resource_key, row.request, row.state, row.evidence, null, null, row.created_at);
                this.store.db.prepare("UPDATE resource_guards SET recovery_state='recovering' WHERE workspace_id=? AND resource_key=?").run(workspace.id, anchor.key);
            });
            let actionStarted = false;
            let artifact: ArtifactDirectory | undefined;
            try {
                this.fault?.('after_prepared');
                if (noOp)
                    return this.commit(row, evidence, anchor);
                artifact = new ArtifactDirectory(anchor, evidence.artifact, null, true);
                evidence.directory = artifact.identity;
                this.store.db.prepare('UPDATE file_mutations SET evidence=? WHERE workspace_id=? AND session_id=? AND mutation_id=?').run(canonical(evidence), workspace.id, session.id, input.mutation_id);
                if (bytes !== null) {
                    const fd = openSync(`${artifact.path}/new`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, old?.info.mode ?? 0o600);
                    try {
                        fchmodSync(fd, old?.info.mode ?? 0o600);
                        let at = 0;
                        while (at < bytes.length)
                            at += writeSync(fd, bytes, at, bytes.length - at);
                        fsyncSync(fd);
                        evidence.staged = info(fstatSync(fd, { bigint: true }));
                    }
                    finally {
                        closeSync(fd);
                    }
                }
                artifact.flush();
                anchor.flush();
                this.fault?.('after_temp_flush');
                this.store.db.prepare('UPDATE file_mutations SET evidence=? WHERE workspace_id=? AND session_id=? AND mutation_id=?').run(canonical(evidence), workspace.id, session.id, input.mutation_id);
                this.fault?.('after_evidence');
                anchor.revalidate();
                const beforePublish = anchor.snapshot(this.maximum);
                if ((beforePublish?.version ?? null) !== evidence.old_version || ((beforePublish !== null || evidence.old !== null) && !sameInode(beforePublish?.info ?? null, evidence.old)))
                    fail('VERSION_CONFLICT', 'Target changed before atomic publication; no write performed.', { origin: 'external/unknown' });
                this.fault?.('before_publish');
                anchor.revalidate();
                artifact.revalidate();
                const finalBase = anchor.snapshot(this.maximum);
                if ((finalBase?.version ?? null) !== evidence.old_version || ((finalBase !== null || evidence.old !== null) && !(finalBase !== null && evidence.old !== null && stable(finalBase.info, evidence.old))))
                    fail('VERSION_CONFLICT', 'Target changed at the atomic publication boundary.', { origin: 'external/unknown' });
                if(input.operation!=='delete'){
                    const staged=regularSnapshot(`${artifact.path}/new`,this.maximum);
                    if(staged===null||evidence.staged===null||staged.version!==evidence.new_version||!stable(staged.info,evidence.staged))fail('PATH_NOT_ALLOWED','Staged bytes or inode changed before publication; no target action performed.');
                }else{
                    try{lstatSync(`${artifact.path}/removed`);fail('PATH_NOT_ALLOWED','Unowned delete artifact already exists.');}catch(error){if(fsCode(error)!=='ENOENT')throw error;}
                }
                actionStarted = true;
                if (input.operation === 'create')
                    linkSync(`${artifact.path}/new`, anchor.target);
                else if (input.operation === 'delete')
                    renameSync(anchor.target, `${artifact.path}/removed`);
                else
                    renameSync(`${artifact.path}/new`, anchor.target);
                evidence.published = true;
                this.fault?.('after_publish');
                artifact.flush();
                anchor.flush();
                this.fault?.('after_directory_flush');
                const result = this.commit(row, evidence, anchor);
                this.fault?.('after_commit');
                return result;
            }
            catch (error) {
                if (this.mutation(workspace.id, session.id, input.mutation_id)?.state === 'committed'){
                    this.cleanup(anchor,evidence);
                    fail('OUTCOME_UNKNOWN', 'Result transmission failed after durable commit; query or retry the original mutation ID.', { mutation_id: input.mutation_id });
                }
                if (!actionStarted) {
                    try {
                        this.abort(row, error instanceof Error ? error.message : String(error));
                        this.cleanup(anchor, evidence);
                    }
                    catch (abortError) {
                        this.freeze(row, 'Could not persist the pre-publication abort.');
                        fail('OUTCOME_UNKNOWN', 'Failed to persist the mutation outcome.', { cause: String(abortError) });
                    }
                    if (error instanceof CoordinationError)
                        throw error;
                    fail('STORAGE_ERROR', 'Mutation was aborted before atomic publication.', { cause: String(error) });
                }
                this.freeze(row, error instanceof Error ? error.message : String(error));
                fail('OUTCOME_UNKNOWN', 'Atomic file action may have completed; resource frozen for recovery.', { mutation_id: input.mutation_id });
            }
            finally {
                artifact?.close();
            }
        }));
    }
    /** Both file-entry namespaces are fenced; directories themselves cannot be mutated. */
    private applyRename(identity:RuntimeIdentity,input:FileChange,session:SessionRow,workspace:WorkspaceRow,sourceKey:string,targetKey:string,request:Record<string,unknown>,fp:string):MutationResult {
        if(sourceKey===targetKey)fail('INVALID_ARGUMENT','Rename source and destination must be distinct ordinary files.');
        return this.withPath(workspace.root,sourceKey,source=>this.withPath(workspace.root,targetKey,target=>this.lock(workspace.id,[sourceKey,targetKey],()=>{
            if(!['running','starting'].includes(this.store.assertIdentity(identity).state))fail('LEASE_EXPIRED','Stopped or waiting work cannot rename files.');
            this.guard(workspace.id,sourceKey);this.guard(workspace.id,targetKey);
            this.lease(identity,workspace.id,sourceKey,input);
            this.lease(identity,workspace.id,targetKey,{...input,lease_id:input.target_lease_id!,fencing_token:input.target_fencing_token!});
            const old=source.snapshot(this.maximum),destination=target.snapshot(this.maximum);
            if(!old||old.version!==input.expected_version)fail('VERSION_CONFLICT','Rename source changed since its read.',{path:sourceKey,current_version:old?.version??null,origin:'external/unknown'});
            if(destination!==null)fail('VERSION_CONFLICT','Rename destination must not exist; no overwrite is permitted.',{path:targetKey,current_version:destination.version,origin:'external/unknown'});
            if(source.parentInfo.dev!==target.parentInfo.dev)fail('UNSUPPORTED_ATOMIC_OPERATION','Cross-filesystem rename is not supported; no copy/delete fallback exists.');
            this.readReceipt(identity,workspace.id,sourceKey,input);
            // Flush the exact existing inode before promising a durable move.
            const fd=openSync(source.target,INFO_FLAGS);
            try{if(!stable(info(fstatSync(fd,{bigint:true})),old.info))fail('VERSION_CONFLICT','Rename source changed before its durability barrier.');fsyncSync(fd);}finally{closeSync(fd);}
            const evidence:Evidence={old:old.info,old_version:old.version,new_version:null,staged:null,artifact:'.dsh-collab-'+randomUUID(),directory:null,published:false,no_op:false,rename:{target:targetKey,source_parent:source.parentInfo,target_parent:target.parentInfo}};
            const row:MutationRow={mutation_id:input.mutation_id,workspace_id:workspace.id,session_id:session.id,incarnation_id:identity.incarnation_id,coordinator_epoch:this.store.epoch,request_fingerprint:fp,operation:'rename',resource_key:sourceKey,request:canonical(request),state:'prepared',evidence:canonical(evidence),original_result:null,error:null,created_at:this.store.clock.utc()};
            this.store.transaction(()=>{
                this.store.db.prepare('INSERT INTO file_mutations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.mutation_id,row.workspace_id,row.session_id,row.incarnation_id,row.coordinator_epoch,row.request_fingerprint,row.operation,row.resource_key,row.request,row.state,row.evidence,null,null,row.created_at);
                for(const path of [sourceKey,targetKey])this.store.db.prepare("UPDATE resource_guards SET recovery_state='recovering' WHERE workspace_id=? AND resource_key=?").run(workspace.id,path);
            });
            let actionStarted=false;
            try{
                this.fault?.('after_prepared');
                source.revalidate();target.revalidate();
                const current=source.snapshot(this.maximum);
                if(!current||current.version!==old.version||!stable(current.info,old.info))fail('VERSION_CONFLICT','Rename source changed before publication.',{origin:'external/unknown'});
                if(target.snapshot(this.maximum)!==null)fail('VERSION_CONFLICT','Rename destination was created before publication.',{origin:'external/unknown'});
                this.fault?.('before_publish');
                source.revalidate();target.revalidate();
                const finalSource=source.snapshot(this.maximum);
                if(!finalSource||finalSource.version!==old.version||!stable(finalSource.info,old.info))fail('VERSION_CONFLICT','Rename source changed at publication.',{origin:'external/unknown'});
                actionStarted=true;
                try{renameNoReplace(source.parentFd,source.leaf,target.parentFd,target.leaf);}catch(error){
                    const code=fsCode(error);
                    if(error instanceof CoordinationError||['EEXIST','EXDEV','EINVAL','ENOSYS','EOPNOTSUPP','EROFS','EACCES','EPERM','ENOENT','ENOTDIR'].includes(code??'')){
                        actionStarted=false;
                        if(code==='EEXIST')fail('VERSION_CONFLICT','Rename destination was created at atomic publication; its data was not overwritten.',{path:targetKey,origin:'external/unknown'});
                        if(['EXDEV','EINVAL','ENOSYS','EOPNOTSUPP'].includes(code??''))fail('UNSUPPORTED_ATOMIC_OPERATION','The filesystem cannot perform this atomic no-replace rename; no fallback was attempted.',{cause:code});
                    }
                    throw error;
                }
                // A pre-existing inode is not unique publication evidence. A crash
                // before this durable success witness stays unknown, never guessed.
                this.fault?.('after_publish');
                evidence.published=true;
                this.store.db.prepare('UPDATE file_mutations SET evidence=? WHERE workspace_id=? AND session_id=? AND mutation_id=?').run(canonical(evidence),workspace.id,session.id,input.mutation_id);
                this.fault?.('after_publish_evidence');
                source.flush();target.flush();this.fault?.('after_directory_flush');
                const result=this.commit(row,evidence,source);this.fault?.('after_commit');return result;
            }catch(error){
                if(this.mutation(workspace.id,session.id,input.mutation_id)?.state==='committed')fail('OUTCOME_UNKNOWN','Rename committed but result was lost; query the original mutation.',{mutation_id:input.mutation_id});
                if(!actionStarted){
                    try{this.abort(row,error instanceof Error?error.message:String(error));}catch{this.freeze(row,'Could not persist the rename abort.');fail('OUTCOME_UNKNOWN','Rename outcome could not be durably recorded.',{mutation_id:input.mutation_id});}
                    if(error instanceof CoordinationError)throw error;
                    fail('STORAGE_ERROR','Rename aborted before a file action.',{cause:fsCode(error)??String(error)});
                }
                this.freeze(row,'Rename publication or durability is uncertain: '+String(error));
                fail('OUTCOME_UNKNOWN','Rename may have occurred; both paths remain frozen for original-operation recovery.',{mutation_id:input.mutation_id,affected_paths:[sourceKey,targetKey]});
            }
        })));
    }
    private commit(row: MutationRow, evidence: Evidence, anchor: AnchoredPath): MutationResult {
        this.fault?.('before_commit');
        const result = this.store.transaction(() => {
            const session = this.store.session(row.session_id);
            const event = this.store.emitEvent({ id: 'mutation:' + fingerprint([row.workspace_id, row.session_id, row.mutation_id]), project_id: session.project_id, workspace_id: row.workspace_id, actor_session_id: row.session_id, type: evidence.no_op ? 'file.noop' : 'file.changed', payload: { mutation_id: row.mutation_id, path: row.resource_key, previous_version: evidence.old_version, new_version: evidence.new_version, operation: row.operation, no_op: evidence.no_op,...evidence.rename?{destination_path:evidence.rename.target,destination_version:evidence.old_version}:{} } });
            const result: MutationResult = { mutation_id: row.mutation_id, previous_version: evidence.old_version, new_version: evidence.new_version, event_cursor: String(event.sequence), no_op: evidence.no_op,...evidence.rename?{destination_path:evidence.rename.target,destination_version:evidence.old_version!}:{} };
            this.store.db.prepare("UPDATE file_mutations SET state='committed',evidence=?,original_result=?,error=NULL WHERE workspace_id=? AND session_id=? AND mutation_id=?").run(canonical(evidence), canonical(result), row.workspace_id, row.session_id, row.mutation_id);
            for(const path of this.mutationPaths(row))this.store.db.prepare("UPDATE resource_guards SET recovery_state='ready' WHERE workspace_id=? AND resource_key=?").run(row.workspace_id,path);
            return result;
        });
        this.fault?.('after_durable_commit_before_cleanup');
        this.cleanup(anchor, evidence);
        return result;
    }
    private abort(row: MutationRow, reason: string): void {
        this.store.transaction(() => {
            this.store.db.prepare("UPDATE file_mutations SET state='aborted',error=? WHERE workspace_id=? AND session_id=? AND mutation_id=?").run(reason, row.workspace_id, row.session_id, row.mutation_id);
            for(const path of this.mutationPaths(row))this.store.db.prepare("UPDATE resource_guards SET recovery_state='ready' WHERE workspace_id=? AND resource_key=?").run(row.workspace_id,path);
            const session = this.store.session(row.session_id);
            this.store.emitEvent({ id: 'mutation:' + fingerprint([row.workspace_id, row.session_id, row.mutation_id]), project_id: session.project_id, workspace_id: row.workspace_id, actor_session_id: row.session_id, type: 'file.aborted', payload: { mutation_id: row.mutation_id, path: row.resource_key, reason } });
        });
    }
    private freeze(row: MutationRow, reason: string): void {
        try {
            this.store.transaction(() => {
                this.store.db.prepare("UPDATE file_mutations SET state='needs_recovery',error=? WHERE workspace_id=? AND session_id=? AND mutation_id=?").run(reason, row.workspace_id, row.session_id, row.mutation_id);
                for(const path of this.mutationPaths(row))this.store.db.prepare("UPDATE resource_guards SET recovery_state='needs_recovery' WHERE workspace_id=? AND resource_key=?").run(row.workspace_id,path);
            });
        }
        catch { /* The durable prepared intent already fences this resource; never clear it on storage failure. */
        }
    }
    private cleanup(anchor: AnchoredPath, evidence: Evidence): void {
        if (evidence.no_op || evidence.directory === null)
            return;
        let artifact: ArtifactDirectory | undefined;
        try {
            artifact = new ArtifactDirectory(anchor, evidence.artifact, evidence.directory);
            for (const [name, expected] of [['new', evidence.staged], ['removed', evidence.old]] as const) {
                try {
                    const entry = lstatSync(`${artifact.path}/${name}`, { bigint: true });
                    if (!entry.isFile() || !sameInode(info(entry), expected))
                        return;
                    const snapshot=regularSnapshot(`${artifact.path}/${name}`,this.maximum,2);
                    if(snapshot===null||snapshot.version!==(name==='new'?evidence.new_version:evidence.old_version)||!sameInode(snapshot.info,expected))return;
                    artifact.revalidate();
                    unlinkSync(`${artifact.path}/${name}`);
                }
                catch (error) {
                    if (fsCode(error) !== 'ENOENT')
                        return;
                }
            }
            artifact.flush();
            artifact.revalidate();
            rmdirSync(artifact.entry);
            anchor.flush();
        }
        catch { /* Retain unowned or unremovable evidence; never recursively remove a recovery artifact. */
        }
        finally {
            artifact?.close();
        }
    }
    reconcile(identity: RuntimeIdentity, input: {
        mutation_id: string;
    }): MutationStatus {
        const { session, workspace } = this.context(identity);
        string(input.mutation_id, 'mutation_id', 256);
        const row = this.mutation(workspace.id, session.id, input.mutation_id);
        if (!row || row.state === 'committed' || row.state === 'aborted'){
            if(row)this.cleanupTerminal(row);
            return this.status(row);
        }
        this.recover(row);
        return this.status(this.mutation(workspace.id, session.id, input.mutation_id));
    }
    /** Called before coordinator begins accepting operations; each unresolved resource remains independently fenced. */
    private cleanupTerminal(row:MutationRow):void {
        // Cleanup is not publication, replay or a new terminal event. Never change
        // terminal state or the current target, even when its bytes changed later.
        try{const workspace=this.store.workspace(row.workspace_id),evidence=evidenceOf(row);this.withPath(workspace.root,row.resource_key,anchor=>this.lock(workspace.id,[row.resource_key],()=>this.cleanup(anchor,evidence)));}catch{/* Preserve unowned/corrupt evidence or unavailable parents for operator review. */}
    }
    recoverAll(): void {
        for(const raw of this.store.db.prepare("SELECT * FROM file_mutations WHERE state IN ('committed','aborted') ORDER BY created_at,mutation_id").all()){
            try{this.cleanupTerminal(mutationRow(raw)!);}catch{/* Invalid terminal rows are not grounds to replay or erase evidence. */}
        }
        const rows = this.store.db.prepare("SELECT * FROM file_mutations WHERE state IN ('prepared','applied','needs_recovery') ORDER BY created_at,mutation_id").all().map(row => mutationRow(row)!);
        for (const row of rows)
            this.recover(row);
    }
    private recover(row: MutationRow): void {
        try {
            const workspace = this.store.workspace(row.workspace_id);
            if(row.operation==='rename'){this.recoverRename(row,workspace);return;}
            this.withPath(workspace.root, row.resource_key, anchor => this.lock(workspace.id, [row.resource_key], () => {
                const evidence = evidenceOf(row);
                const current = anchor.snapshot(this.maximum, row.operation === 'create' ? 2 : 1);
                if (evidence.no_op) {
                    if (current?.version === evidence.old_version && evidence.old !== null && stable(current.info, evidence.old)) {
                        this.commit(row, evidence, anchor);
                        return;
                    }
                    this.freeze(row, 'No-op base changed before commit; explicit review required.');
                    return;
                }
                let artifact: ArtifactDirectory | undefined;
                try {
                    if (evidence.directory !== null)
                        artifact = new ArtifactDirectory(anchor, evidence.artifact, evidence.directory);
                    if (row.operation === 'delete') {
                        const removed = artifact ? regularSnapshot(`${artifact.path}/removed`, this.maximum) : null;
                        if (current === null && removed?.version === evidence.old_version && sameInode(removed.info, evidence.old)) {
                            artifact?.flush();
                            anchor.flush();
                            this.commit(row, { ...evidence, published: true }, anchor);
                            return;
                        }
                        if (removed === null && current?.version === evidence.old_version && evidence.old !== null && stable(current.info, evidence.old)) {
                            this.abort(row, 'Recovered original unchanged target before publication.');
                            this.cleanup(anchor, evidence);
                            return;
                        }
                    }
                    else {
                        if (current !== null && current.version === evidence.new_version && sameInode(current.info, evidence.staged)) {
                            artifact?.flush();
                            anchor.flush();
                            this.commit(row, { ...evidence, published: true }, anchor);
                            return;
                        }
                        const oldMatches = evidence.old === null ? current === null : current?.version === evidence.old_version && evidence.old !== null && stable(current.info, evidence.old);
                        if (oldMatches) {
                            let stagedExists = false;
                            if (artifact) {
                                try {
                                    const staged = lstatSync(`${artifact.path}/new`, { bigint: true });
                                    stagedExists = staged.isFile() && staged.nlink === 1n && (evidence.staged === null || sameInode(info(staged), evidence.staged));
                                }
                                catch (error) {
                                    if (fsCode(error) !== 'ENOENT')
                                        throw error;
                                }
                            }
                            if (stagedExists || evidence.staged === null) {
                                this.abort(row, 'Recovered original unchanged target before publication.');
                                this.cleanup(anchor, evidence);
                                return;
                            }
                        }
                    }
                }
                finally {
                    artifact?.close();
                }
                this.freeze(row, 'Target state cannot be uniquely attributed to this mutation; preserve evidence and request review.');
            }));
        }
        catch (error) {
            this.freeze(row, 'Recovery could not establish a safe outcome: ' + String(error));
        }
    }
    private recoverRename(row:MutationRow,workspace:WorkspaceRow):void {
        const evidence=evidenceOf(row),rename=evidence.rename!;
        if(resourceKey(workspace.root,rename.target)!==rename.target||rename.target===row.resource_key)fail('STORAGE_ERROR','Invalid canonical rename destination in recovery evidence.');
        this.withPath(workspace.root,row.resource_key,source=>this.withPath(workspace.root,rename.target,target=>this.lock(workspace.id,[row.resource_key,rename.target],()=>{
            if(!sameInode(source.parentInfo,rename.source_parent)||!sameInode(target.parentInfo,rename.target_parent))fail('PATH_NOT_ALLOWED','Rename parent namespace identity changed; preserve both paths for review.');
            const before=source.snapshot(this.maximum),after=target.snapshot(this.maximum);
            if(evidence.published&&before===null&&after!==null&&after.version===evidence.old_version&&sameInode(after.info,evidence.old)){
                source.flush();target.flush();this.commit(row,evidence,source);return;
            }
            if(!evidence.published&&before!==null&&evidence.old!==null&&before.version===evidence.old_version&&stable(before.info,evidence.old)){
                this.abort(row,'Recovered unchanged original rename source; no owned publication evidence.');return;
            }
            this.freeze(row,'Rename namespace cannot be uniquely attributed: keep both paths frozen. A move-shaped state without a durable syscall-success witness is not proof of this mutation.');
        })));
    }
}
