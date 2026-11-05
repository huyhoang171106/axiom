// tests/fix.test.ts - UC-03 /fix graph: rounds, stop conditions, budget, guard, keep, trace
//
// Most tests use a scripted MockProvider and a fake test runner that reads the workspace files, so they run
// everywhere. One test drives the real sandboxed verifier on seeded bug-01; it must run on CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixIssue, type FixOptions } from '../src/agents/fix.js';
import { readIssueArg, formatFixReport } from '../src/commands/fix.js';
import { EventBus } from '../src/core/event-bus.js';
import { pythonBin } from '../src/core/paths.js';
import type { TestRun } from '../src/core/verifier.js';
import type { ChatParams } from '../src/llm/base-provider.js';
import { MockProvider, type MockResponse } from '../src/llm/providers/mock.js';
import { isBwrapUsable } from '../src/tools/sandbox.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ISSUES_DIR, seed } from '../evals/issues/bugs.js';

process.env.AXIOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-fix-home-'));

const CALC = 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a + b\n';
const ISSUE = 'sub(5, 3) returns 8, expected 2.';
const REPRO_PATCH = '--- /dev/null\n+++ b/tests/test_repro.py\n@@ -0,0 +1,4 @@\n+from calc import sub\n+\n+def test_sub():\n+    assert sub(5, 3) == 2\n';
const FIX_PATCH = '--- a/calc.py\n+++ b/calc.py\n@@ -5,2 +5,2 @@\n def sub(a, b):\n-    return a + b\n+    return a - b\n';
const call = (name: string, args: Record<string, unknown>, id = `${name}-${Math.random().toString(36).slice(2, 8)}`): MockResponse => ({ toolCalls: [{ id, name, arguments: args }] });

function workspace(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-fix-ws-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'calc.py'), CALC);
  fs.writeFileSync(path.join(root, 'tests/test_calc.py'), 'from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n');
  return root;
}

/** Decides each test from the source, like pytest would: test_add needs `a + b` in add, test_sub needs `a - b` in sub. */
function fakeRunner(overrides: { full?: (run: TestRun) => TestRun; delayMs?: number } = {}): NonNullable<FixOptions['runTests']> & { calls: string[] } {
  const calls: string[] = [];
  const runner = async (root: string, opts?: { target?: string }) => {
    calls.push(opts?.target ?? '<all>');
    if (overrides.delayMs) await new Promise((r) => setTimeout(r, overrides.delayMs));
    const calc = fs.readFileSync(path.join(root, 'calc.py'), 'utf8');
    const [addSrc, subSrc] = calc.split('def sub');
    const results: Array<[string, boolean]> = [['tests/test_calc.py::test_add', /return a \+ b/.test(addSrc)]];
    if (fs.existsSync(path.join(root, 'tests/test_repro.py'))) results.push(['tests/test_repro.py::test_sub', /return a - b/.test(subSrc ?? '')]);
    const picked = results.filter(([id]) => !opts?.target || id === opts.target || id.startsWith(`${opts.target}::`));
    const run: TestRun = {
      passed: picked.filter(([, ok]) => ok).map(([id]) => id),
      failed: picked.filter(([, ok]) => !ok).map(([id]) => id),
      skipped: [], errors: [], timedOut: false, complete: true, output: '',
      exitCode: picked.every(([, ok]) => ok) ? 0 : 1,
    };
    return !opts?.target && overrides.full ? overrides.full(run) : run;
  };
  return Object.assign(runner, { calls });
}

/** Responses per workflow step (the system prompt names it), consumed in order across rounds. */
function scripted(script: Partial<Record<'reproduce' | 'locate' | 'patch' | 'report', MockResponse[]>>): MockProvider {
  const provider = new MockProvider('mock');
  provider.callLimit = 500;
  provider.setHandler((params: ChatParams) => {
    const system = params.messages.find((m) => m.role === 'system')?.content ?? '';
    const step = /Axiom \/fix, step: (\w+)/.exec(system)?.[1] as keyof typeof script;
    return script[step]?.shift() ?? { content: 'done' };
  });
  return provider;
}

function options(root: string, provider: MockProvider, extra: Partial<FixOptions> = {}): FixOptions {
  return { issue: ISSUE, workspaceRoot: root, provider, model: 'mock-model', bus: new EventBus(), tools: new ToolRegistry(), runTests: fakeRunner(), ...extra };
}

const reproduceScript = () => [call('apply_patch', { patch: REPRO_PATCH }), call('submit_repro', { targetTests: ['tests/test_repro.py::test_sub'] })];
/** Messages the model saw for a step, to check what the harness told it. */
const promptsFor = (provider: MockProvider, step: string) =>
  provider.callHistory.filter((p) => p.messages.some((m) => m.role === 'system' && m.content.includes(`step: ${step}`))).map((p) => p.messages.map((m) => m.content).join('\n'));

test('fixes a one-file bug in one round and reports fixed', async (t) => {
  const root = workspace(t);
  const provider = scripted({
    reproduce: reproduceScript(),
    locate: [call('submit_hypothesis', { hypothesis: 'sub in calc.py adds instead of subtracting.', files: ['calc.py'] })],
    patch: [call('apply_patch', { patch: FIX_PATCH }), { content: 'sub now subtracts.' }],
  });
  const report = await fixIssue(options(root, provider));
  assert.equal(report.status, 'fixed', report.summary);
  assert.equal(report.rounds.length, 1);
  assert.deepEqual(report.rounds[0], { round: 1, hypothesis: 'sub in calc.py adds instead of subtracting.', patchApplied: true, testsPassed: 2, testsFailed: 0, regressions: [] });
  assert.deepEqual(report.filesChanged, ['calc.py', 'tests/test_repro.py']);
  assert.deepEqual(report.diffStat, { files: 2, added: 5, removed: 1 });
  assert.equal(report.explanation, undefined);
  assert.match(report.summary, /Cause: sub in calc\.py adds/);
  assert.match(fs.readFileSync(path.join(root, 'calc.py'), 'utf8'), /return a - b/);
});

test('submit_repro rejects a target that passes and accepts one that fails', async (t) => {
  const root = workspace(t);
  const provider = scripted({
    reproduce: [call('submit_repro', { targetTests: ['tests/test_calc.py::test_add'] }), ...reproduceScript()],
    locate: [call('submit_hypothesis', { hypothesis: 'h', files: ['calc.py'] })],
    patch: [call('apply_patch', { patch: FIX_PATCH })],
  });
  const report = await fixIssue(options(root, provider));
  assert.equal(report.status, 'fixed');
  assert.ok(promptsFor(provider, 'reproduce').some((p) => /tests\/test_calc\.py::test_add: does not reproduce/.test(p)));
});

test('no reproduction ends with a failure report and no patch', async (t) => {
  const root = workspace(t);
  const provider = scripted({ reproduce: [{ content: 'I could not find a failing test.' }] });
  const report = await fixIssue(options(root, provider));
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.rounds, []);
  assert.match(report.summary, /could not reproduce/);
  assert.equal(promptsFor(provider, 'locate').length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'calc.py'), 'utf8'), CALC);
});

test('stops after 5 rounds on an unfixable bug with a failure report', async (t) => {
  const root = workspace(t);
  const rounds = [1, 2, 3, 4, 5];
  const provider = scripted({
    reproduce: reproduceScript(),
    locate: rounds.map((n) => call('submit_hypothesis', { hypothesis: `H${n}`, files: ['calc.py'] })),
    // Each round applies a patch that does not fix anything.
    patch: rounds.flatMap((n) => [call('apply_patch', { patch: `--- /dev/null\n+++ b/note_${n}.txt\n@@ -0,0 +1 @@\n+try ${n}\n` }), { content: 'done' }]),
  });
  const report = await fixIssue(options(root, provider));
  assert.equal(report.status, 'failed');
  assert.equal(report.rounds.length, 5);
  assert.ok(report.rounds.every((r) => r.patchApplied && r.testsFailed === 1));
  assert.match(report.summary, /stopped after 5 rounds/);
  assert.match(report.summary, /Rejected hypotheses: H1 \| H2 \| H3 \| H4 \| H5/);
  assert.match(report.summary, /Next step:/);
  assert.equal(promptsFor(provider, 'locate').length, 5);
});

test('rejected hypotheses are passed to the next round', async (t) => {
  const root = workspace(t);
  const provider = scripted({
    reproduce: reproduceScript(),
    locate: [call('submit_hypothesis', { hypothesis: 'FIRST-GUESS', files: [] }), call('submit_hypothesis', { hypothesis: 'second', files: [] })],
    patch: [call('apply_patch', { patch: '--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+x\n' }), { content: 'done' }, call('apply_patch', { patch: FIX_PATCH })],
  });
  const report = await fixIssue(options(root, provider));
  assert.equal(report.status, 'fixed');
  const locates = promptsFor(provider, 'locate');
  assert.ok(!locates[0].includes('FIRST-GUESS'));
  assert.match(locates.at(-1)!, /Rejected hypotheses \(Đã loại\), do not repeat:\n- FIRST-GUESS/);
});

test('a regression sends the graph back to locate', async (t) => {
  const root = workspace(t);
  const bus = new EventBus();
  const events: string[] = [];
  bus.on('node', (e) => events.push(`${e.node}:${e.phase}`));
  const breakAdd = '--- a/calc.py\n+++ b/calc.py\n@@ -1,6 +1,6 @@\n def add(a, b):\n-    return a + b\n+    return a - b\n \n \n def sub(a, b):\n-    return a + b\n+    return a - b\n';
  const fixAdd = '--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n';
  const provider = scripted({
    reproduce: reproduceScript(),
    locate: [call('submit_hypothesis', { hypothesis: 'both use the wrong operator', files: ['calc.py'] }), call('submit_hypothesis', { hypothesis: 'only sub was wrong', files: ['calc.py'] })],
    patch: [call('apply_patch', { patch: breakAdd }), { content: 'done' }, call('apply_patch', { patch: fixAdd })],
  });
  const report = await fixIssue({ ...options(root, provider), bus });
  assert.equal(report.status, 'fixed', report.summary);
  assert.deepEqual(report.rounds[0].regressions, ['tests/test_calc.py::test_add (failed)']);
  assert.deepEqual(report.rounds[1].regressions, []);
  assert.match(promptsFor(provider, 'locate')[1], /regression: tests\/test_calc\.py::test_add \(failed\)/);

  // trace has one node event pair per node per round
  const count = (node: string) => ({ enter: events.filter((e) => e === `${node}:enter`).length, exit: events.filter((e) => e === `${node}:exit`).length });
  for (const [node, n] of Object.entries({ baseline: 1, reproduce: 1, locate: 2, patch: 2, verify: 2, keep: 1, report: 1 })) {
    assert.deepEqual(count(node), { enter: n, exit: n }, node);
  }
});

test('a timed-out or unfinished full suite is never reported as fixed', async (t) => {
  for (const full of [(r: TestRun) => ({ ...r, timedOut: true, complete: false, exitCode: null }), (r: TestRun) => ({ ...r, errors: ['tests/test_other.py'], exitCode: 2 })]) {
    const root = workspace(t);
    const provider = scripted({
      reproduce: reproduceScript(),
      locate: [call('submit_hypothesis', { hypothesis: 'h', files: ['calc.py'] })],
      patch: [call('apply_patch', { patch: FIX_PATCH })],
    });
    let n = 0;
    // The baseline run is normal; every later full run is broken.
    const runner = fakeRunner({ full: (r) => (n++ === 0 ? r : full(r)) });
    const report = await fixIssue(options(root, provider, { runTests: runner, maxRounds: 1 }));
    assert.equal(report.status, 'failed');
    assert.ok(report.rounds[0].regressions.some((r) => r.startsWith('<run>')), JSON.stringify(report.rounds[0]));
  }
});

test('patch failures are capped at 3 per round', async (t) => {
  const root = workspace(t);
  const bad = '--- a/calc.py\n+++ b/calc.py\n@@ -1 +1 @@\n-nothing like this\n+x\n';
  const provider = scripted({
    reproduce: reproduceScript(),
    locate: [call('submit_hypothesis', { hypothesis: 'h', files: ['calc.py'] })],
    patch: [1, 2, 3, 4].map(() => call('apply_patch', { patch: bad })),
  });
  const report = await fixIssue(options(root, provider, { maxRounds: 1 }));
  assert.equal(report.status, 'failed');
  assert.equal(report.rounds[0].patchApplied, false);
  const conflicts = promptsFor(provider, 'patch').at(-1)!.match(/does not apply/g) ?? [];
  assert.equal(conflicts.length, 3, 'the 4th patch must not be attempted');
  assert.match(report.summary, /no patch applied/);
});

test('a patch that weakens an existing test is refused and reported', async (t) => {
  const root = workspace(t);
  const weaken = '--- a/tests/test_calc.py\n+++ b/tests/test_calc.py\n@@ -3,2 +3,2 @@\n def test_add():\n-    assert add(2, 3) == 5\n+    assert True\n';
  const provider = scripted({
    reproduce: reproduceScript(),
    locate: [call('submit_hypothesis', { hypothesis: 'the test is wrong', files: ['tests/test_calc.py'] })],
    patch: [call('apply_patch', { patch: weaken }), { content: 'gave up' }],
  });
  const report = await fixIssue(options(root, provider, { maxRounds: 1 }));
  assert.equal(report.status, 'failed');
  assert.match(report.summary, /tried to change an existing test and was refused/);
  assert.match(fs.readFileSync(path.join(root, 'tests/test_calc.py'), 'utf8'), /assert add\(2, 3\) == 5/);
});

test('the token budget covers every model call and stops the workflow', async (t) => {
  const root = workspace(t);
  const provider = scripted({
    reproduce: [{ ...call('apply_patch', { patch: REPRO_PATCH }), usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 } }, call('submit_repro', { targetTests: ['tests/test_repro.py::test_sub'] })],
  });
  const report = await fixIssue(options(root, provider, { budgetTokens: 500 }));
  assert.equal(report.status, 'failed');
  assert.match(report.summary, /token budget of 500 exhausted/);
  assert.equal(provider.callHistory.length, 1, 'no model call after the budget is spent');
});

test('the time limit stops the workflow', async (t) => {
  const root = workspace(t);
  const provider = scripted({ reproduce: reproduceScript() });
  const report = await fixIssue(options(root, provider, { timeLimitMs: 30, runTests: fakeRunner({ delayMs: 80 }) }));
  assert.equal(report.status, 'failed');
  assert.match(report.summary, /time limit/);
});

test('a diff over 3 files carries an explanation', async (t) => {
  const root = workspace(t);
  const extra = [1, 2, 3].map((n) => `--- /dev/null\n+++ b/extra_${n}.py\n@@ -0,0 +1 @@\n+X = ${n}\n`).join('');
  const provider = scripted({
    reproduce: reproduceScript(),
    locate: [call('submit_hypothesis', { hypothesis: 'h', files: ['calc.py'] })],
    patch: [call('apply_patch', { patch: FIX_PATCH + extra }), { content: 'done' }],
    report: [{ content: 'The constants had to move into their own modules.' }],
  });
  const report = await fixIssue(options(root, provider));
  assert.equal(report.status, 'fixed');
  assert.equal(report.diffStat.files, 5);
  assert.equal(report.explanation, 'The constants had to move into their own modules.');
  assert.match(formatFixReport(report), /Why this many changes:/);
});

test('answering no to keep says the files were not restored, yes keeps them', async (t) => {
  for (const keep of [false, true]) {
    const root = workspace(t);
    const provider = scripted({
      reproduce: reproduceScript(),
      locate: [call('submit_hypothesis', { hypothesis: 'h', files: ['calc.py'] })],
      patch: [call('apply_patch', { patch: FIX_PATCH })],
    });
    const asked: string[] = [];
    const ui = { print() {}, async ask() { return ''; }, async confirm(q: string) { asked.push(q); return keep; } };
    const report = await fixIssue(options(root, provider, { ui }));
    assert.deepEqual(asked, ['Giữ bản sửa?']);
    assert.equal(report.status, 'fixed');
    // Rollback is D2's (#25); until then the report must not claim one.
    assert.equal(/rollback is not available yet/.test(report.summary), !keep);
    assert.match(fs.readFileSync(path.join(root, 'calc.py'), 'utf8'), /return a - b/);
  }
});

test('cancelling returns an aborted report', async (t) => {
  const root = workspace(t);
  const controller = new AbortController();
  const provider = scripted({ reproduce: reproduceScript() });
  provider.setHandler(async () => {
    controller.abort();
    return { content: 'thinking' };
  });
  const report = await fixIssue(options(root, provider, { signal: controller.signal }));
  assert.equal(report.status, 'aborted');
});

test('/fix reads issue.md from an issue directory, otherwise takes the text', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-fix-issue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'issue.md'), '# subtract adds\n');
  assert.equal(readIssueArg(dir, os.tmpdir()), '# subtract adds\n');
  assert.equal(readIssueArg('sub(5, 3) returns 8', os.tmpdir()), 'sub(5, 3) returns 8');
  fs.mkdirSync(path.join(dir, 'empty'));
  assert.throws(() => readIssueArg(path.join(dir, 'empty'), os.tmpdir()), /no issue\.md/);
});

const hasPytest = spawnSync(pythonBin(), ['-m', 'pytest', '--version'], { windowsHide: true }).status === 0;
const canSandbox = process.platform === 'linux' && isBwrapUsable() && hasPytest;

test('fixes seeded bug-01 with the real sandboxed verifier', { skip: !canSandbox && process.env.CI !== 'true' && 'needs Linux + usable bwrap + python with pytest' }, async (t) => {
  assert.ok(canSandbox, 'CI must run the real verifier');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-fix-bug01-'));
  fs.rmSync(root, { recursive: true });
  seed('bug-01', root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repro = '--- /dev/null\n+++ b/tests/test_repro_subtract.py\n@@ -0,0 +1,9 @@\n+from tinydb import TinyDB, where\n+from tinydb.operations import subtract\n+from tinydb.storages import MemoryStorage\n+\n+\n+def test_subtract_lowers_the_value():\n+    db = TinyDB(storage=MemoryStorage)\n+    db.insert({"stock": 10})\n+    db.update(subtract("stock", 3), where("stock") == 10); assert db.all() == [{"stock": 7}]\n';
  const fix = '--- a/tinydb/operations.py\n+++ b/tinydb/operations.py\n@@ -40,2 +40,2 @@\n     def transform(doc: MutableMapping):\n-        doc[field] += n\n+        doc[field] -= n\n';
  const provider = scripted({
    reproduce: [call('apply_patch', { patch: repro }), call('submit_repro', { targetTests: ['tests/test_repro_subtract.py'] })],
    locate: [call('submit_hypothesis', { hypothesis: 'subtract() in tinydb/operations.py adds n.', files: ['tinydb/operations.py'] })],
    patch: [call('apply_patch', { patch: fix }), { content: 'subtract now subtracts.' }],
  });
  const { runTests: _fake, ...real } = options(root, provider);
  const report = await fixIssue({ ...real, issue: fs.readFileSync(path.join(ISSUES_DIR, 'bug-01', 'issue.md'), 'utf8') });
  assert.equal(report.status, 'fixed', report.summary);
  assert.equal(report.rounds.length, 1);
  assert.ok(report.rounds[0].testsPassed > 200, `passed ${report.rounds[0].testsPassed}`);
  assert.deepEqual(report.rounds[0].regressions, []);
});
