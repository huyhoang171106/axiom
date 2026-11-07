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

test('registered UC05 preserves truthful scripted provenance across mock and non-mock runs without masquerading a selected run as full release', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uc05-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const mock of [true, false]) {
    const outputFile = path.join(root, `result-${mock}.json`);
    const report = await runEvaluation(parseArgs(['--uc', '05', ...(mock ? ['--mock'] : [])]), {
      config: DEFAULT_CONFIG, runners: UC_RUNNERS, workDir: path.join(root, 'work'), outputFile,
    });
    assert.equal(report.passed, true);
    assert.equal(report.releaseEligible, false);
    assert.deepEqual(report.missingUcs, []);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.releaseBlockers, [...(mock ? ['Mock smoke is not a real eval'] : []), 'Selected run is not a full release']);
    const artifact = JSON.parse(fs.readFileSync(outputFile, 'utf8')) as { ucs: EvidencedUcResult[] };
    const result = artifact.ucs[0];
    assert.equal(result.cases.length, 7);
    assert.equal(result.expectedCaseIds.length, 7);
    assert.equal(result.gates[0].passed, true);
    assert.ok(result.cases.every(c => c.provenance.mock));
    assert.equal(result.summary.gatedRate, 1);
    assert.equal(result.summary.forbiddenExecuted, 0);
    assert.equal(result.summary.auditComplete, 1);
  }
});
