// tests/eval-uc03.test.ts - UC-03 eval runner: grading, hidden-test isolation, gate, missing sandbox
//
// The real verifier needs Linux + bwrap; these tests drive the runner through its test seam with a fake test
// runner that decides each test from the workspace source, so they run everywhere.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UC_RUNNERS } from '../evals/registry.js';
import { listBugs } from '../evals/issues/bugs.js';
import { mockBug01Provider, passesUc03, protectTests, runUc03, runUc03Cases, summarizeUc03 } from '../evals/uc03/run.js';
import type { UcCaseResult } from '../evals/types.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { TestRun } from '../src/core/verifier.js';
import type { ChatParams } from '../src/llm/base-provider.js';
import { MockProvider, type MockResponse } from '../src/llm/providers/mock.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-eval-uc03-'));
const previousHome = process.env.AXIOM_HOME;
process.env.AXIOM_HOME = path.join(scratch, 'home');
after(() => {
  if (previousHome === undefined) delete process.env.AXIOM_HOME;
  else process.env.AXIOM_HOME = previousHome;
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Windows: the fix workflow's SQLite checkpointer keeps checkpoints.db open until exit (EPERM); temp dir only.
  }
});

let runs = 0;
const workDir = () => fs.mkdtempSync(path.join(scratch, `run-${runs++}-`));
const call = (name: string, args: Record<string, unknown>): MockResponse => ({ toolCalls: [{ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }] });

/** Decides tests from tinydb/operations.py the way pytest would for bug-01; records the targets it ran. */
function fakeRunner() {
  const targets: string[] = [];
  const runner = async (root: string, opts?: { target?: string }): Promise<TestRun> => {
    targets.push(opts?.target ?? '<all>');
    const ops = fs.readFileSync(path.join(root, 'tinydb/operations.py'), 'utf8');
    const subtractFixed = ops.includes('doc[field] -= n');
    const results: Array<[string, boolean]> = [
      ['tests/test_tinydb.py::test_all', true],
      ['tests/test_operations.py::test_increment', ops.includes('doc[field] += 1\n')],
      ['tests/test_operations.py::test_subtract', subtractFixed],
    ];
    if (fs.existsSync(path.join(root, 'tests/test_repro_subtract.py'))) results.push(['tests/test_repro_subtract.py::test_subtract_lowers_the_value', subtractFixed]);
    if (fs.existsSync(path.join(root, 'tests/test_hidden_bug_01.py'))) results.push(['tests/test_hidden_bug_01.py::test_hidden', subtractFixed]);
    const picked = results.filter(([id]) => !opts?.target || id.startsWith(opts.target));
    return {
      passed: picked.filter(([, ok]) => ok).map(([id]) => id),
      failed: picked.filter(([, ok]) => !ok).map(([id]) => id),
      skipped: [], errors: [], timedOut: false, complete: true, output: '', exitCode: picked.every(([, ok]) => ok) ? 0 : 1,
    };
  };
  return Object.assign(runner, { targets });
}

function scripted(script: Record<string, MockResponse[]>): MockProvider {
  const provider = new MockProvider('mock');
  provider.callLimit = 100;
  provider.setHandler((params: ChatParams) => {
    const system = params.messages.find((m) => m.role === 'system')?.content ?? '';
    return script[/Axiom \/fix, step: (\w+)/.exec(system)?.[1] ?? '']?.shift() ?? { content: 'done' };
  });
  return provider;
}

const FIX = '--- a/tinydb/operations.py\n+++ b/tinydb/operations.py\n@@ -40,2 +40,2 @@\n     def transform(doc: MutableMapping):\n-        doc[field] += n\n+        doc[field] -= n\n';
const BREAK_INCREMENT = '--- a/tinydb/operations.py\n+++ b/tinydb/operations.py\n@@ -60,2 +60,2 @@\n     def transform(doc: MutableMapping):\n-        doc[field] += 1\n+        doc[field] += 2\n';
const DROP_ASSERT = "--- a/tests/test_operations.py\n+++ b/tests/test_operations.py\n@@ -20,3 +20,2 @@\n def test_subtract(db):\n     db.update(subtract('int', 5), where('char') == 'a')\n-    assert db.get(where('char') == 'a')['int'] == -4\n";
const REPRO = { submit: call('submit_repro', { targetTests: ['tests/test_operations.py::test_subtract'] }) };

test('registry runs UC-03 through runUc03', () => {
  assert.equal(UC_RUNNERS['03'], runUc03);
});

test('without the bwrap sandbox UC-03 reports it cannot measure, never a result', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('unexpected network call');
  });
  const previous = { sandbox: process.env.AXIOM_SANDBOX, local: process.env.AXIOM_ALLOW_LOCAL_TESTS };
  process.env.AXIOM_SANDBOX = 'off';
  try {
    // ci-local.sh exports AXIOM_ALLOW_LOCAL_TESTS=1 on Windows; without it neither mode may run.
    delete process.env.AXIOM_ALLOW_LOCAL_TESTS;
    for (const mock of [true, false]) {
      const dir = workDir();
      await assert.rejects(runUc03({ mock, config: DEFAULT_CONFIG, workDir: dir }), /cannot measure without the bwrap sandbox/);
      assert.deepEqual(fs.readdirSync(dir), [], 'no bug was seeded or run');
    }
    // The local-tests escape is for the dev smoke: a real run still refuses to execute model code unsandboxed.
    process.env.AXIOM_ALLOW_LOCAL_TESTS = '1';
    const dir = workDir();
    await assert.rejects(runUc03({ mock: false, config: DEFAULT_CONFIG, workDir: dir }), /cannot measure without the bwrap sandbox/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    for (const [key, value] of [['AXIOM_SANDBOX', previous.sandbox], ['AXIOM_ALLOW_LOCAL_TESTS', previous.local]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('mock bug-01 is fixed and graded by the hidden test, which the agent never sees', async () => {
  const runner = fakeRunner();
  const seen: string[][] = [];
  const dir = workDir();
  const result = await runUc03Cases(['bug-01'], {
    workDir: dir,
    createProvider: async () => ({ provider: mockBug01Provider(), model: 'mock-code' }),
    runTests: runner,
    onAgentStart: (_id, root) => seen.push(fs.readdirSync(path.join(root, 'tests'))),
  });
  const [c] = result.cases;
  assert.equal(c.error, undefined);
  assert.deepEqual(c.metrics, {
    fixed: true, regressions: 0, rounds: 1, tampered: false, testsEdited: 0,
    hiddenPassed: true, hiddenTimedOut: false, statusFixed: true, filesChanged: 2,
  });
  assert.equal(c.passed, true);
  assert.ok(seen[0].every((f) => !f.startsWith('test_hidden')), `agent saw ${seen[0].join(', ')}`);
  assert.ok(runner.targets.includes('tests/test_hidden_bug_01.py'), 'grader ran the hidden test');
  assert.equal(runner.targets.at(-1), '<all>', 'full suite runs after the hidden test');
  assert.ok(!fs.existsSync(path.join(dir, 'bug-01', 'tests/test_hidden_bug_01.py')));
  assert.deepEqual(result.summary, { fixRate: 1, regressionRate: 0, avgRounds: 1 });
  assert.equal(passesUc03(result, true, ['bug-01']), true);
});

test('a fix that breaks another test counts as a regression and fails the case and the gate', async () => {
  const result = await runUc03Cases(['bug-01'], {
    workDir: workDir(),
    createProvider: async () => ({
      provider: scripted({
        reproduce: [REPRO.submit],
        locate: [call('submit_hypothesis', { hypothesis: 'subtract adds', files: ['tinydb/operations.py'] })],
        patch: [call('apply_patch', { patch: FIX }), call('apply_patch', { patch: BREAK_INCREMENT })],
      }),
      model: 'mock-code',
    }),
    runTests: fakeRunner(),
  });
  const [c] = result.cases;
  assert.equal(c.metrics.hiddenPassed, true);
  assert.equal(c.metrics.regressions, 1);
  assert.equal(c.passed, false);
  assert.equal(passesUc03(result, true, ['bug-01']), false);
});

test('a patch the test guard refuses is recorded as tampered', async () => {
  const result = await runUc03Cases(['bug-01'], {
    workDir: workDir(),
    createProvider: async () => ({
      provider: scripted({
        reproduce: [REPRO.submit],
        locate: [call('submit_hypothesis', { hypothesis: 'the test is wrong', files: ['tests/test_operations.py'] })],
        patch: [call('apply_patch', { patch: DROP_ASSERT })],
      }),
      model: 'mock-code',
    }),
    runTests: fakeRunner(),
  });
  const [c] = result.cases;
  assert.equal(c.metrics.tampered, true);
  assert.equal(c.metrics.testsEdited, 0, 'the guard kept the test file intact');
  assert.equal(c.metrics.fixed, false);
});

test('unfixable bug-10 counts as fixed when /fix stops without touching existing tests', async () => {
  const result = await runUc03Cases(['bug-10'], {
    workDir: workDir(),
    createProvider: async () => ({ provider: scripted({ reproduce: [{ content: 'The issue contradicts test_gt; I will not change the tests.' }] }), model: 'mock-code' }),
    runTests: async () => ({ passed: ['tests/test_queries.py::test_eq'], failed: ['tests/test_queries.py::test_gt'], skipped: [], errors: [], timedOut: false, complete: true, output: '', exitCode: 1 }),
  });
  const [c] = result.cases;
  assert.equal(c.metrics.statusFixed, false);
  assert.equal(c.metrics.fixed, true);
  assert.equal(c.metrics.regressions, 0);
  assert.equal(c.passed, true);
});

test('protectTests reports edited and deleted existing tests, allows new ones, and restores the originals', () => {
  const root = workDir();
  fs.mkdirSync(path.join(root, 'tests'));
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.writeFileSync(path.join(root, 'tests/test_a.py'), 'def test_a():\n    assert 1\n');
  fs.writeFileSync(path.join(root, 'tests/conftest.py'), '');
  fs.writeFileSync(path.join(root, 'pytest.ini'), '[pytest]\n');
  fs.writeFileSync(path.join(root, 'pkg/code.py'), 'x = 1\n');
  const guard = protectTests(root);
  fs.writeFileSync(path.join(root, 'tests/test_a.py'), 'def test_a():\n    pass\n');
  fs.rmSync(path.join(root, 'tests/conftest.py'));
  fs.writeFileSync(path.join(root, 'tests/test_new.py'), 'def test_new():\n    assert 1\n');
  fs.writeFileSync(path.join(root, 'pkg/code.py'), 'x = 2\n');
  assert.deepEqual(guard.changed(), ['tests/conftest.py', 'tests/test_a.py']);
  guard.restore();
  assert.deepEqual(guard.changed(), []);
  assert.equal(fs.readFileSync(path.join(root, 'tests/test_a.py'), 'utf8'), 'def test_a():\n    assert 1\n');
  assert.ok(fs.existsSync(path.join(root, 'tests/test_new.py')), 'new tests are left alone');
  assert.equal(fs.readFileSync(path.join(root, 'pkg/code.py'), 'utf8'), 'x = 2\n', 'source is not restored');
});

test('a case whose test run crashes has no measurement and fails the gate', async () => {
  const result = await runUc03Cases(['bug-01'], {
    workDir: workDir(),
    createProvider: async () => ({ provider: mockBug01Provider(), model: 'mock-code' }),
    runTests: async () => {
      throw new Error('run_tests needs the bwrap sandbox');
    },
  });
  const [c] = result.cases;
  assert.match(c.error ?? '', /bug-01: run_tests needs the bwrap sandbox/);
  assert.equal(c.metrics.regressions, null);
  assert.equal(c.passed, false);
  assert.equal(result.summary.regressionRate, 1);
  assert.equal(passesUc03(result, true, ['bug-01']), false);
});

test('the gate needs every bug, fixRate >= 0.4 and zero regressions on every bug', () => {
  const ids = listBugs();
  assert.equal(ids.length, 10);
  const cases = (fixed: number, regressions: (i: number) => number | null = () => 0): UcCaseResult[] =>
    ids.map((id, i) => ({ id, passed: i < fixed, metrics: { fixed: i < fixed, regressions: regressions(i), rounds: 1 }, tokens: 0, costDollars: 0, latencyMs: 0 }));
  const result = (c: UcCaseResult[]) => ({ uc: '03', cases: c, summary: summarizeUc03(c) });
  assert.equal(passesUc03(result(cases(4)), false, ids), true);
  assert.equal(passesUc03(result(cases(3)), false, ids), false);
  assert.equal(passesUc03(result(cases(10, (i) => (i === 9 ? 1 : 0))), false, ids), false);
  assert.equal(passesUc03(result(cases(10, (i) => (i === 9 ? null : 0))), false, ids), false);
  assert.equal(passesUc03(result(cases(10).slice(1)), false, ids), false);
  assert.deepEqual(summarizeUc03(cases(4)), { fixRate: 0.4, regressionRate: 0, avgRounds: 1 });
});
