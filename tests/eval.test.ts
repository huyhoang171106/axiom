import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCases, parseArgs, passesThresholds, summarize, type CaseResult } from '../evals/run.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-eval-'));
}

function caseFile(id: string, type = 'bug', route = 'fix'): string {
  return JSON.stringify({ id, input: `issue for ${id}`, expected: { type, route } });
}

function result(overrides: Partial<CaseResult>): CaseResult {
  return {
    id: 'c',
    expected: { type: 'bug', route: 'fix' },
    schemaValid: true,
    typeCorrect: true,
    routeCorrect: true,
    ...overrides,
  };
}

test('parseArgs defaults to all UCs without mock', () => {
  assert.deepEqual(parseArgs([]), { mock: false });
});

test('parseArgs reads --uc and --mock', () => {
  assert.deepEqual(parseArgs(['--uc', '01', '--mock']), { uc: '01', mock: true });
});

test('parseArgs rejects a missing or malformed --uc value', () => {
  assert.throws(() => parseArgs(['--uc']), /--uc/);
  assert.throws(() => parseArgs(['--uc', '1']), /two-digit/);
  assert.throws(() => parseArgs(['--ucfoo']), /--uc/);
});

test('loadCases reads every json file sorted, never the results file', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'b.json'), caseFile('b'));
  fs.writeFileSync(path.join(dir, 'a.json'), caseFile('a'));
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ uc: '01' }));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  assert.deepEqual(loadCases(dir).map((c) => c.id), ['a', 'b']);
});

test('loadCases rejects invalid json and bad enums with the file name', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
  assert.throws(() => loadCases(dir), /broken\.json: not valid JSON/);
  fs.writeFileSync(path.join(dir, 'broken.json'), caseFile('x', 'not-a-type', 'fix'));
  assert.throws(() => loadCases(dir), /broken\.json: bad case file/);
});

test('summarize computes rates over all cases', () => {
  const summary = summarize([
    result({}),
    result({ typeCorrect: false }),
    result({ routeCorrect: false, schemaValid: false }),
  ]);
  assert.deepEqual(summary, { cases: 3, schemaValidRate: 2 / 3, typeAccuracy: 2 / 3, routeAccuracy: 2 / 3 });
});

test('summarize of no cases is all zeros', () => {
  assert.deepEqual(summarize([]), { cases: 0, schemaValidRate: 0, typeAccuracy: 0, routeAccuracy: 0 });
});

test('real UC-01 enforces both thresholds while mock remains a smoke check', () => {
  const passing = { cases: 10, schemaValidRate: 1, typeAccuracy: 0.8, routeAccuracy: 0 };
  assert.equal(passesThresholds('01', passing, false), true);
  assert.equal(passesThresholds('01', { ...passing, schemaValidRate: 0.9 }, false), false);
  assert.equal(passesThresholds('01', { ...passing, typeAccuracy: 0.7 }, false), false);
  assert.equal(passesThresholds('01', { ...passing, cases: 0 }, false), false);
  assert.equal(passesThresholds('01', { ...passing, schemaValidRate: 0, typeAccuracy: 0 }, true), true);
});
