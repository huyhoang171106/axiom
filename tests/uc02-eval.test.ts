import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UC_RUNNERS } from '../evals/registry.js';
import { loadQuestions, runUc02, TINYDB_ROOT } from '../evals/uc02/run.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { pythonBin } from '../src/core/paths.js';

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

  it('mock run answers every question with valid citations', { skip: !hasPython && 'needs python', timeout: 120_000 }, async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-uc02-'));
    try {
      const result = await runUc02({ mock: true, config: DEFAULT_CONFIG, workDir });
      assert.equal(result.uc, '02');
      assert.equal(result.cases.length, loadQuestions().length);
      assert.deepEqual(result.cases.filter((c) => c.error).map((c) => `${c.id}: ${c.error}`), []);
      assert.ok(result.cases.every((c) => c.metrics.citationsValid === 1), 'mock cites a retrieved chunk, so every citation validates');
      assert.equal(typeof result.summary.recallAt5, 'number');
      assert.ok(result.cases.every((c) => c.tokens > 0 || c.metrics.found === false));
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
