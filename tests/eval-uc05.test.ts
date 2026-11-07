// tests/eval-uc05.test.ts - Real security harness with closed command execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runUc05 } from '../evals/uc05/run.js';
import { IsolatedCommandTool } from '../evals/uc05/executor.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

test('seven UC05 scripts exercise the real loop, registry and audit', async t => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc05-test-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const result = await runUc05({ config: DEFAULT_CONFIG, workDir, mock: true });
  assert.equal(result.cases.length, 7);
  for (const c of result.cases) assert.equal(c.passed, true, JSON.stringify(c));
  assert.equal(result.summary.auditComplete, 1);
  assert.equal(result.summary.forbiddenExecuted, 0);
});

test('isolated executor rejects absolute binaries and shell syntax outside its script', async () => {
  const executor = new IsolatedCommandTool('/unused', []);
  for (const command of ['/bin/sh -c "echo unsafe"', 'C:\\Windows\\System32\\cmd.exe /c echo unsafe', '$(pip install requests)', 'git push origin main']) {
    await assert.rejects(executor.execute({ command }), /Unscripted/);
  }
  assert.deepEqual(executor.executed, []);
});
import { ToolRegistry } from '../src/tools/registry.js';
test('hard denials and edited denial never reach isolated executor', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uc05-security-'));
  const previous = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(root, 'home');
  t.after(() => { if (previous === undefined) delete process.env.AXIOM_HOME; else process.env.AXIOM_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const registry = new ToolRegistry(); const executor = new IsolatedCommandTool(root, []); registry.registerTool(executor);
  let asked = 0; registry.approver = async () => { asked++; return 'approve'; };
  for (const command of ['git push origin HEAD:refs/heads/main', 'git push origin +HEAD:main', 'git push origin :refs/heads/main']) {
    const result = await registry.executeTool('run_command', { command }, { workspaceRoot: root });
    assert.equal(result.isError, true); assert.equal(asked, 0);
  }
  const outside = await registry.executeTool('read_file', { path: '../outside.txt' }, { workspaceRoot: root });
  assert.equal(outside.isError, true);
  registry.approver = async () => ({ editedArgs: { command: 'git push origin HEAD:main' } });
  assert.equal((await registry.executeTool('run_command', { command: 'pip install requests' }, { workspaceRoot: root })).isError, true);
  registry.approver = async () => 'deny';
  assert.equal((await registry.executeTool('run_command', { command: 'echo $(pip install requests)' }, { workspaceRoot: root })).isError, true);
  assert.deepEqual(executor.executed, []);
});
