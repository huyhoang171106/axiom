// tests/tui-approval-edit.test.ts - Editing retains the original approval promise until valid submission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TuiStore } from '../src/tui/store.js';
import type { ApprovalDecision } from '../src/tools/permissions.js';

test('invalid edited args stay pending, valid args resolve once', () => {
  const store = new TuiStore();
  const answers: ApprovalDecision[] = [];
  store.requestApproval({ name: 'run_command', args: { command: 'pip install x' }, reason: 'install', risk: 'medium' }, d => answers.push(d));
  store.beginApprovalEdit(); store.flush();
  assert.match(store.getSnapshot().approvalEdit!.text, /pip install/);
  for (const text of ['{', '[]', 'null', '1']) store.submitApprovalEdit(text);
  store.flush();
  assert.equal(answers.length, 0);
  assert.ok(store.getSnapshot().approvalEditError);
  store.submitApprovalEdit('{"command":"pip install y"}');
  store.resolveApproval('approve'); store.flush();
  assert.deepEqual(answers, [{ editedArgs: { command: 'pip install y' } }]);
  assert.equal(store.getSnapshot().pendingApproval, null);
  assert.equal(store.getSnapshot().approvalEdit, null);
  store.dispose();
});

test('confirm cannot edit and cancelling draft leaves approval pending', () => {
  const store = new TuiStore();
  const answers: ApprovalDecision[] = [];
  store.requestApproval({ name: 'confirm', args: {}, reason: 'route' }, d => answers.push(d));
  store.beginApprovalEdit(); store.flush();
  assert.equal(store.getSnapshot().approvalEdit, null);
  store.requestApproval({ name: 'run_command', args: {}, reason: 'command' }, d => answers.push(d));
  store.beginApprovalEdit(); store.cancelApprovalEdit(); store.flush();
  assert.ok(store.getSnapshot().pendingApproval);
  assert.deepEqual(answers, ['deny']);
  store.cancelInteraction(); store.flush();
  assert.deepEqual(answers, ['deny', 'deny']);
  store.dispose();
});
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { App } from '../src/tui/app.js';
import type { TuiController } from '../src/tui/controller.js';
const wait = () => new Promise(r => setTimeout(r, 80));
const tty = () => Object.assign(new PassThrough(), { columns: 80, rows: 30, isTTY: true, setRawMode() {}, ref() {}, unref() {} });
test('App handles y, default deny and edit cancellation at 80 columns', async () => {
  const store = new TuiStore(); const stdin = tty(); const stdout = tty();
  let output = ''; stdout.on('data', c => { output += String(c); });
  const controller = { interrupt() {}, abort() {}, submit: async () => {}, lastPrompt: '' } as unknown as TuiController;
  const app = render(createElement(App, { store, controller, workspace: '/repo', initial: '' }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false, interactive: true });
  try {
    const answers: ApprovalDecision[] = [];
    const request = () => { store.requestApproval({ name: 'run_command', args: { command: 'pip install x' }, reason: 'install', risk: 'high' }, d => answers.push(d)); store.flush(); };
    await wait(); request(); await wait(); stdin.write('y'); await wait();
    assert.deepEqual(answers, ['approve']);
    request(); await wait(); stdin.write('\r'); await wait();
    assert.deepEqual(answers, ['approve', 'deny']);
    request(); await wait(); stdin.write('e'); await wait();
    assert.ok(store.getSnapshot().approvalEdit);
    stdin.write('\u001b'); await wait();
    assert.equal(store.getSnapshot().approvalEdit, null);
    assert.ok(store.getSnapshot().pendingApproval);
    stdin.write('n'); await wait();
    assert.deepEqual(answers, ['approve', 'deny', 'deny']);
    assert.match(output, /Risk: high/);
    assert.match(output, /\[e\] Edit/);
  } finally { app.unmount(); store.dispose(); }
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { readAudit } from '../src/core/audit.js';

test('keyboard-edited JSON survives validation and passes through real registry policy', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-keyboard-'));
  const before = process.env.AXIOM_HOME; process.env.AXIOM_HOME = path.join(root, 'home');
  t.after(() => { if (before === undefined) delete process.env.AXIOM_HOME; else process.env.AXIOM_HOME = before; fs.rmSync(root, { recursive: true, force: true }); });
  const store = new TuiStore(); const stdin = tty(); const stdout = tty();
  const controller = { interrupt: () => store.cancelInteraction(), abort: () => store.cancelInteraction(), submit: async () => {}, lastPrompt: '' } as unknown as TuiController;
  const app = render(createElement(App, { store, controller, workspace: root, initial: '' }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false, interactive: true });
  const tools = new ToolRegistry(); tools.approver = request => new Promise(resolve => { store.requestApproval(request, resolve); store.flush(); });
  let writes = 0; const tool = tools.getTool('write_file')!; const execute = tool.execute.bind(tool);
  tool.execute = async (args, context) => { writes++; return execute(args, context); };
  try {
    await wait();
    const pending = tools.executeTool('write_file', { path: 'package.json', content: '{}' }, { workspaceRoot: root });
    await wait(); stdin.write('e'); await wait();
    store.updateApprovalEdit({ text: '', cursor: 0 }); store.flush(); await wait();
    stdin.write('{'); await wait(); stdin.write('\r'); await wait();
    assert.equal(store.getSnapshot().approvalEdit?.text, '{');
    assert.ok(store.getSnapshot().approvalEditError);
    assert.equal(writes, 0);
    store.updateApprovalEdit({ text: '', cursor: 0 }); store.flush(); await wait();
    stdin.write('{"path":"note.txt","content":"yes"}'); await wait(); stdin.write('\r');
    const result = await pending; await wait();
    assert.equal(result.isError, false);
    assert.equal(writes, 1);
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'yes');
    assert.equal(fs.existsSync(path.join(root, 'package.json')), false);
    assert.equal(readAudit(10).some(e => e.decision === 'edited' && e.args.path === 'note.txt'), true);
    const denied = tools.executeTool('write_file', { path: 'package.json', content: '{}' }, { workspaceRoot: root });
    await wait(); stdin.write('e'); await wait();
    store.updateApprovalEdit({ text: '', cursor: 0 }); store.flush(); await wait();
    stdin.write('{"path":".env","content":"blocked"}'); await wait(); stdin.write('\r');
    assert.equal((await denied).isError, true);
    assert.equal(writes, 1);
    assert.equal(fs.existsSync(path.join(root, '.env')), false);
  } finally { store.cancelInteraction(); app.unmount(); store.dispose(); }
});
import { TuiController as RealTuiController } from '../src/tui/controller.js';
import { defaultCommandRouter } from '../src/commands/index.js';
test('Ctrl+C during argument editing aborts a real controller turn without writing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-abort-'));
  const before = process.env.AXIOM_HOME; process.env.AXIOM_HOME = path.join(root, 'home');
  t.after(() => { if (before === undefined) delete process.env.AXIOM_HOME; else process.env.AXIOM_HOME = before; fs.rmSync(root, { recursive: true, force: true }); });
  const store = new TuiStore(); const controller = new RealTuiController(store, { workspaceRoot: root, mock: true });
  const stdin = tty(); const command = defaultCommandRouter.get('fix')!; const original = command.run;
  const app = render(createElement(App, { store, controller, workspace: root, initial: '' }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout: tty() as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false, interactive: true });
  try {
    command.run = async (_args, ctx) => { await ctx.tools.executeTool('write_file', { path: 'package.json', content: '{}' }, { workspaceRoot: root }); };
    await wait(); const pending = controller.submit('/fix fixture'); await wait();
    stdin.write('e'); await wait(); assert.ok(store.getSnapshot().approvalEdit);
    stdin.write('\u0003'); await pending; await wait();
    assert.equal(store.getSnapshot().pendingApproval, null);
    assert.equal(store.getSnapshot().approvalEdit, null);
    assert.equal(store.getSnapshot().busy, false);
    assert.equal(fs.existsSync(path.join(root, 'package.json')), false);
  } finally { command.run = original; controller.abort(); app.unmount(); store.dispose(); }
});
