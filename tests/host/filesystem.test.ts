import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { ProtectedFileSystem } from '../../src/host/filesystem.ts';
test('F08 F13 replacement ctx.fs refuses direct write/edit even with a danger-full-access request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-protected-fs-')), ctx = new Context();
    try {
        writeFileSync(join(root, 'file.txt'), 'old');
        const fs = new ProtectedFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 1024 });
        const target = await fs.resolve('file.txt');
        assert.equal(await fs.readText(target), 'old');
        assert.equal(fs.sandboxMode, 'read-only');
        const denied = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'UNMEDIATED_WRITE_DENIED';
        await assert.rejects(() => fs.writeText(target, 'new', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: root }), denied);
        await assert.rejects(() => fs.editText(target, { oldString: 'old', newString: 'new', replaceAll: false }, undefined, undefined, { mode: 'danger-full-access', workspaceRoot: root }), denied);
        assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'old');
    }
    finally {
        await ctx.fiber.dispose();
        rmSync(root, { recursive: true, force: true });
    }
});
