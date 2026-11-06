// tests/eval-uc04.test.ts - Unit tests for UC-04 runner, evidence contracts, and cases
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runUc04, passesUc04 } from '../evals/uc04/run.js';
import { UC_RUNNERS } from '../evals/registry.js';
import { loadFeatureCase, UC04_CASE_IDS } from '../evals/uc04/cases.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { loadCatalog } from '../src/llm/catalog/index.js';
import { evidenceSchema, provenanceSchema, releaseEvidenceErrors } from '../evals/evidence.js';
import type { UcResult } from '../evals/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-eval-uc04-'));
const previousHome = process.env.AXIOM_HOME;
process.env.AXIOM_HOME = root;

after(() => {
  if (previousHome === undefined) delete process.env.AXIOM_HOME;
  else process.env.AXIOM_HOME = previousHome;
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Trên Windows, file handle còn mở có thể gây EPERM khi xoá thư mục tạm
  }
});

test('loadFeatureCase loads request, metadata and acceptance test for feat-01..03', () => {
  for (const featId of ['feat-01', 'feat-02', 'feat-03']) {
    const feat = loadFeatureCase(featId);
    assert.equal(feat.id, featId);
    assert.ok(feat.name.length > 0);
    assert.ok(feat.minFiles >= 3);
    assert.ok(feat.request.includes('Requirements'));
    assert.ok(feat.acceptanceTestCode.includes('test_'));
  }
});

test('registry points to UC-04 runner and executes all 5 cases', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network call during mock evaluation');
  });

  assert.equal(UC_RUNNERS['04'], runUc04);
  const result = await runUc04({ mock: true, config: DEFAULT_CONFIG, workDir: root });

  assert.equal(result.uc, '04');
  assert.equal(result.cases.length, 5);
  assert.deepEqual(
    result.cases.map((c) => c.id),
    [...UC04_CASE_IDS]
  );

  const evidence = evidenceSchema.parse(result);
  assert.deepEqual(evidence.expectedCaseIds, [...UC04_CASE_IDS]);
  assert.deepEqual(evidence.gates, [{ id: 'uc04-pipeline-smoke', passed: true }]);
  assert.deepEqual(releaseEvidenceErrors(result, true), []);

  for (const c of result.cases) {
    const parsed = provenanceSchema.parse('provenance' in c ? c.provenance : undefined);
    assert.deepEqual(parsed, {
      mock: true,
      models: [{ provider: 'mock', model: 'mock-code', role: 'code' }],
    });
    assert.equal(c.passed, true, `Case ${c.id} should pass in mock smoke`);
  }

  assert.equal(result.summary.featurePassRate, 1);
  assert.equal(result.summary.resumeOk, 1);
  assert.equal(result.summary.compactionOk, 1);
  assert.equal(result.summary.memoryOk, 1);
});

test('passesUc04 validates thresholds and requires resume, compaction, and memory', () => {
  const baseResult: UcResult = {
    uc: '04',
    cases: UC04_CASE_IDS.map((id) => ({
      id,
      passed: true,
      metrics: {},
      tokens: 100,
      costDollars: 0.001,
      latencyMs: 10,
    })),
    summary: {
      featurePassRate: 1,
      resumeOk: 1,
      compactionOk: 1,
      memoryOk: 1,
    },
  };

  assert.equal(passesUc04(baseResult, false), true);

  // Cho phép 1 feature fail trong real eval (2/3 đạt)
  const oneFeatureFail: UcResult = {
    ...baseResult,
    cases: baseResult.cases.map((c) => (c.id === 'uc04-resume-2' ? { ...c, passed: false } : c)),
  };
  assert.equal(passesUc04(oneFeatureFail, false), false); // resume-2 failed => resumeOk fails

  const straightFail: UcResult = {
    ...baseResult,
    cases: baseResult.cases.map((c) => (c.id === 'uc04-straight' ? { ...c, passed: false } : c)),
  };
  assert.equal(passesUc04(straightFail, false), true); // 2/3 features pass, resumeOk still 1

  // 2 feature fail => featurePassRate = 1/3 < 2/3 => fail
  const twoFeatureFail: UcResult = {
    ...baseResult,
    cases: baseResult.cases.map((c) =>
      c.id === 'uc04-straight' || c.id === 'uc04-resume-1' ? { ...c, passed: false } : c
    ),
  };
  assert.equal(passesUc04(twoFeatureFail, false), false);

  // Compaction fail => fail
  const compactionFail: UcResult = {
    ...baseResult,
    cases: baseResult.cases.map((c) => (c.id === 'uc04-compaction' ? { ...c, passed: false } : c)),
  };
  assert.equal(passesUc04(compactionFail, false), false);

  // Memory fail => fail
  const memoryFail: UcResult = {
    ...baseResult,
    cases: baseResult.cases.map((c) => (c.id === 'uc04-memory' ? { ...c, passed: false } : c)),
  };
  assert.equal(passesUc04(memoryFail, false), false);
});

test('real runner rejects a disabled configured provider instead of falling back to mock', async () => {
  const model = loadCatalog().models('ollama')[0];
  assert.ok(model);
  const config = {
    ...DEFAULT_CONFIG,
    modelRoles: { code: `${model.provider}/${model.id}` },
    disabledProviders: [model.provider],
  };
  await assert.rejects(
    runUc04({ mock: false, config, workDir: root }),
    /turned off/
  );
});
