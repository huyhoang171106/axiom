// tests/apply-patch.test.ts - apply_patch: parsing, all-or-nothing writes, path checks, registry error contract
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApplyPatchTool, applyHunks, parseUnifiedDiff, PatchConflict } from '../src/tools/apply-patch.js';
import { ToolRegistry } from '../src/tools/registry.js';

function workspace(t: test.TestContext, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const apply = (root: string, patch: string) => new ApplyPatchTool().execute({ patch }, { workspaceRoot: root });

test('parses a git diff into file patches with a/ b/ prefixes stripped', () => {
  const patches = parseUnifiedDiff(
    'diff --git a/src/x.py b/src/x.py\nindex 1..2 100644\n--- a/src/x.py\n+++ b/src/x.py\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n'
  );
  assert.deepEqual(patches, [
    { oldPath: 'src/x.py', newPath: 'src/x.py', hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+c'] }] },
  ]);
});

test('a malformed diff reports the line number', () => {
  assert.throws(() => parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n*b\n'), /invalid diff at line 5: unexpected line/);
  assert.throws(() => parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n'), /invalid diff at line 3: hunk ends early/);
  assert.throws(() => parseUnifiedDiff('just text'), /no ---\/\+\+\+ file headers/);
});

test('applies a valid one-hunk diff', async (t) => {
  const root = workspace(t, { 'calc.py': 'def sub(a, b):\n    return a + b\n' });
  const out = await apply(root, '--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n def sub(a, b):\n-    return a + b\n+    return a - b\n');
  assert.equal(out, 'Applied: calc.py (+1 -1)');
  assert.equal(read(root, 'calc.py'), 'def sub(a, b):\n    return a - b\n');
});

test('a hunk with a wrong line number still applies where its context matches', async (t) => {
  const root = workspace(t, { 'm.py': 'x = 1\ny = 2\nz = 3\n' });
  await apply(root, '--- a/m.py\n+++ b/m.py\n@@ -7,1 +7,1 @@\n-z = 3\n+z = 4\n');
  assert.equal(read(root, 'm.py'), 'x = 1\ny = 2\nz = 4\n');
});

test('keeps CRLF line endings and a missing final newline', async (t) => {
  const root = workspace(t, { 'w.py': 'a\r\nb\r\n', 'n.py': 'a\nb' });
  await apply(root, '--- a/w.py\n+++ b/w.py\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n');
  assert.equal(read(root, 'w.py'), 'a\r\nc\r\n');
  await apply(root, '--- a/n.py\n+++ b/n.py\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n');
  assert.equal(read(root, 'n.py'), 'a\nc');
});

test('applies a diff touching two files atomically', async (t) => {
  const root = workspace(t, { 'a.py': 'one\n', 'b.py': 'two\n' });
  const out = await apply(root, '--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-one\n+ONE\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-two\n+TWO\n');
  assert.equal(out, 'Applied: a.py (+1 -1)\nApplied: b.py (+1 -1)');
  assert.equal(read(root, 'a.py'), 'ONE\n');
  assert.equal(read(root, 'b.py'), 'TWO\n');
});

test('context mismatch writes nothing and returns expected vs actual', async (t) => {
  const root = workspace(t, { 'a.py': 'one\n', 'b.py': 'two\n' });
  // The first file patch is fine; the second does not match, so neither file may change.
  const out = await apply(root, '--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-one\n+ONE\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-zwei\n+TWO\n');
  assert.match(out, /^Error: hunk 1 of b\.py does not apply\. Expected:\nzwei\nActual \(lines 1-1\):\ntwo\n/);
  assert.equal(read(root, 'a.py'), 'one\n');
  assert.equal(read(root, 'b.py'), 'two\n');
});

test('applyHunks throws PatchConflict with the file and hunk', () => {
  const [patch] = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-nope\n+yes\n');
  assert.throws(() => applyHunks('real\n', patch.hunks, 'x'), (err: unknown) => err instanceof PatchConflict && err.path === 'x' && err.hunkIndex === 0);
});

test('rejects a path outside the workspace', async (t) => {
  const root = workspace(t, { 'a.py': 'x\n' });
  const out = await apply(root, '--- a/../escape.py\n+++ b/../escape.py\n@@ -0,0 +1 @@\n+x\n');
  assert.match(out, /^Error: \.\.\/escape\.py is outside the workspace/);
  assert.equal(fs.existsSync(path.join(root, '..', 'escape.py')), false);
});

test('rejects .env', async (t) => {
  const root = workspace(t, { '.env': 'KEY=1\n' });
  const out = await apply(root, '--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-KEY=1\n+KEY=2\n');
  assert.match(out, /^Error: \.env is a secret file/);
  assert.equal(read(root, '.env'), 'KEY=1\n');
});

test('creates and deletes files via /dev/null', async (t) => {
  const root = workspace(t, { 'old.py': 'a\nb\n' });
  const out = await apply(root, '--- /dev/null\n+++ b/pkg/new.py\n@@ -0,0 +1,2 @@\n+x = 1\n+y = 2\n--- a/old.py\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n');
  assert.equal(out, 'Applied: pkg/new.py (+2 -0, created)\nApplied: old.py (+0 -2, deleted)');
  assert.equal(read(root, 'pkg/new.py'), 'x = 1\ny = 2\n');
  assert.equal(fs.existsSync(path.join(root, 'old.py')), false);
});

test('a partial delete or a create over an existing file changes nothing', async (t) => {
  const root = workspace(t, { 'old.py': 'a\nb\n' });
  assert.match(await apply(root, '--- a/old.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n'), /do not remove every line/);
  assert.match(await apply(root, '--- /dev/null\n+++ b/old.py\n@@ -0,0 +1 @@\n+x\n'), /already exists/);
  assert.equal(read(root, 'old.py'), 'a\nb\n');
});

test('registry reports every apply_patch failure as isError with success false', async (t) => {
  const root = workspace(t, { 'a.py': 'one\n', 'tests/test_a.py': 'def test_a():\n    assert f() == 1\n' });
  const registry = new ToolRegistry();
  registry.allowWithoutApprover = true;
  const cases = [
    '--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-zwei\n+x\n',                                          // context mismatch
    '--- a/a.py\n+++ b/a.py\n@@ -1,4 +1,4 @@\n-one\n',                                           // malformed
    '--- a/tests/test_a.py\n+++ b/tests/test_a.py\n@@ -1,2 +1,2 @@\n def test_a():\n-    assert f() == 1\n+    assert True\n', // tamper
  ];
  for (const patch of cases) {
    const result = await registry.executeTool('apply_patch', { patch }, { workspaceRoot: root });
    assert.equal(result.isError, true, patch);
    assert.equal(result.metadata.success, false, patch);
  }
  assert.equal(read(root, 'a.py'), 'one\n');
  const ok = await registry.executeTool('apply_patch', { patch: '--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-one\n+ONE\n' }, { workspaceRoot: root });
  assert.equal(ok.isError, false);
  assert.equal(ok.metadata.success, true);
});
