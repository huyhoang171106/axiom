// tests/denied-actions-integration.test.ts - Denial qua registry, C2, graph nodes và TUI /clear thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { ToolRegistry } from '../src/tools/registry.js';
import { TuiController } from '../src/tui/controller.js';
import { TuiStore } from '../src/tui/store.js';
import { defaultCommandRouter } from '../src/commands/index.js';
import type { ToolResult } from '../src/core/types.js';

function workspace(t: { after(fn: () => void): void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-denied-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const create = (file: string) => `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+new\n`;
const change = (file: string, target = file) => `--- a/${file}\n+++ b/${target}\n@@ -1 +1 @@\n-old\n+new\n`;

function assertDenied(result: ToolResult): void {
  assert.equal(result.isError, true, result.output);
  assert.equal(result.metadata?.success, false);
  assert.equal((result.metadata?.policy as { verdict: string }).verdict, 'deny');
}

test('session denial crosses nested scopes and permission views, unattended execution and independent sessions stay separate', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  const nodeA = registry.scoped(['run_command', 'read_file']);
  const readMode = registry.scoped(['read_file']);
  const editMode = registry.scoped(['write_file', 'apply_patch', 'run_command']).scoped(['run_command', 'write_file']);
  let asked = 0;
  registry.approver = async () => { asked++; return 'deny'; };
  await nodeA.executeTool('run_command', { command: 'rm a.py' }, { workspaceRoot: root });
  assert.equal(nodeA.denied, registry.denied);
  assert.equal(readMode.denied, editMode.denied);
  registry.approver = undefined;
  registry.allowWithoutApprover = true;
  assertDenied(await editMode.executeTool('write_file', { path: './a.py', content: 'bypass' }, { workspaceRoot: root }));
  assert.equal(asked, 1);
  assert.equal(fs.existsSync(path.join(root, 'a.py')), false);
  const independent = new ToolRegistry();
  assert.notEqual(independent.denied, registry.denied);
  const allowed = await independent.executeTool('write_file', { path: 'a.py', content: 'independent' }, { workspaceRoot: root });
  assert.equal(allowed.isError, false);
  assert.equal(fs.readFileSync(path.join(root, 'a.py'), 'utf8'), 'independent');
});

test('a denied patch cannot be retried through edit, write_file, rename, delete or shell', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  fs.writeFileSync(path.join(root, 'package.json'), 'old\n');
  let asked = 0;
  registry.approver = async () => { asked++; return 'deny'; };
  await registry.executeTool('apply_patch', { patch: change('package.json') }, { workspaceRoot: root });
  for (const [name, args] of [
    ['edit', { path: 'package.json', oldText: 'old', newText: 'new' }],
    ['write_file', { path: 'package.json', content: 'new' }],
    ['apply_patch', { patch: change('package.json', 'other.txt') }],
    ['apply_patch', { patch: '--- a/package.json\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n' }],
    ['run_command', { command: 'env FOO=1 rm ./package.json' }],
    ['run_command', { command: 'echo new > package.json' }],
  ] as const) assertDenied(await registry.executeTool(name, args, { workspaceRoot: root }));
  assert.equal(asked, 1);
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), 'old\n');
  assert.deepEqual(fs.readdirSync(root), ['package.json']);
  assert.equal((await registry.executeTool('read_file', { path: 'package.json' }, { workspaceRoot: root })).isError, false);
});

test('denying a multi-file patch remembers every path and allows unrelated real C2 changes', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  let asked = 0;
  registry.approver = async () => { asked++; return 'deny'; };
  const patch = Array.from({ length: 6 }, (_, i) => create(`f${i}.txt`)).join('');
  await registry.executeTool('apply_patch', { patch }, { workspaceRoot: root });
  for (let i = 0; i < 6; i++) assertDenied(await registry.executeTool('write_file', { path: `f${i}.txt`, content: 'bypass' }, { workspaceRoot: root }));
  assert.equal(asked, 1);
  assert.equal((await registry.executeTool('apply_patch', { patch: create('other.txt') }, { workspaceRoot: root })).isError, false);
  assert.deepEqual(fs.readdirSync(root), ['other.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'other.txt'), 'utf8'), 'new\n');
});

test('edited arguments recheck denial, secret guards and real C2 test guards', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'test_a.py'), 'assert True\n');
  registry.approver = async () => 'deny';
  await registry.executeTool('write_file', { path: 'package.json', content: 'old' }, { workspaceRoot: root });
  for (const [name, editedArgs] of [
    ['write_file', { path: 'package.json', content: 'bypass' }],
    ['write_file', { path: '.env', content: 'bypass' }],
    ['edit', { path: 'tests/test_a.py', oldText: 'assert True', newText: 'pass' }],
    ['apply_patch', { patch: '--- a/tests/test_a.py\n+++ b/tests/test_a.py\n@@ -1 +1 @@\n-assert True\n+pass\n' }],
    ['run_command', { command: 'sh -c "rm package.json"' }],
  ] as const) {
    let asked = 0;
    registry.approver = async () => { asked++; return { editedArgs }; };
    const original = name === 'apply_patch' ? { patch: create('SECURITY.md') }
      : name === 'run_command' ? { command: 'pip install other-package' }
      : name === 'edit' ? { path: 'SECURITY.md', oldText: 'old', newText: 'new' }
      : { path: 'SECURITY.md', content: 'approved' };
    const result = await registry.executeTool(name, original, { workspaceRoot: root });
    assert.equal(result.isError, true);
    assert.equal(result.metadata?.success, false);
    assert.equal(asked, 1);
  }
  assert.equal(fs.readFileSync(path.join(root, 'tests', 'test_a.py'), 'utf8'), 'assert True\n');
  assert.deepEqual(fs.readdirSync(root), ['tests']);
});

test('an edited safe action executes the real tool once without poisoning the original action', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  let asked = 0;
  registry.approver = async () => { asked++; return { editedArgs: { path: 'safe.txt', content: 'edited' } }; };
  const result = await registry.executeTool('write_file', { path: 'package.json', content: 'original' }, { workspaceRoot: root });
  assert.equal(result.isError, false);
  assert.equal(asked, 1);
  assert.equal(fs.readFileSync(path.join(root, 'safe.txt'), 'utf8'), 'edited');
  assert.equal(registry.denied.size, 0);
  assert.deepEqual(fs.readdirSync(root), ['safe.txt']);
});

test('a concurrent denial during approval is checked again before execution', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  let release!: (answer: 'approve') => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  registry.approver = async () => { started(); return new Promise((resolve) => { release = resolve; }); };
  const pending = registry.executeTool('write_file', { path: 'package.json', content: 'bypass' }, { workspaceRoot: root });
  await waiting;
  registry.approver = async () => 'deny';
  await registry.scoped(['write_file']).executeTool('write_file', { path: 'package.json', content: 'denied' }, { workspaceRoot: root });
  release('approve');
  assertDenied(await pending);
  assert.equal(fs.existsSync(path.join(root, 'package.json')), false);
});

test('real graph node A denial blocks node B using another tool with no side effect or second approval', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  let asked = 0;
  const results: ToolResult[] = [];
  registry.approver = async () => { asked++; return 'deny'; };
  const state = Annotation.Root({});
  const graph = new StateGraph(state)
    .addNode('node_a', async () => {
      results.push(await registry.scoped(['write_file']).executeTool('write_file', { path: 'package.json', content: 'denied' }, { workspaceRoot: root }));
      return {};
    })
    .addNode('node_b', async () => {
      results.push(await registry.scoped(['apply_patch']).executeTool('apply_patch', { patch: create('package.json') }, { workspaceRoot: root }));
      return {};
    }).addEdge(START, 'node_a').addEdge('node_a', 'node_b').addEdge('node_b', END).compile();
  await graph.invoke({});
  assert.equal(results.length, 2);
  assertDenied(results[1]);
  assert.match(results[1].output, /same action was denied earlier/);
  assert.equal(asked, 1);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('/clear keeps session denial through the real TUI command path', async (t) => {
  const root = workspace(t), home = workspace(t);
  const previous = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.AXIOM_HOME; else process.env.AXIOM_HOME = previous; });
  const store = new TuiStore();
  t.after(() => store.dispose());
  const controller = new TuiController(store, { workspaceRoot: root, mock: true });
  let session: ToolRegistry | undefined;
  const results: ToolResult[] = [];
  let asked = 0;
  defaultCommandRouter.register({ name: 'e2-deny-probe', summary: 'test', usage: '/e2-deny-probe', async run(_args, ctx) {
    if (session) assert.equal(ctx.tools, session);
    session = ctx.tools;
    ctx.tools.approver = async () => { asked++; return 'deny'; };
    results.push(await ctx.tools.executeTool('write_file', { path: 'package.json', content: 'denied' }, { workspaceRoot: root }));
  } });
  await controller.submit('/e2-deny-probe');
  await controller.submit('/clear');
  await controller.submit('/e2-deny-probe');
  assert.equal(asked, 1);
  assertDenied(results[1]);
  assert.match(results[1].output, /same action was denied earlier/);
  assert.equal(fs.existsSync(path.join(root, 'package.json')), false);
});

test('directory denials protect descendants and ancestor deletions without affecting siblings or reads', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  fs.mkdirSync(path.join(root, 'kept'));
  fs.writeFileSync(path.join(root, 'kept', 'a.txt'), 'old');
  registry.approver = async () => 'deny';
  await registry.executeTool('run_command', { command: 'rm -r kept' }, { workspaceRoot: root });
  assertDenied(await registry.executeTool('edit', { path: 'kept/a.txt', oldText: 'old', newText: 'new' }, { workspaceRoot: root }));
  assert.equal((await registry.executeTool('read_file', { path: 'kept/a.txt' }, { workspaceRoot: root })).isError, false);
  assert.equal((await registry.executeTool('write_file', { path: 'sibling.txt', content: 'safe' }, { workspaceRoot: root })).isError, false);
  assert.equal(fs.readFileSync(path.join(root, 'kept', 'a.txt'), 'utf8'), 'old');
  const other = new ToolRegistry();
  other.approver = async () => 'deny';
  await other.executeTool('run_command', { command: 'rm kept/a.txt' }, { workspaceRoot: root });
  assertDenied(await other.executeTool('run_command', { command: 'rm -rf kept' }, { workspaceRoot: root }));
});

test('junction aliases cannot hide a denial, sensitive config, or test tampering from C2', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'test_a.py'), 'assert True\n');
  fs.symlinkSync(path.join(root, 'tests'), path.join(root, 'alias'), 'junction');
  let asked = 0;
  registry.approver = async () => { asked++; return 'deny'; };
  for (const [name, args] of [
    ['edit', { path: 'alias/test_a.py', oldText: 'assert True', newText: 'pass' }],
    ['write_file', { path: 'alias/new.py', content: 'import pytest\npytest.skip()\n' }],
    ['apply_patch', { patch: '--- a/alias/test_a.py\n+++ b/alias/test_a.py\n@@ -1 +1 @@\n-assert True\n+pass\n' }],
    ['run_command', { command: 'rm alias/test_a.py' }],
  ] as const) {
    const result = await registry.executeTool(name, args, { workspaceRoot: root });
    assert.equal(result.isError, true, result.output);
    assert.equal(result.metadata?.success, false);
  }
  assert.equal(asked, 0);
  fs.mkdirSync(path.join(root, '.github'));
  fs.symlinkSync(path.join(root, '.github'), path.join(root, 'config-alias'), 'junction');
  await registry.executeTool('write_file', { path: 'config-alias/new.yml', content: 'denied' }, { workspaceRoot: root });
  assert.equal(asked, 1);
  assertDenied(await registry.executeTool('apply_patch', { patch: create('.github/new.yml') }, { workspaceRoot: root }));
  assert.equal(asked, 1);
  assert.equal(fs.readFileSync(path.join(root, 'tests', 'test_a.py'), 'utf8'), 'assert True\n');
  assert.equal(fs.existsSync(path.join(root, '.github', 'new.yml')), false);
});

test('approval and edited args cannot target a junction switched to a previously denied path', async (t) => {
  for (const edited of [false, true]) {
    const root = workspace(t), registry = new ToolRegistry();
    fs.mkdirSync(path.join(root, 'safe'));
    fs.mkdirSync(path.join(root, '.github'));
    registry.approver = async () => 'deny';
    await registry.executeTool('write_file', { path: '.github/a.yml', content: 'denied' }, { workspaceRoot: root });
    fs.symlinkSync(path.join(root, 'safe'), path.join(root, 'alias'), 'junction');
    registry.approver = async () => {
      fs.unlinkSync(path.join(root, 'alias'));
      fs.symlinkSync(path.join(root, '.github'), path.join(root, 'alias'), 'junction');
      return edited ? { editedArgs: { path: 'alias/a.yml', content: 'bypass' } } : 'approve';
    };
    // Force ask bằng cấu hình nhạy cảm; alias được đổi bên trong approver thật.
    const args = edited ? { path: 'SECURITY.md', content: 'request' } : { path: 'alias/package.json', content: 'request' };
    if (!edited) {
      registry.approver = async () => {
        fs.unlinkSync(path.join(root, 'alias'));
        fs.symlinkSync(path.join(root, '.github'), path.join(root, 'alias'), 'junction');
        return 'approve';
      };
      // Deny đúng target mới của package.json trước khi đổi junction.
      const denyView = registry.scoped(['write_file']);
      const previous = registry.approver;
      registry.approver = async () => 'deny';
      await denyView.executeTool('write_file', { path: '.github/package.json', content: 'denied' }, { workspaceRoot: root });
      registry.approver = previous;
    }
    assertDenied(await registry.executeTool('write_file', args, { workspaceRoot: root }));
    assert.deepEqual(fs.readdirSync(path.join(root, '.github')), []);
    assert.deepEqual(fs.readdirSync(path.join(root, 'safe')), []);
  }
});

test('wrapped hard-denied git pushes and canonical secret paths never reach approval', async (t) => {
  const root = workspace(t), registry = new ToolRegistry();
  registry.approver = async () => assert.fail('hard deny must not ask');
  for (const command of ['sh -c "git push origin main"', 'env FOO=1 command git push origin main', 'sh -c "cat .env"']) {
    assertDenied(await registry.executeTool('run_command', { command }, { workspaceRoot: root }));
  }
  assert.deepEqual(fs.readdirSync(root), []);
});
