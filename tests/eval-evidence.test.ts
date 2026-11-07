// tests/eval-evidence.test.ts - Kiểm bằng chứng release bằng runner giả, không gọi model hay mạng thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseEvidenceErrors, type EvidencedUcResult } from '../evals/evidence.js';
import { runEvaluation } from '../evals/run.js';
import { parseArgs } from '../evals/args.js';
import { loadCases, UC01_CASES_DIR } from '../evals/uc01/cases.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

function result(uc = '02'): EvidencedUcResult {
  const ids = uc === '01' ? loadCases(UC01_CASES_DIR).map(c => c.id) : ['first', 'second'];
  return { uc, expectedCaseIds: ids, gates: [{ id: `${uc}-acceptance`, passed: true }], summary: {},
    cases: ids.map(id => ({ id, passed: true, tokens: 7, costDollars: 0.001, latencyMs: 1,
      metrics: { schemaValid: true, typeCorrect: true, routeCorrect: true, unexpectedToolCalls: 0 },
      provenance: { mock: false, models: [{ provider: 'test-provider', model: 'test-model', role: 'smol' }] } })) };
}

test('complete real evidence has no blockers', () => {
  assert.deepEqual(releaseEvidenceErrors(result(), false), []);
});

const mutations: Array<[string, (r: EvidencedUcResult) => void]> = [
  ['failed gate', r => { r.gates[0].passed = false; }],
  ['missing gates', r => { r.gates = []; }],
  ['duplicate gates', r => { r.gates.push(r.gates[0]); }],
  ['missing expected case', r => { r.cases.pop(); }],
  ['unexpected case', r => { r.cases[0].id = 'unexpected'; }],
  ['duplicate cases', r => { r.cases[1].id = r.cases[0].id; }],
  ['duplicate expected ids', r => { r.expectedCaseIds.push(r.expectedCaseIds[0]); }],
  ['skipped case', r => { r.cases[0].skipped = 'not run'; }],
  ['mock disguised as real', r => { r.cases[0].provenance.mock = true; }],
  ['missing model provenance', r => { r.cases[0].provenance.models = []; }],
];
for (const [name, mutate] of mutations) {
  test(`release rejects ${name}`, () => {
    const r = result(); mutate(r);
    assert.ok(releaseEvidenceErrors(r, false).length > 0);
  });
}

test('full release requires every UC and persists the evidence used for its decision', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-release-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runners = Object.fromEntries(['01', '02', '03', '04', '05'].map(uc => [uc, async () => result(uc)]));
  const opts = { config: DEFAULT_CONFIG, runners, workDir: path.join(root, 'work'), outputFile: path.join(root, 'result.json') };
  const report = await runEvaluation(parseArgs(['--all']), opts);
  assert.equal(report.passed, true);
  assert.equal(report.releaseEligible, true);
  assert.deepEqual(report.releaseBlockers, []);
  const artifact = JSON.parse(fs.readFileSync(opts.outputFile, 'utf8'));
  assert.equal(artifact.ucs[0].cases[0].provenance.mock, false);
  assert.deepEqual(artifact.ucs[0].expectedCaseIds, result('01').expectedCaseIds);
  assert.deepEqual(artifact.ucs[0].gates, result('01').gates);
  // Đây chỉ là test logic bằng fake: không dùng artifact tạm này làm bằng chứng eval thật.
  runners['02'] = async () => { const r = result(); r.gates[0].passed = false; return r; };
  const failed = await runEvaluation(parseArgs(['--all']), opts);
  assert.equal(failed.passed, false);
  assert.equal(failed.releaseEligible, false);
  assert.match(failed.errors.join('\n'), /gate/);
});

for (const uc of ['03', '04']) {
  test(`UC-${uc} uses evidenced acceptance gates instead of requiring every case to pass`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-release-threshold-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // Một case không đạt mục tiêu không đồng nghĩa workflow lỗi; chủ UC chấm ngưỡng qua gate.
    const runners = Object.fromEntries(['01', '02', '03', '04', '05'].map(id => [id, async () => {
      const r = result(id);
      if (id === uc) r.cases[0].passed = false;
      return r;
    }]));
    const opts = { config: DEFAULT_CONFIG, runners, workDir: path.join(root, 'work'), outputFile: path.join(root, 'result.json') };
    const report = await runEvaluation(parseArgs(['--all']), opts);
    assert.equal(report.passed, true, report.errors.join('\n'));
    assert.equal(report.releaseEligible, true);
    assert.equal(report.ucs.find(r => r.uc === uc)!.cases[0].passed, false);

    // Gate không được che lỗi thực thi hoặc usage đã mất vì provider thất bại.
    runners[uc] = async () => { const r = result(uc); r.cases[0].error = 'provider failed'; return r; };
    const failed = await runEvaluation(parseArgs(['--all']), opts);
    assert.equal(failed.passed, false);
    assert.equal(failed.releaseEligible, false);
  });
}

test('UC-05 accepts scripted model provenance (mock: true) in full real release', () => {
  const r = result('05');
  r.cases.forEach((c) => {
    c.provenance = { mock: true, models: [{ provider: 'mock', model: 'scripted-eval', role: 'code' }] };
  });
  assert.deepEqual(releaseEvidenceErrors(r, false), []);
});

test('full release with UC-05 scripted model passes release evaluation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-release-uc05-scripted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runners = Object.fromEntries(
    ['01', '02', '03', '04', '05'].map((uc) => [
      uc,
      async () => {
        const r = result(uc);
        if (uc === '05') {
          r.cases.forEach((c) => {
            c.provenance = { mock: true, models: [{ provider: 'mock', model: 'scripted-eval', role: 'code' }] };
          });
        }
        return r;
      },
    ])
  );
  const opts = { config: DEFAULT_CONFIG, runners, workDir: path.join(root, 'work'), outputFile: path.join(root, 'result.json') };
  const report = await runEvaluation(parseArgs(['--all']), opts);
  assert.equal(report.passed, true);
  assert.equal(report.releaseEligible, true);
  assert.deepEqual(report.releaseBlockers, []);
});

test('declared incomplete evidence also fails selected partial development runs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-release-partial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = await runEvaluation(parseArgs(['--uc', '02', '--partial']), {
    config: DEFAULT_CONFIG, runners: { '02': async () => { const r = result(); r.cases.pop(); return r; } },
    workDir: path.join(root, 'work'), outputFile: path.join(root, 'result.json'),
  });
  assert.equal(report.passed, false);
  assert.equal(report.releaseEligible, false);
});
