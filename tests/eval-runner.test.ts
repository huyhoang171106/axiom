// tests/eval-runner.test.ts - Kiểm điều phối nhiều UC, artifact và lỗi mà không cần API key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../evals/args.js';
import { runEvaluation } from '../evals/run.js';
import { loadCases, UC01_CASES_DIR } from '../evals/uc01/cases.js';
import type { UcResult, UcRunner } from '../evals/types.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { scrubEnv, registerSecret } from '../src/core/secrets.js';
import { loadCatalog } from '../src/llm/catalog/index.js';

function fixtureResult(uc: string): UcResult {
  const ids = uc === '01' ? loadCases(UC01_CASES_DIR).map(c => c.id) : ['first', 'second'];
  return { uc, cases: ids.map((id, i) => ({ id, passed: true,
    metrics: { schemaValid: true, typeCorrect: true, routeCorrect: true, unexpectedToolCalls: 0 },
    tokens: 10 * (i + 1), costDollars: (i + 1) / 1000, latencyMs: 5 * (i + 1) })), summary: {} };
}
function environment(t: { after: (fn: () => void) => void }, runners: Record<string, UcRunner>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-eval-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, opts: { runners, config: DEFAULT_CONFIG, workDir: path.join(root, 'work'), outputFile: path.join(root, 'evals', 'results.json') } };
}

test('parseArgs selects repeated UCs once and keeps explicit mock/partial modes', () => {
  assert.deepEqual(parseArgs(['--uc', '02', '--uc', '01', '--uc', '02', '--mock']),
    { ucs: ['02', '01'], all: false, mock: true, partial: false });
  assert.deepEqual(parseArgs(['--all', '--mock', '--partial']), { ucs: [], all: true, mock: true, partial: true });
});

for (const argv of [[], ['--mock'], ['--uc'], ['--uc', '1'], ['--uc', '--all'], ['--ucfoo'], ['--all', '--uc', '01'], ['--all', '--typo']]) {
  test(`parseArgs rejects absent, ambiguous or malformed selection: ${JSON.stringify(argv)}`, () => {
    assert.throws(() => parseArgs(argv));
  });
}

test('selected runners receive distinct work directories and produce recomputed averages', async t => {
  const received: string[] = [];
  const runners = Object.fromEntries(['02', '03'].map(uc => [uc, async (opts: Parameters<UcRunner>[0]) => {
    assert.equal(opts.mock, true); assert.equal(opts.config, DEFAULT_CONFIG);
    assert.ok(fs.statSync(opts.workDir).isDirectory()); received.push(opts.workDir);
    return { ...fixtureResult(uc), summary: { avgTokens: 9999 } };
  }]));
  const { opts } = environment(t, runners);
  const report = await runEvaluation(parseArgs(['--uc', '02', '--uc', '03', '--mock']), opts);
  assert.deepEqual(report.ucs.map(uc => uc.uc), ['02', '03']);
  assert.equal(new Set(received).size, 2);
  for (const uc of report.ucs) {
    assert.equal(uc.summary.avgTokens, 15);
    assert.equal(uc.summary.avgCostDollars, 0.0015);
    assert.equal(uc.summary.avgLatencyMs, 7.5);
  }
  const artifact = JSON.parse(fs.readFileSync(opts.outputFile, 'utf8'));
  assert.equal(artifact.mock, true); assert.equal(artifact.scope, 'selected');
  assert.equal(artifact.releaseEligible, false);
  assert.equal(artifact.passed, true);
  assert.ok(Number.isFinite(Date.parse(artifact.runAt)));
});

test('--all runs registered UCs and fails missing mandatory UCs without --partial', async t => {
  const { opts } = environment(t, { '01': async () => fixtureResult('01') });
  const report = await runEvaluation(parseArgs(['--all', '--mock']), opts);
  assert.deepEqual(report.requestedUcs, ['01', '02', '03', '04', '05']);
  assert.deepEqual(report.missingUcs, ['02', '03', '04', '05']);
  assert.equal(report.passed, false);
  assert.equal(report.ucs.length, 1);
  const partial = await runEvaluation(parseArgs(['--all', '--mock', '--partial']), opts);
  assert.equal(partial.passed, true); assert.equal(partial.releaseEligible, false);
  assert.deepEqual(partial.missingUcs, ['02', '03', '04', '05']);
});

test('--all includes additional registered UCs without inventing fake runners', async t => {
  const ids = ['01', '02', '03', '04', '05', '11'];
  const calls: string[] = [];
  const { opts } = environment(t, Object.fromEntries(ids.map(uc => [uc, async () => { calls.push(uc); return fixtureResult(uc); }])));
  const report = await runEvaluation(parseArgs(['--all', '--mock']), opts);
  assert.deepEqual(calls, ids); assert.deepEqual(report.missingUcs, []);
  assert.equal(report.passed, true); assert.equal(report.releaseEligible, false);
});

for (const kind of ['zero', 'wrong-uc', 'duplicate', 'error', 'non-finite', 'failed'] as const) {
  test(`runner ${kind} is a failure, including in partial development mode`, async t => {
    const { opts } = environment(t, { '02': async () => {
      const result = fixtureResult('02');
      if (kind === 'zero') result.cases = [];
      if (kind === 'wrong-uc') result.uc = '03';
      if (kind === 'duplicate') result.cases[1].id = result.cases[0].id;
      if (kind === 'error') result.cases[0].error = 'workflow failed';
      if (kind === 'non-finite') result.cases[0].tokens = Number.NaN;
      if (kind === 'failed') result.cases[0].passed = false;
      return result;
    } });
    const report = await runEvaluation(parseArgs(['--uc', '02', '--mock', '--partial']), opts);
    assert.equal(report.passed, false); assert.ok(report.errors.length > 0);
    assert.equal(report.releaseEligible, false);
    if (kind === 'error') {
      assert.equal(report.ucs[0].cases[0].tokens, 10);
      assert.equal(report.ucs[0].summary.avgTokens, 15);
    }
  });
}

test('partial mode with no available runners still fails', async t => {
  const { opts } = environment(t, {});
  const report = await runEvaluation(parseArgs(['--all', '--mock', '--partial']), opts);
  assert.equal(report.passed, false);
  assert.match(report.errors.join('\n'), /No UC results/);
});

test('case error text is redacted without losing spent usage', async t => {
  const sensitive = `case-fake-${process.pid}-${Date.now()}`;
  registerSecret(sensitive);
  const { opts } = environment(t, { '02': async () => {
    const result = fixtureResult('02');
    result.cases[0].error = `failed after usage ${sensitive}`;
    return result;
  } });
  const report = await runEvaluation(parseArgs(['--uc', '02', '--mock']), opts);
  assert.equal(report.passed, false);
  assert.equal(report.ucs[0].cases[0].tokens, 10);
  assert.equal(report.ucs[0].cases[0].error!.includes(sensitive), false);
  assert.equal(fs.readFileSync(opts.outputFile, 'utf8').includes(sensitive), false);
});

test('runner rejection is redacted in the artifact and does not erase other UC results', async t => {
  const sensitive = `eval-fake-${process.pid}-${Date.now()}`;
  registerSecret(sensitive);
  const { opts } = environment(t, { '02': async () => { throw new Error(`provider unavailable ${sensitive}`); },
    '03': async () => fixtureResult('03') });
  const report = await runEvaluation(parseArgs(['--uc', '02', '--uc', '03']), opts);
  assert.equal(report.passed, false);
  assert.deepEqual(report.ucs.map(uc => uc.uc), ['03']);
  assert.equal(fs.readFileSync(opts.outputFile, 'utf8').includes(sensitive), false);
  assert.match(report.errors[0], /provider unavailable/);
});

for (const kind of ['threshold', 'injection', 'missing-case'] as const) {
  test(`UC-01 ${kind} gate cannot be bypassed with a passing summary`, async t => {
    const { opts } = environment(t, { '01': async () => {
      const result = fixtureResult('01');
      result.summary = { schemaValidRate: 1, typeAccuracy: 1 };
      if (kind === 'threshold') for (const c of result.cases.slice(0, 3)) c.metrics.typeCorrect = false;
      if (kind === 'injection') result.cases.at(-1)!.metrics.unexpectedToolCalls = 1;
      if (kind === 'missing-case') result.cases.pop();
      return result;
    } });
    const report = await runEvaluation(parseArgs(['--uc', '01']), opts);
    assert.equal(report.passed, false);
  });
}

test('full real release fails closed until shared acceptance/provenance validation exists', async t => {
  const ids = ['01', '02', '03', '04', '05'];
  const { opts } = environment(t, Object.fromEntries(ids.map(uc => [uc, async () => fixtureResult(uc)])));
  const report = await runEvaluation(parseArgs(['--all']), opts);
  assert.equal(report.releaseEligible, false);
  assert.equal(report.passed, false);
  assert.match(report.errors.join('\n'), /release.*contract|contract.*release/i);
});

test('entry point writes an explicit mock artifact without accessing real credentials', t => {
  const { root } = environment(t, {});
  const script = fileURLToPath(new URL('../evals/run.ts', import.meta.url));
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), script, '--uc', '01', '--mock'], {
    cwd: root, encoding: 'utf8', env: { ...scrubEnv(process.env), AXIOM_HOME: path.join(root, 'home'), AXIOM_CONFIG_PATH: path.join(root, 'config.json') },
    timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr);
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'evals', 'results.json'), 'utf8'));
  assert.equal(artifact.mock, true); assert.equal(artifact.ucs[0].cases.length, 10);
  assert.equal(artifact.releaseEligible, false);
  assert.match(child.stdout, /mock|smoke/i);
});

test('real entry point with missing credentials fails instead of silently using mock', t => {
  const { root } = environment(t, {});
  const model = loadCatalog().models('anthropic')[0];
  assert.ok(model);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, providers: {},
    modelRoles: { smol: `${model.provider}/${model.id}` } }));
  const script = fileURLToPath(new URL('../evals/run.ts', import.meta.url));
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), script, '--uc', '01'], {
    cwd: root, encoding: 'utf8', env: { ...scrubEnv(process.env), AXIOM_HOME: path.join(root, 'home'), AXIOM_CONFIG_PATH: path.join(root, 'config.json') },
    timeout: 30000,
  });
  assert.equal(child.status, 1, child.stderr);
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'evals', 'results.json'), 'utf8'));
  assert.equal(artifact.mock, false); assert.equal(artifact.passed, false);
  assert.equal(artifact.ucs.length, 0);
  assert.match(artifact.errors.join('\n'), /provider|login/i);
});
