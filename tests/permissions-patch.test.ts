import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/tools/permissions.js';
test('a patch the C2 parser rejects never silently authorizes', () => {
  const result = decide('apply_patch', { patch: '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-a\n' }, process.cwd());
  assert.equal(result.verdict, 'ask');
  assert.equal(result.risk, 'medium');
  assert.match(result.reason, /parser/);
});
// E1 catalog rows 14, 9 and 8 (phase-2-E.md), now that parseUnifiedDiff is real.
test('a small valid patch is allowed, a deletion or more than 5 files asks', () => {
  assert.equal(decide('apply_patch', { patch: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' }, process.cwd()).verdict, 'allow');
  assert.equal(decide('apply_patch', { patch: '--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n' }, process.cwd()).verdict, 'ask');
  const six = Array.from({ length: 6 }, (_, i) => `--- a/f${i}\n+++ b/f${i}\n@@ -1 +1 @@\n-a\n+b\n`).join('');
  assert.equal(decide('apply_patch', { patch: six }, process.cwd()).verdict, 'ask');
});
