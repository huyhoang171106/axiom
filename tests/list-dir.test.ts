import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ListDirTool } from '../src/tools/list-dir.js';
import { ToolRegistry } from '../src/tools/registry.js';

function makeTree(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-list-dir-'));
  for (const file of files) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'x');
  }
  return root;
}

const tool = new ListDirTool();

test('list_dir shows workspace-relative paths down to the default depth, directories first', async () => {
  const root = makeTree(['README.md', 'src/a.py', 'src/pkg/b.py']);
  const out = await tool.execute({}, { workspaceRoot: root });
  assert.deepEqual(out.split('\n'), ['Directory: . (depth 2)', 'src/', 'src/pkg/', 'src/a.py', 'README.md']);

  const deeper = await tool.execute({ path: 'src', depth: 3 }, { workspaceRoot: root });
  assert.match(deeper, /^src\/pkg\/b\.py$/m);
});

test('list_dir skips generated directories and secret files', async () => {
  const root = makeTree(['.git/HEAD', 'node_modules/x/index.js', '.venv/bin/python', 'pkg/__pycache__/a.pyc', '.env', 'key.pem', '.env.example', 'main.py']);
  const out = await tool.execute({ depth: 5 }, { workspaceRoot: root });
  for (const hidden of ['.git', 'node_modules', '.venv', '__pycache__', '.env\n', 'key.pem']) assert.ok(!`${out}\n`.includes(hidden), hidden);
  assert.match(out, /^\.env\.example$/m);
  assert.match(out, /^main\.py$/m);
});

test('list_dir stops at 500 entries and says so', async () => {
  const root = makeTree(Array.from({ length: 520 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`));
  const lines = (await tool.execute({}, { workspaceRoot: root })).split('\n');
  assert.equal(lines.length, 1 + 500 + 1);
  assert.match(lines.at(-1)!, /stopped at 500 entries/);
});

test('list_dir rejects a missing path and a file', async () => {
  const root = makeTree(['a.py']);
  await assert.rejects(tool.execute({ path: 'nope' }, { workspaceRoot: root }), /not found/);
  await assert.rejects(tool.execute({ path: 'a.py' }, { workspaceRoot: root }), /Not a directory/);
});

test('list_dir goes through the policy: secret paths and paths outside the workspace are denied', async () => {
  const root = makeTree(['a.py']);
  const registry = new ToolRegistry(['list_dir']);
  for (const p of ['.ssh', '../..']) {
    const result = await registry.executeTool('list_dir', { path: p }, { workspaceRoot: root });
    assert.ok(result.isError && /Blocked by policy/.test(result.output), p);
  }
  const ok = await registry.executeTool('list_dir', {}, { workspaceRoot: root });
  assert.ok(!ok.isError && /a\.py/.test(ok.output));
});
