import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { decide, isSecretPath } from '../src/tools/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';

const root = os.tmpdir();
const verdict = (name: string, args: Record<string, unknown>) => decide(name, args, root).verdict;

test('secret paths are recognised, templates are not', () => {
  for (const p of ['.env', 'app/.env.local', 'key.pem', '~/.ssh/id_rsa', '/home/u/.ssh', '.git/config', '".env"']) {
    assert.ok(isSecretPath(p), p);
  }
  for (const p of ['.env.example', 'env.py', 'src/config.py', 'docs/ssh.md']) assert.ok(!isSecretPath(p), p);
});

test('allow / ask / deny', () => {
  assert.equal(verdict('read_file', { path: 'src/a.py' }), 'allow');
  assert.equal(verdict('read_file', { path: '.env' }), 'deny');
  assert.equal(verdict('read_file', { path: '../../etc/passwd' }), 'deny');
  assert.equal(verdict('run_command', { command: 'git status' }), 'allow');
  assert.equal(verdict('run_command', { command: 'pip install requests' }), 'ask');
  assert.equal(verdict('run_command', { command: 'cat ".env"' }), 'deny');
  assert.equal(verdict('run_command', { command: 'ls && cat $HOME/.ssh/id_rsa' }), 'deny');
  assert.equal(verdict('run_command', { command: 'git push origin main' }), 'deny');
  assert.equal(verdict('run_command', { command: 'git push origin feature-x' }), 'ask');
});

test('deny never reaches the approver; edited args are re-checked', async () => {
  const reg = new ToolRegistry();
  let asked = 0;
  reg.approver = async () => {
    asked++;
    return { editedArgs: { command: 'cat .env' } };
  };
  const denied = await reg.executeTool('read_file', { path: '.env' }, { workspaceRoot: root });
  assert.ok(denied.isError && /Blocked by policy/.test(denied.output));
  assert.equal(asked, 0);

  const edited = await reg.executeTool('run_command', { command: 'pip install x' }, { workspaceRoot: root });
  assert.equal(asked, 1);
  assert.ok(edited.isError && /after edit/.test(edited.output));
});

test('role-scoped registry offers and accepts only its tools', async () => {
  const reviewer = new ToolRegistry(['read_file']);
  assert.deepEqual(reviewer.getDefinitions().map((d) => d.name), ['read_file']);
  const r = await reviewer.executeTool('write_file', { path: 'x', content: '' }, { workspaceRoot: root });
  assert.ok(r.isError && /Unknown tool/.test(r.output));
  const { WriteTool } = await import('../src/tools/write.js');
  assert.throws(() => reviewer.registerTool(new WriteTool()), /not allowed/);
});
