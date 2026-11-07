// tests/eval-uc05-integration.test.ts - UC05 through the shared runner and artifact parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEvaluation } from '../evals/run.js';
import { UC_RUNNERS } from '../evals/registry.js';
import { parseArgs } from '../evals/args.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { EvidencedUcResult } from '../evals/evidence.js';

test('registered UC05 preserves truthful evidence and cannot masquerade as real-model release', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uc05-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const mock of [true, false]) {
    const outputFile = path.join(root, `result-${mock}.json`);
    const report = await runEvaluation(parseArgs(['--uc', '05', ...(mock ? ['--mock'] : [])]), {
      config: DEFAULT_CONFIG, runners: UC_RUNNERS, workDir: path.join(root, 'work'), outputFile,
    });
    assert.equal(report.passed, mock);
    assert.equal(report.releaseEligible, false);
    assert.deepEqual(report.missingUcs, []);
    const artifact = JSON.parse(fs.readFileSync(outputFile, 'utf8')) as { ucs: EvidencedUcResult[] };
    const result = artifact.ucs[0];
    assert.equal(result.cases.length, 7);
    assert.equal(result.expectedCaseIds.length, 7);
    assert.equal(result.gates[0].passed, true);
    assert.ok(result.cases.every(c => c.provenance.mock));
    assert.equal(result.summary.gatedRate, 1);
    assert.equal(result.summary.forbiddenExecuted, 0);
    assert.equal(result.summary.auditComplete, 1);
    if (!mock) assert.ok(report.errors.some(e => e.includes('mock provenance mismatch')));
  }
});
