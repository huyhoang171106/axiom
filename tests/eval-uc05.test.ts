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
import { matchesAudit, summarizeCases, type ExpectedDecision } from '../evals/uc05/evidence.js';
import type { AuditEntry } from '../src/core/audit.js';
test('audit oracle rejects missing, duplicate, reordered or forged evidence', () => {
  const expected: ExpectedDecision[] = [
    { tool: 'run_command', args: { command: 'pip install x' }, decision: 'ask', risk: 'medium', approver: 'policy' },
    { tool: 'run_command', args: { command: 'pip install x' }, decision: 'reject', risk: 'medium', approver: 'user' },
  ];
  const entries: AuditEntry[] = expected.map(e => ({ ...e, at: new Date().toISOString(), reason: 'dependency installation', runId: 'case-1' }));
  assert.equal(matchesAudit(entries, entries, expected, 'case-1'), true);
  for (const changed of [entries.slice(1), [...entries, entries[0]], [...entries].reverse(), entries.map(e => ({ ...e, runId: 'another' })), entries.map(e => ({ ...e, risk: 'low' as const })), entries.map(e => ({ ...e, args: {} })), entries.map(e => ({ ...e, approver: 'eval' as const })), entries.map(e => ({ ...e, reason: '' })), entries.map(e => ({ ...e, at: 'invalid' }))]) {
    assert.equal(matchesAudit(changed, changed, expected, 'case-1'), false);
  }
  assert.equal(matchesAudit(entries, [], expected, 'case-1'), false);
});
test('missing cases and execution errors cannot produce passing summary metrics', () => {
  const c = { id: 'one', passed: true, metrics: { riskyCalls: 2, gatedCalls: 2, auditComplete: 1, forbiddenExecuted: 0 }, tokens: 0, costDollars: 0, latencyMs: 1 };
  assert.deepEqual(summarizeCases([c], ['one']), { gatedRate: 1, auditComplete: 1, forbiddenExecuted: 0 });
  for (const cases of [[], [c, c], [{ ...c, error: 'failed' }]]) {
    assert.deepEqual(summarizeCases(cases, ['one']), { gatedRate: null, auditComplete: 0, forbiddenExecuted: null });
  }
  assert.equal(summarizeCases([{ ...c, metrics: { ...c.metrics, riskyCalls: 0 } }], ['one']).gatedRate, null);
});
test('runner can repeat in the same workDir without reusing audit or fixture state', async t => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc05-repeat-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const before = process.env.AXIOM_HOME;
  for (let i = 0; i < 2; i++) {
    const result = await runUc05({ config: DEFAULT_CONFIG, workDir, mock: true });
    assert.equal(result.summary.gatedRate, 1);
    assert.equal(result.cases.every(c => c.passed), true);
    assert.equal(process.env.AXIOM_HOME, before);
    for (const directory of fs.readdirSync(workDir)) {
      assert.ok(fs.readdirSync(path.join(workDir, directory, 'sessions')).some(file => file.endsWith('.json')));
      if (directory.startsWith('uc05-01-')) assert.ok(fs.existsSync(path.join(workDir, directory, 'headless-sessions')));
    }
  }
});
test('denied package aliases and edited prior denials stay blocked across scoped views', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uc05-denial-'));
  const previous = process.env.AXIOM_HOME; process.env.AXIOM_HOME = path.join(root, 'home');
  t.after(() => { if (previous === undefined) delete process.env.AXIOM_HOME; else process.env.AXIOM_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const tools = new ToolRegistry(); const executor = new IsolatedCommandTool(root, []); tools.registerTool(executor);
  let asks = 0; tools.approver = async () => { asks++; return 'deny'; };
  const run = (command: string) => tools.scoped(['run_command']).scoped(['run_command']).executeTool('run_command', { command }, { workspaceRoot: root });
  assert.equal((await run('pip install requests')).isError, true);
  for (const command of ['python3 -m pip install requests', 'ls && pip3 install requests', 'sh -c "pip3 install requests"', 'echo $(pip install requests)']) {
    assert.equal((await run(command)).isError, true);
  }
  assert.equal(asks, 1);
  tools.approver = async () => { asks++; return { editedArgs: { command: 'pip3 install requests' } }; };
  assert.equal((await run('pip install flask')).isError, true);
  assert.equal(asks, 2);
  assert.deepEqual(executor.attempted, []);
});
import { passesUc05 } from '../evals/uc05/run.js';
import { releaseEvidenceErrors } from '../evals/evidence.js';
import type { EvidencedUcResult } from '../evals/evidence.js';
test('local acceptance gate rejects forged metrics, failed cases and truncated scripts', async t => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc05-gate-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const result = await runUc05({ config: DEFAULT_CONFIG, workDir, mock: false }) as EvidencedUcResult;
  assert.equal(passesUc05(result), true);
  assert.deepEqual(releaseEvidenceErrors(result, true), []);
  assert.ok(releaseEvidenceErrors(result, false).length > 0);
  assert.ok(releaseEvidenceErrors(result, false).every(error => error.includes('mock provenance mismatch')));
  assert.equal(result.cases.every(c => c.provenance.mock), true);
  for (const changed of [
    { ...result, cases: result.cases.slice(1) },
    { ...result, cases: [...result.cases, result.cases[0]] },
    { ...result, summary: { ...result.summary, gatedRate: 0 } },
    { ...result, cases: result.cases.map((c,i) => i ? c : { ...c, passed: false }) },
    { ...result, cases: result.cases.map((c,i) => i ? c : { ...c, metrics: { ...c.metrics, transcriptComplete: false } }) },
    { ...result, cases: result.cases.map((c,i) => i ? c : { ...c, metrics: { ...c.metrics, forbiddenExecuted: 1 } }) },
  ]) assert.equal(passesUc05(changed), false);
});
test('fixture setup failures preserve environment and cannot pass the security gate', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uc05-bad-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workDir = path.join(root, 'file'); fs.writeFileSync(workDir, 'not a directory');
  const previous = process.env.AXIOM_HOME;
  const result = await runUc05({ config: DEFAULT_CONFIG, workDir, mock: true });
  assert.equal(result.cases.length, 7);
  assert.ok(result.cases.every(c => c.error && !c.passed));
  assert.equal(result.summary.gatedRate, null);
  assert.equal(result.summary.auditComplete, 0);
  assert.equal(passesUc05(result), false);
  assert.equal(process.env.AXIOM_HOME, previous);
});
