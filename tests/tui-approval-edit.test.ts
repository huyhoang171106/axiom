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
