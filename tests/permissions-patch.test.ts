import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/tools/permissions.js';
test('unavailable C2 parser never silently authorizes a patch', () => {
  const result = decide('apply_patch', { patch: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' }, process.cwd());
  assert.equal(result.verdict, 'ask');
  assert.equal(result.risk, 'medium');
  assert.match(result.reason, /parser/);
});
