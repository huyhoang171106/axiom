// tests/tui-results-integration.test.ts - Controller/store/App routing with structured command fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink';
import { TuiController } from '../src/tui/controller.js';
import { TuiStore } from '../src/tui/store.js';
import { App } from '../src/tui/app.js';
import { defaultCommandRouter } from '../src/commands/index.js';
import type { CommandResult } from '../src/commands/types.js';
import { visibleWidth } from '../src/tui/layout.js';
import { fileLink } from '../src/core/rag/citations.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { recordDecision } from '../src/core/audit.js';
const tty = () => Object.assign(new PassThrough(), { columns: 80, rows: 40, isTTY: true, setRawMode() {}, ref() {}, unref() {} });
const wait = () => new Promise(r => setTimeout(r, 80));

test('structured fixtures pass through real controller, store and App without text duplication', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'results-app-'));
  const previous = process.env.AXIOM_HOME; process.env.AXIOM_HOME = path.join(root, 'home');
  t.after(() => { if (previous === undefined) delete process.env.AXIOM_HOME; else process.env.AXIOM_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'note.py'), 'one\ntwo\n');
  const citation = { path: 'note.py', startLine: 1, endLine: 2 };
  const answer = { text: 'ANSWER note.py:L1-L2 invalid.py:L1-L2', found: true, citations: [citation] };
  const feature = { status: 'failed', summary: 'FEATURE', threadId: 'feature-example', steps: [{ id: 1, title: 'STEP', status: 'failed', files: ['note.py'] }], filesChanged: [] };
  const fix = { status: 'failed', summary: 'FIX', rounds: [{ round: 1, hypothesis: 'HYPOTHESIS', testsPassed: 1, testsFailed: 2, regressions: ['REGRESSION'], patchApplied: true }], filesChanged: ['note.py'], diffStat: { files: 1, added: 2, removed: 1 } };
  const fixtures: Array<[string, CommandResult, string]> = [
    ['ask', { kind: 'ask-answer', data: answer, text: 'FALLBACK' }, 'ANSWER'],
    ['fix', { kind: 'fix-report', data: fix, text: 'FALLBACK' }, 'REGRESSION'],
    ['feature', { kind: 'feature-report', data: feature, text: 'FALLBACK' }, 'feature-example'],
    ['triage', { kind: 'issue-ticket', data: { result: { route: 'answer', text: 'FALLBACK', data: answer } }, text: 'FALLBACK' }, 'ANSWER'],
    ['triage', { kind: 'issue-ticket', data: { result: { route: 'fix', text: 'FALLBACK', data: fix } }, text: 'FALLBACK' }, 'REGRESSION'],
    ['triage', { kind: 'issue-ticket', data: { result: { route: 'implement', text: 'FALLBACK', data: feature } }, text: 'FALLBACK' }, 'feature-example'],
    ['ask', { kind: 'ask-answer', data: {}, text: 'MALFORMED-FALLBACK' }, 'MALFORMED-FALLBACK'],
  ];
  for (const [name, fixture, marker] of fixtures) {
    const command = defaultCommandRouter.get(name)!; const original = command.run;
    const store = new TuiStore(); const controller = new TuiController(store, { workspaceRoot: root, mock: true });
    const stdout = tty(); let output = ''; stdout.on('data', c => { output += String(c); });
    const app = render(createElement(App, { store, controller, workspace: root, initial: '' }), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: tty() as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false });
    try {
      command.run = async () => fixture;
      await wait(); await controller.submit(`/${name} fixture`); await wait();
      const clean = stripVTControlCharacters(output);
      assert.ok(clean.includes(marker), clean);
      if (fixture.text === 'FALLBACK') assert.equal(clean.includes('FALLBACK'), false);
      assert.equal(store.getSnapshot().entries.at(-1)?.kind, fixture.kind);
      if (marker === 'ANSWER') { assert.ok(output.includes(fileLink(root, citation))); assert.equal(output.includes('invalid.py#'), false); }
      for (const line of clean.split(/\r?\n/)) assert.ok(visibleWidth(line) <= 80, line);
    } finally { command.run = original; app.unmount(); store.dispose(); }
  }
});

test('real cost and audit commands render their session data without mutating costs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'results-real-')); const previous = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(root, 'home');
  t.after(() => { if (previous === undefined) delete process.env.AXIOM_HOME; else process.env.AXIOM_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
  recordDecision({ at: new Date().toISOString(), tool: 'run_command', args: { command: 'pip install x' }, reason: 'install', risk: 'medium', decision: 'reject', approver: 'user' });
  const store = new TuiStore(); const controller = new TuiController(store, { workspaceRoot: root, mock: true });
  const stdout = tty(); let output = ''; stdout.on('data', c => { output += String(c); });
  const app = render(createElement(App, { store, controller, workspace: root, initial: '' }), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: tty() as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false });
  try {
    await wait(); await controller.submit('/cost'); await controller.submit('/audit'); await wait();
    assert.equal((store.getSnapshot().entries[0].data as ReturnType<CostTracker['getSessionSummary']>).totalTokens, 0);
    assert.match(stripVTControlCharacters(output), /Total \$0\.000000/);
    assert.match(stripVTControlCharacters(output), /medium \| reject \| user/);
    assert.equal(store.getSnapshot().entries[1].kind, 'audit');
  } finally { app.unmount(); store.dispose(); }
});
import { renderToString } from 'ink';
import { Turn } from '../src/tui/components/transcript.js';
import type { TuiTurn } from '../src/tui/store.js';
import { redact, registerSecret } from '../src/core/secrets.js';
test('structured long fields wrap at 80 columns and never hide the final value', () => {
  const tail = 'FINAL-VALUE';
  const turn: TuiTurn = { id: 1, kind: 'audit', data: [{ at: 'now', tool: 'write_file', args: { content: 'wide '.repeat(40) + tail }, risk: 'high', decision: 'reject', approver: 'user' }], text: '', status: 'completed', thinking: '', tools: [], usage: null, error: null };
  const output = stripVTControlCharacters(renderToString(createElement(Turn, { turn, width: 80, expanded: false }), { columns: 80 }));
  assert.ok(output.includes(tail));
  assert.ok(output.split('\n').every(line => visibleWidth(line) <= 80));
});
test('structured audit and answer text redact registered secrets before terminal output', () => {
  const secret = 'fixture-sensitive-value'; registerSecret(secret);
  for (const [kind, data] of [
    ['audit', [{ at: 'now', tool: 'write_file', args: { content: secret }, risk: 'high', decision: 'reject', approver: 'user' }]],
    ['ask-answer', { text: secret, found: false, citations: [] }],
  ] as const) {
    const turn: TuiTurn = { id: 1, kind, data, text: secret, status: 'completed', thinking: '', tools: [], usage: null, error: null };
    const output = renderToString(createElement(Turn, { turn, width: 80, expanded: false, workspaceRoot: '/repo' }), { columns: 80 });
    assert.equal(output.includes(secret), false);
    assert.ok(output.includes(redact(secret)));
  }
});
test('ticket preview reaches App before confirm and rejecting never dispatches the route', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-order-')); const before = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(root, 'home');
  t.after(() => { if (before === undefined) delete process.env.AXIOM_HOME; else process.env.AXIOM_HOME = before; fs.rmSync(root, { recursive: true, force: true }); });
  const store = new TuiStore(); const controller = new TuiController(store, { workspaceRoot: root, mock: true });
  const stdin = tty(); const stdout = tty(); let output = ''; stdout.on('data', c => { output += String(c); });
  const command = defaultCommandRouter.get('triage')!; const original = command.run; let dispatched = false;
  const ticket = { type: 'bug', priority: 'P1 crashes', route: 'fix', affected_files: [], reproduction_steps: ['PREVIEW-BEFORE-CONFIRM'], acceptance_criteria: ['passes'], missing_info: [] };
  const app = render(createElement(App, { store, controller, workspace: root, initial: '' }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false, interactive: true });
  try {
    command.run = async (_args, ctx) => {
      ctx.bus.emit('issue_ticket', { ticket, warnings: [], workspaceRoot: root });
      const confirmed = await ctx.ui.confirm('RUN-ROUTE?');
      if (confirmed) dispatched = true;
      return { kind: 'issue-ticket', data: { ticket, warnings: [], result: { route: 'fix', text: 'STOPPED' } }, text: 'STOPPED' };
    };
    await wait(); const pending = controller.submit('/triage fixture'); await wait();
    assert.equal(dispatched, false); assert.ok(store.getSnapshot().pendingApproval);
    const clean = stripVTControlCharacters(output);
    assert.ok(clean.includes('PREVIEW-BEFORE-CONFIRM'));
    assert.ok(clean.indexOf('PREVIEW-BEFORE-CONFIRM') < clean.indexOf('RUN-ROUTE?'));
    stdin.write('n'); await pending; await wait();
    assert.equal(dispatched, false);
    assert.equal(store.getSnapshot().entries.filter(e => e.kind === 'issue-ticket-preview').length, 1);
  } finally { command.run = original; controller.abort(); app.unmount(); store.dispose(); }
});


test('C7 fix reports validate direct and nested payloads and redact the executed patch', () => {
  const secret = 'fix-patch-sensitive-value'; registerSecret(secret);
  const report = { status: 'fixed', summary: 'C7-SUMMARY', rounds: [], filesChanged: ['note.py'], diffStat: { files: 1, added: 1, removed: 0 }, patch: '+C7-PATCH\n+' + secret };
  for (const nested of [false, true]) {
    const turn: TuiTurn = { id: 1, kind: nested ? 'issue-ticket' : 'fix-report', data: nested ? { result: { route: 'fix', data: report } } : report, text: 'UNUSED-FALLBACK', status: 'completed', thinking: '', tools: [], usage: null, error: null };
    const output = renderToString(createElement(Turn, { turn, width: 80, expanded: false }), { columns: 80 });
    assert.ok(output.includes('+C7-PATCH')); assert.equal(output.includes(secret), false);
    assert.equal(output.includes('UNUSED-FALLBACK'), false);
    assert.equal(output.split('C7-SUMMARY').length, 2);
    const invalid = renderToString(createElement(Turn, { turn: { ...turn, kind: 'fix-report', data: { ...report, status: 'unknown' } }, width: 80, expanded: false }), { columns: 80 });
    assert.ok(invalid.includes('UNUSED-FALLBACK'));
  }
});
