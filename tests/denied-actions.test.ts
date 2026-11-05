// tests/denied-actions.test.ts - Kiểm hành vi thật của registry và identity chống lách.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { actionKey, actionKeys, normalizeCommand, DeniedActions } from '../src/tools/denied-actions.js';

function workspace(t: { after(fn: () => void): void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-denied-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const [title, first, retry] of [
  ['after denying rm a.py, sh -c "rm ./a.py" is denied', 'rm a.py', 'sh -c "rm ./a.py"'],
  ['after denying pip install requests, python3 -m pip install requests is denied', 'pip install requests', 'python3 -m pip install requests'],
  ['after denying pip install requests, ls && pip3 install requests is denied', 'pip install requests', 'ls && pip3 install requests'],
  ['env FOO=1 rm a.py matches rm a.py', 'rm a.py', 'env FOO=1 rm a.py'],
  ['denied action never reaches the approver a second time', 'rm a.py', 'command exec sudo env FOO=1 bash -c "unlink ./a.py"'],
]) {
  test(title, async (t) => {
    const root = workspace(t);
    fs.writeFileSync(path.join(root, 'a.py'), 'keep');
    const registry = new ToolRegistry();
    let asked = 0;
    registry.approver = async () => { asked++; return 'deny'; };
    await registry.executeTool('run_command', { command: first }, { workspaceRoot: root });
    const result = await registry.executeTool('run_command', { command: retry }, { workspaceRoot: root });
    assert.equal(asked, 1);
    assert.equal(result.isError, true);
    assert.equal(result.metadata?.success, false);
    assert.deepEqual(result.metadata?.policy, {
      verdict: 'deny', risk: 'high',
      reason: (result.metadata?.policy as { reason: string }).reason,
    });
    assert.match(result.output, /same action was denied earlier/);
    assert.equal(fs.readFileSync(path.join(root, 'a.py'), 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(root), ['a.py']);
  });
}

test('a different file is not affected by the denial', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  let asked = 0;
  registry.approver = async () => { asked++; return 'deny'; };
  await registry.executeTool('run_command', { command: 'rm a.py' }, { workspaceRoot: root });
  await registry.executeTool('run_command', { command: 'rm b.py' }, { workspaceRoot: root });
  assert.equal(asked, 2);
  const write = await registry.executeTool('write_file', { path: 'c.py', content: 'safe' }, { workspaceRoot: root });
  assert.equal(write.isError, false);
  assert.equal(fs.readFileSync(path.join(root, 'c.py'), 'utf8'), 'safe');
});

test('normalization preserves argv, literal separators, backslashes and distinct flags', (t) => {
  const root = workspace(t);
  const normalize = (command: string) => normalizeCommand(command, root);
  assert.deepEqual(normalize('A=1 env FOO=bar command exec sudo sh -c \'rm ./a.py\''), normalize('rm a.py'));
  assert.deepEqual(normalize('npm i requests'), normalize('npm install requests'));
  assert.deepEqual(normalize('rm -rf a.py'), normalize('rm --force --recursive ./a.py'));
  assert.deepEqual(normalize('rm -R -f a.py'), normalize('rm -fr a.py'));
  assert.notDeepEqual(normalize('rm -f a.py'), normalize('rm -r a.py'));
  assert.notDeepEqual(normalize('rm "a b"'), normalize('rm a b'));
  assert.notDeepEqual(normalize('pip install "a  b"'), normalize('pip install "a b"'));
  assert.deepEqual(normalize('pip install "requests==2.0"'), normalize('pip install requests==2.0'));
  assert.notDeepEqual(normalize('/bin/../custom/rm a.py'), normalize('rm a.py'));
  assert.equal(normalize('echo "a;b && c"').length, 1);
  assert.equal(normalize('ls || pwd; echo ok | cat\nrm a.py').length, 5);
  assert.deepEqual(JSON.parse(normalize('echo "a\\q"')[0]), ['echo', 'a\\q']);
  assert.throws(() => normalize('rm "$FILE"'), /dynamic/);
  assert.throws(() => normalize('rm "broken'), /quote/);
  assert.deepEqual(normalize('rm sub/../a.py'), normalize('rm a.py'));
  assert.deepEqual(normalize('rm .//a.py'), normalize('rm a.py'));
  const abs = path.join(root, 'a.py').replace(/\\/g, '/');
  assert.deepEqual(normalize(`rm '${abs}'`), normalize('rm a.py'));
});

test('keys support workspace roots, nested stable JSON and multi-action calls without changing the legacy return type', (t) => {
  const root = workspace(t), other = workspace(t);
  assert.equal(typeof actionKey('read_file', { path: 'a.py' }, root), 'string');
  assert.notEqual(actionKey('read_file', { path: 'a.py' }, root), actionKey('read_file', { path: 'a.py' }, other));
  assert.equal(actionKey('custom', { z: { b: 2, a: 1 }, a: 0 }), actionKey('custom', { a: 0, z: { a: 1, b: 2 } }));
  const keys = actionKeys('run_command', { command: 'rm a.py b.py; pip3 install x' }, root);
  for (const command of ['rm a.py', 'rm b.py', 'pip install x']) {
    assert.ok(actionKeys('run_command', { command }, root).some((key) => keys.includes(key)));
  }
  const denied = new DeniedActions();
  denied.add('x'); assert.ok(denied.has('x')); denied.clear(); assert.equal(denied.has('x'), false);
  denied.add(actionKey('run_command', { command: 'rm a.py' }, root));
  assert.ok(actionKeys('run_command', { command: 'unlink ./a.py' }, root).some((key) => denied.has(key)));
  assert.notEqual(actionKey('run_command', { command: 'pip install x' }, root), actionKey('run_command', { command: 'pip install x' }, other));
});

test('denying a compound command leaves its read-only segment available', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  registry.approver = async () => 'deny';
  await registry.executeTool('run_command', { command: 'ls && pip install requests' }, { workspaceRoot: root });
  const read = await registry.executeTool('list_dir', { path: '.' }, { workspaceRoot: root });
  assert.equal(read.isError, false);
  // Kiểm trực tiếp identity ls không bị ghi vào denial (không phụ thuộc bash của host).
  for (const key of actionKeys('run_command', { command: 'ls' }, root)) assert.equal(registry.denied.has(key), false);
});

test('dynamic commands fail closed after denial without another approval', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  let asked = 0;
  registry.approver = async () => { asked++; return 'deny'; };
  await registry.executeTool('run_command', { command: 'rm a.py' }, { workspaceRoot: root });
  for (const command of ['rm "$FILE"', 'bash -lc "rm a.py"', 'cd sub && rm ../a.py', 'python -c "print(1)"', 'rm a*', 'find . -delete']) {
    const result = await registry.executeTool('run_command', { command }, { workspaceRoot: root });
    assert.equal(result.isError, true);
    assert.equal((result.metadata?.policy as { verdict: string }).verdict, 'deny');
  }
  assert.equal(asked, 1);
});

test('package flags, multi-package installs and indirect inputs cannot bypass a package denial', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  let asked = 0;
  registry.approver = async () => { asked++; return 'deny'; };
  await registry.executeTool('run_command', { command: 'pip install requests' }, { workspaceRoot: root });
  for (const command of ['pip3 install --quiet requests', 'python -m pip install other requests', 'pip install -r requirements.txt', 'pip install ./local-package']) {
    const result = await registry.executeTool('run_command', { command }, { workspaceRoot: root });
    assert.equal(result.isError, true);
    assert.equal((result.metadata?.policy as { verdict: string }).verdict, 'deny');
  }
  assert.equal(asked, 1);
  await registry.executeTool('run_command', { command: 'pip install unrelated' }, { workspaceRoot: root });
  assert.equal(asked, 2);
});
