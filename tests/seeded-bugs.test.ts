import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pythonBin } from '../src/core/paths.js';
import { bugSchema, check, ISSUES_DIR, listBugs, loadBug, seed, TARGET_REPO } from '../evals/issues/bugs.js';

// The structural checks stay fast; the checker test below runs real pytest for all ten fixtures.
const bugs = listBugs();
const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

test('there are ten seeded bugs, each with an issue, a bug.json and a hidden test', () => {
  assert.equal(bugs.length, 10, `found ${bugs.length}`);
  assert.deepEqual(
    bugs.map((id) => loadBug(id).category),
    ['one-file', 'one-file', 'needs-repro-test', 'two-files', 'hang', 'one-file', 'needs-repro-test', 'two-files', 'hang', 'unfixable']
  );
  for (const id of bugs) {
    for (const file of ['issue.md', 'bug.json', 'test_hidden.py']) assert.ok(fs.existsSync(path.join(ISSUES_DIR, id, file)), `${id}/${file}`);
    assert.doesNotThrow(() => loadBug(id), id);
  }
});

const hasPytest = spawnSync(pythonBin(), ['-m', 'pytest', '--version'], { windowsHide: true }).status === 0;

// Runs real pytest on all ten bugs (check() prints one line per bug); the slowest test in this file.
test('every hidden test passes on the original and fails or times out on its seeded bug', () => {
  assert.equal(hasPytest, true, 'C1 acceptance requires Python + pytest; this test must not be skipped');
  assert.equal(check(), true);
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
    // A deletion (empty replace) has no buggy line to leak.
    for (const edit of bug.edits) assert.ok(!edit.replace.trim() || !issue.includes(edit.replace.trim()), `${id} shows the buggy line`);
  }
});

test('no two bugs seed the same change', () => {
  const seen = new Map<string, string>();
  for (const id of bugs) {
    for (const edit of loadBug(id).edits) {
      const key = `${edit.file}\0${edit.find}`;
      assert.ok(!seen.has(key), `${id} edits the same code as ${seen.get(key)}`);
      seen.set(key, id);
    }
  }
});

test('bug.json rejects unknown keys, so no bug can grant itself an exception to the test-edit rule', () => {
  const bug = { category: 'unfixable', fixFiles: ['tinydb/queries.py'], edits: [{ file: 'tinydb/queries.py', find: 'a', replace: 'b' }] };
  assert.doesNotThrow(() => bugSchema.parse(bug));
  assert.throws(() => bugSchema.parse({ ...bug, allowTestEdits: true }), /allowTestEdits/);
  assert.throws(() => bugSchema.parse({ ...bug, edits: [{ ...bug.edits[0], file: 'tests/test_queries.py', trusted: true }] }), /trusted/);
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
