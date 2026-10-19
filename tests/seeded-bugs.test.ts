import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ISSUES_DIR, listBugs, loadBug, seed, TARGET_REPO } from '../evals/issues/bugs.js';

// Needs no Python: `npx tsx evals/issues/bugs.ts check` runs the hidden tests against real pytest.
const bugs = listBugs();
const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

test('there are at least five seeded bugs, each with an issue, a bug.json and a hidden test', () => {
  assert.ok(bugs.length >= 5, `found ${bugs.length}`);
  for (const id of bugs) {
    for (const file of ['issue.md', 'bug.json', 'test_hidden.py']) assert.ok(fs.existsSync(path.join(ISSUES_DIR, id, file)), `${id}/${file}`);
    assert.doesNotThrow(() => loadBug(id), id);
  }
});

test('every edit matches the target repo exactly once and never touches its tests', () => {
  for (const id of bugs) {
    const bug = loadBug(id);
    for (const edit of bug.edits) {
      assert.ok(!edit.file.startsWith('tests/'), `${id} edits a test file`);
      const occurrences = read(path.join(TARGET_REPO, edit.file)).split(edit.find).length - 1;
      assert.equal(occurrences, 1, `${id}: ${edit.file}`);
    }
    assert.deepEqual([...new Set(bug.edits.map((e) => e.file))].sort(), [...bug.fixFiles].sort(), `${id}: fixFiles`);
  }
});

test('issues do not name the files or show the diff', () => {
  for (const id of bugs) {
    const issue = read(path.join(ISSUES_DIR, id, 'issue.md'));
    const bug = loadBug(id);
    for (const file of bug.fixFiles) assert.ok(!issue.includes(file) && !issue.includes(path.basename(file)), `${id} names ${file}`);
    for (const edit of bug.edits) assert.ok(!issue.includes(edit.replace.trim()), `${id} shows the buggy line`);
  }
});

test('seed copies the repo with the bug applied and without the hidden test or the bug description', (t) => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-seed-'));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  seed('bug-01', dest);
  const edit = loadBug('bug-01').edits[0];
  const seeded = read(path.join(dest, edit.file));
  assert.ok(seeded.includes(edit.replace) && !seeded.includes(edit.find));
  assert.equal(read(path.join(dest, 'tests/test_operations.py')), read(path.join(TARGET_REPO, 'tests/test_operations.py')));
  const names = fs.readdirSync(dest, { recursive: true }).map(String);
  assert.ok(!names.some((n) => /test_hidden|bug\.json|\.venv/.test(n)), 'hidden test, bug.json or .venv leaked into the copy');
  assert.throws(() => seed('bug-01', dest), /not empty/);
});
