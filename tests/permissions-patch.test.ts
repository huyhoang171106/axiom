import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/tools/permissions.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';

// Parser thật phải kiểm cả nguồn lẫn đích, kể cả khi một file khác chỉ cần hỏi người dùng.
const change = (oldPath: string, newPath = oldPath) =>
  `--- a/${oldPath}\n+++ b/${newPath}\n@@ -1 +1 @@\n-old\n+new\n`;

test('patch policy checks sensitive configuration and both rename endpoints', () => {
  for (const file of ['.github/workflows/ci.yml', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements-dev.txt', 'package.json', 'package-lock.json', 'SECURITY.md']) {
    for (const patch of [change(file), change(file, 'safe.txt'), change('safe.txt', file)]) {
      const decision = decide('apply_patch', { patch }, process.cwd());
      assert.equal(decision.verdict, 'ask', file);
      assert.equal(decision.risk, 'high', file);
    }
  }
});

test('patch hard denial wins over configuration approval in either order', () => {
  for (const file of ['.env', '.ssh/key', '../outside.txt', 'dir/../../outside.txt']) {
    for (const forbidden of [change(file, 'safe.txt'), change('safe.txt', file)]) {
      for (const patch of [change('package.json') + forbidden, forbidden + change('package.json')]) {
        const decision = decide('apply_patch', { patch }, process.cwd());
        assert.equal(decision.verdict, 'deny', file);
        assert.equal(decision.risk, 'high', file);
      }
    }
  }
});

test('five file patches and new files are low risk but deletion asks', () => {
  const five = Array.from({ length: 5 }, (_, i) => change(`file${i}`)).join('');
  for (const patch of [five, '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n']) {
    const decision = decide('apply_patch', { patch }, process.cwd());
    assert.equal(decision.verdict, 'allow');
    assert.equal(decision.risk, 'low');
  }
  const deletion = decide('apply_patch', { patch: '--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n' }, process.cwd());
  assert.equal(deletion.verdict, 'ask');
  assert.equal(deletion.risk, 'medium');
});

test('junction patch paths are blocked before approval or mutation', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-patch-policy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'file.txt'), 'old\n');
  fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  fs.mkdirSync(path.join(root, '.ssh'));
  fs.symlinkSync(path.join(root, '.ssh'), path.join(root, 'secret-link'), 'junction');
  const registry = new ToolRegistry();
  registry.approver = async () => assert.fail('hard denial must not ask');
  for (const file of ['link/file.txt', 'secret-link/key']) {
    for (const patch of [change(file, 'safe.txt'), change('safe.txt', file)]) {
      const result = await registry.executeTool('apply_patch', { patch }, { workspaceRoot: root });
      assert.equal(result.isError, true);
      assert.equal(result.metadata?.success, false);
      assert.equal((result.metadata?.policy as { verdict: string }).verdict, 'deny');
    }
  }
  assert.equal(fs.readFileSync(path.join(outside, 'file.txt'), 'utf8'), 'old\n');
  assert.equal(fs.existsSync(path.join(root, 'safe.txt')), false);
});
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
