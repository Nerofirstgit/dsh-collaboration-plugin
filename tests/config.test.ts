import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.ts'
test('per-host display/workspace settings never enter shared coordinator configuration',()=>{
  const a=resolveConfig({data_dir:'/tmp/coordinator',workspace_root:'/tmp/project-a',read_limit_lines:5} as Parameters<typeof resolveConfig>[0])
  const b=resolveConfig({data_dir:'/tmp/coordinator',workspace_root:'/tmp/project-b',read_limit_lines:200} as Parameters<typeof resolveConfig>[0])
  assert.deepEqual(a,b)
  assert.equal('workspace_root' in a,false)
  assert.equal('read_limit_lines' in a,false)
})
