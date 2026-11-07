import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UC_RUNNERS } from '../evals/registry.js';
import type { UcCaseResult } from '../evals/types.js';
import { loadQuestions, mockAskProvider, passesUc02, runUc02, runUc02Cases, summarizeUc02, TINYDB_ROOT } from '../evals/uc02/run.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { pythonBin } from '../src/core/paths.js';
import { fakeEmbedder } from '../src/core/rag/embedder.js';
import { MockProvider } from '../src/llm/providers/mock.js';

const hasPython = !spawnSync(pythonBin(), ['-c', 'import ast'], { windowsHide: true }).error;

let home: string;
const savedHome = process.env.AXIOM_HOME;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-uc02-home-'));
  process.env.AXIOM_HOME = home;
});
after(() => {
  if (savedHome === undefined) delete process.env.AXIOM_HOME;
  else process.env.AXIOM_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const answerable = (id: string, goldFound: number, goldTotal: number, validCitations = 1, citations = 1): UcCaseResult => ({
  id, passed: false, tokens: 1, costDollars: 0, latencyMs: 1,
  metrics: { answered: true, goldFound, goldTotal, recallAt5: goldFound / goldTotal, citations, validCitations, citationsValid: validCitations / citations, abstained: null, freshAfterEdit: null },
});
const absent = (id: string, abstained: boolean): UcCaseResult => ({
  id, passed: abstained, tokens: 0, costDollars: 0, latencyMs: 1,
  metrics: { answered: !abstained, goldFound: null, goldTotal: null, recallAt5: null, citations: 0, validCitations: 0, citationsValid: null, abstained, freshAfterEdit: null },
});

describe('uc02 eval', () => {
  it('questions cover every kind with the required counts', () => {
    const questions = loadQuestions();
    const count = (kind: string) => questions.filter((q) => q.kind === kind).length;
    assert.ok(questions.length >= 20);
    assert.equal(new Set(questions.map((q) => q.id)).size, questions.length, 'ids are unique');
    assert.ok(count('locate') >= 6 && count('flow') >= 4 && count('howto') >= 4 && count('absent') >= 3 && count('after-edit') >= 3);
    for (const q of questions.filter((q) => q.kind === 'flow')) assert.ok(new Set(q.expected.map((e) => e.path)).size >= 2, `${q.id} spans two files`);
    for (const q of questions) {
      assert.equal(q.kind === 'absent', q.expected.length === 0, `${q.id}: only absent questions expect nothing`);
      assert.equal(q.kind === 'after-edit', q.edit !== null, `${q.id}: only after-edit questions edit`);
    }
  });

  it('expected ranges and edits match workspace/tinydb', () => {
    for (const q of loadQuestions()) {
      for (const e of q.expected) {
        const lines = fs.readFileSync(path.join(TINYDB_ROOT, e.path), 'utf8').split('\n');
        assert.ok(e.startLine <= e.endLine && e.endLine <= lines.length, `${q.id}: ${e.path}:L${e.startLine}-L${e.endLine} is inside the file`);
      }
      if (q.edit) assert.ok(fs.readFileSync(path.join(TINYDB_ROOT, q.edit.file), 'utf8').includes(q.edit.find), `${q.id}: edit target exists`);
    }
  });

  it('runner is registered as UC 02', () => {
    assert.equal(UC_RUNNERS['02'], runUc02);
  });

  it('recall counts gold units found, not any hit, and leaves absent questions out', () => {
    const summary = summarizeUc02([answerable('a', 1, 2), answerable('b', 2, 2), absent('c', true), absent('d', false)]);
    assert.equal(summary.recallAt5, 3 / 4);
    assert.equal(summary.abstentionRate, 1 / 2);
  });

  it('a crashed answerable case counts its gold as missed', () => {
    const crashed: UcCaseResult = { ...answerable('b', 0, 2), error: 'boom' };
    crashed.metrics = { ...crashed.metrics, goldFound: null, answered: null };
    assert.equal(summarizeUc02([answerable('a', 2, 2), crashed]).recallAt5, 2 / 4);
  });

  it('the real gate needs recall >= 0.8 and every citation valid; mock only needs valid citations', () => {
    const result = (cases: UcCaseResult[]) => ({ uc: '02', cases, summary: {} });
    const good = [answerable('a', 4, 5), answerable('b', 1, 1)];
    assert.equal(passesUc02(result(good), false, ['a', 'b']), true);
    assert.equal(passesUc02(result([answerable('a', 3, 5), answerable('b', 1, 1)]), false, ['a', 'b']), false, 'recall 4/6 is below 0.8');
    assert.equal(passesUc02(result([answerable('a', 5, 5, 1, 2), answerable('b', 1, 1)]), false, ['a', 'b']), false, 'one invalid citation');
    assert.equal(passesUc02(result(good), false, ['a', 'b', 'c']), false, 'a missing case');
    assert.equal(passesUc02(result([answerable('a', 0, 5), answerable('b', 0, 1)]), true, ['a', 'b']), true, 'mock does not grade retrieval');
  });

  it('grades the model answer before /ask strips invalid citations', { skip: !hasPython && 'needs python', timeout: 120_000 }, async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-uc02-'));
    try {
      const provider = new MockProvider('mock');
      provider.setHandler(() => 'insert is at tinydb/table.py:L9999-L10000.');
      const [question] = loadQuestions().filter((q) => q.id === 'uc02-01');
      const result = await runUc02Cases([question], {
        workDir, createProvider: async () => provider, model: 'mock', embedder: () => fakeEmbedder(), embedModel: 'fake',
      });
      const [c] = result.cases;
      assert.equal(c.error, undefined);
      assert.equal(c.metrics.citations, 1);
      assert.equal(c.metrics.validCitations, 0);
      assert.equal(c.passed, false);
      assert.equal(result.summary.citationsValid, 0);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('mock answers pass the same citation checks as /ask', { skip: !hasPython && 'needs python', timeout: 120_000 }, async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-uc02-'));
    try {
      const [question] = loadQuestions().filter((q) => q.id === 'uc02-01');
      const result = await runUc02Cases([question], {
        workDir, createProvider: async () => mockAskProvider(), model: 'mock', embedder: () => fakeEmbedder(), embedModel: 'fake',
      });
      assert.equal(result.cases[0].metrics.answered, true);
      assert.equal(result.summary.citationsValid, 1);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('mock run covers every question with provenance and a passing smoke gate', { skip: !hasPython && 'needs python', timeout: 300_000 }, async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-uc02-'));
    try {
      const result = await runUc02({ mock: true, config: DEFAULT_CONFIG, workDir }) as Awaited<ReturnType<typeof runUc02>> & {
        gates: { id: string; passed: boolean }[]; expectedCaseIds: string[]; cases: { provenance: { mock: boolean } }[];
      };
      assert.equal(result.uc, '02');
      assert.deepEqual(result.cases.filter((c) => c.error).map((c) => `${c.id}: ${c.error}`), []);
      assert.deepEqual(result.expectedCaseIds, loadQuestions().map((q) => q.id));
      assert.deepEqual(result.gates, [{ id: 'uc02-pipeline-smoke', passed: true }]);
      assert.ok(result.cases.every((c) => c.provenance.mock === true));
      assert.equal(result.summary.citationsValid, 1);
      assert.equal(typeof result.summary.recallAt5, 'number');
      assert.equal(typeof result.summary.abstentionRate, 'number');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
