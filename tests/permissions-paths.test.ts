import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, escapesWorkspace } from '../src/tools/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';

test('paths are revalidated when a directory becomes an outside junction', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-path-'));
  const root = path.join(base, 'root');
  const link = path.join(root, 'link');
  fs.mkdirSync(link, { recursive: true });
  try {
    assert.equal(escapesWorkspace('link/new', root), false);
    fs.rmdirSync(link);
    fs.symlinkSync(base, link, 'junction');
    assert.equal(escapesWorkspace('link/new', root), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
test('outside cat is denied before approval and execution while workspace reads succeed', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-read-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside sentinel');
  fs.writeFileSync(path.join(root, 'inside.txt'), 'inside sentinel');
  const registry = new ToolRegistry();
  registry.approver = async () => { assert.fail('a hard denial must not prompt'); };
  try {
    for (const command of ['cat ../outside.txt', `cat "${path.join(base, 'outside.txt').replace(/\\/g, '/')}"`]) {
      const policy = decide('run_command', { command }, root);
      assert.equal(policy.verdict, 'deny');
      assert.equal(policy.risk, 'high');
      const result = await registry.executeTool('run_command', { command }, { workspaceRoot: root });
      assert.equal(result.isError, true);
      assert.match(result.output, /Blocked by policy/);
      assert.equal(result.output.includes('outside sentinel'), false);
    }
    assert.equal(decide('run_command', { command: 'cat inside.txt' }, root).verdict, 'allow');
    const read = await registry.executeTool('read_file', { path: 'inside.txt' }, { workspaceRoot: root });
    assert.equal(read.isError, false);
    assert.match(read.output, /inside sentinel/);
    fs.mkdirSync(path.join(root, '.ssh'));
    fs.symlinkSync(path.join(root, '.ssh'), path.join(root, 'alias'), 'junction');
    assert.equal(decide('read_file', { path: 'alias/key' }, root).verdict, 'deny');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
test('canonical secret traversal is denied', () => {
  assert.equal(decide('read_file', { path: '.ssh/../.env' }, process.cwd()).verdict, 'deny');
});
