// tests/test-guard.test.ts - Test-tamper guard on apply_patch, edit and write_file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApplyPatchTool, parseUnifiedDiff } from '../src/tools/apply-patch.js';
import { EditTool } from '../src/tools/edit.js';
import { WriteTool } from '../src/tools/write.js';
import { findTestTampering, isTestPath } from '../src/tools/test-guard.js';
import { ToolRegistry } from '../src/tools/registry.js';

const ROOT = '/repo';
const tamper = (patch: string, allowedTests?: string[]) => findTestTampering(parseUnifiedDiff(patch), ROOT, { allowedTests });
const TEST = 'def test_gt():\n    query = Query().value > 1\n    assert query({"value": 2})\n    assert not query({"value": 1})\n';

function workspace(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests/test_queries.py'), TEST);
  fs.writeFileSync(path.join(root, 'queries.py'), 'def gt(a, b):\n    assert a is not None\n    return a > b\n');
  return root;
}

test('isTestPath covers tests/**, test_*.py, *_test.py and conftest.py', () => {
  for (const p of ['tests/test_x.py', 'tests/helpers/data.json', 'pkg/test_x.py', 'pkg/x_test.py', 'conftest.py', 'tests\\win.py']) assert.ok(isTestPath(p), p);
  for (const p of ['tinydb/queries.py', 'testing.py', 'src/contest.py']) assert.ok(!isTestPath(p), p);
});

test('removing an assert in tests/ is blocked', () => {
  const reason = tamper('--- a/tests/test_q.py\n+++ b/tests/test_q.py\n@@ -2,3 +2,2 @@\n     query = Query().value > 1\n     assert query({"value": 2})\n-    assert not query({"value": 1})\n');
  assert.match(reason ?? '', /tests\/test_q\.py: it removes or changes the check "assert not query/);
});

test('weakening assert x == 1 to assert True is blocked', () => {
  assert.match(tamper('--- a/tests/test_q.py\n+++ b/tests/test_q.py\n@@ -1 +1 @@\n-    assert x == 1\n+    assert True\n') ?? '', /removes or changes the check/);
});

test('re-indenting or moving an assert is allowed', () => {
  assert.equal(tamper('--- a/tests/test_q.py\n+++ b/tests/test_q.py\n@@ -1,2 +1,3 @@\n-assert x == 1\n+with ctx():\n+    assert   x == 1\n y = 2\n'), null);
});

test('renaming a test function so pytest stops collecting it is blocked', () => {
  assert.match(tamper('--- a/tests/test_q.py\n+++ b/tests/test_q.py\n@@ -1 +1 @@\n-def test_gt():\n+def _test_gt():\n') ?? '', /def test_gt/);
});

test('adding pytest.mark.skip is blocked', () => {
  for (const line of ['@pytest.mark.skip(reason="flaky")', '@pytest.mark.xfail', '    pytest.skip("later")', '@unittest.skip("x")']) {
    assert.match(tamper(`--- a/tests/test_q.py\n+++ b/tests/test_q.py\n@@ -1 +1,2 @@\n+${line}\n def test_gt():\n`) ?? '', /skips or excuses/, line);
  }
});

test('deselecting tests from pytest config or conftest is blocked', () => {
  assert.match(tamper('--- a/pytest.ini\n+++ b/pytest.ini\n@@ -1 +1,2 @@\n [pytest]\n+addopts = --deselect tests/test_queries.py::test_gt\n') ?? '', /collected or run/);
  assert.match(tamper('--- /dev/null\n+++ b/tests/conftest.py\n@@ -0,0 +1 @@\n+collect_ignore = ["test_queries.py"]\n') ?? '', /collected or run/);
});

test('deleting a test file is blocked', () => {
  assert.match(tamper('--- a/tests/test_q.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-x = 1\n') ?? '', /deletes or moves/);
  assert.match(tamper('--- a/tests/test_q.py\n+++ b/old/q.py\n@@ -1 +1 @@\n x = 1\n') ?? '', /deletes or moves/);
});

test('adding a new test with asserts is allowed', () => {
  assert.equal(tamper('--- /dev/null\n+++ b/tests/test_repro.py\n@@ -0,0 +1,2 @@\n+def test_repro():\n+    assert subtract(10, 3) == 7\n'), null);
  assert.equal(tamper('--- a/tests/test_q.py\n+++ b/tests/test_q.py\n@@ -1 +1,3 @@\n x = 1\n+def test_new():\n+    assert x == 1\n'), null);
});

test('editing assertions outside test files is allowed', () => {
  assert.equal(tamper('--- a/tinydb/queries.py\n+++ b/tinydb/queries.py\n@@ -1 +1 @@\n-    assert a is not None\n+    pass\n'), null);
});

test('only trusted allowedTests exempt a file, and only that file', () => {
  const patch = '--- a/tests/test_q.py\n+++ b/tests/test_q.py\n@@ -1 +1 @@\n-    assert x == 1\n+    assert x == 2\n';
  assert.equal(tamper(patch, ['tests/test_q.py']), null);
  assert.notEqual(tamper(patch, ['tests/test_other.py']), null);
});

test('the model cannot grant itself an exception through tool arguments', async (t) => {
  const root = workspace(t);
  const patch = '--- a/tests/test_queries.py\n+++ b/tests/test_queries.py\n@@ -4 +4 @@\n-    assert not query({"value": 1})\n+    assert query({"value": 1})\n';
  const out = await new ApplyPatchTool().execute({ patch, allowedTests: ['tests/test_queries.py'] }, { workspaceRoot: root, allowedTests: ['tests/test_queries.py'] });
  assert.match(out, /^Error: refusing to change tests\/test_queries\.py/);
  assert.equal(fs.readFileSync(path.join(root, 'tests/test_queries.py'), 'utf8'), TEST);
  const allowed = await new ApplyPatchTool({ allowedTests: ['tests/test_queries.py'] }).execute({ patch }, { workspaceRoot: root });
  assert.match(allowed, /^Applied: tests\/test_queries\.py/);
});

test('a tampering patch writes no file, not even the non-test ones in it', async (t) => {
  const root = workspace(t);
  const patch =
    '--- a/queries.py\n+++ b/queries.py\n@@ -3 +3 @@\n-    return a > b\n+    return a >= b\n' +
    '--- a/tests/test_queries.py\n+++ b/tests/test_queries.py\n@@ -4 +3,0 @@\n-    assert not query({"value": 1})\n';
  assert.match(await new ApplyPatchTool().execute({ patch }, { workspaceRoot: root }), /^Error: refusing/);
  assert.match(fs.readFileSync(path.join(root, 'queries.py'), 'utf8'), /return a > b/);
});

test('edit cannot weaken a test either', async (t) => {
  const root = workspace(t);
  const edit = new EditTool();
  await assert.rejects(
    edit.execute({ path: 'tests/test_queries.py', oldText: '    assert not query({"value": 1})\n', newText: '' }, { workspaceRoot: root }),
    /refusing to change tests\/test_queries\.py: it removes or changes the check/
  );
  await assert.rejects(
    edit.execute({ path: 'tests/test_queries.py', oldText: 'def test_gt', newText: '@pytest.mark.skip\ndef test_gt', }, { workspaceRoot: root }),
    /skips or excuses/
  );
  await assert.rejects(
    edit.execute({ path: 'tests/test_queries.py', startLine: 4, endLine: 4, oldText: '', newText: '    pass' }, { workspaceRoot: root }),
    /removes or changes the check/
  );
  assert.equal(fs.readFileSync(path.join(root, 'tests/test_queries.py'), 'utf8'), TEST);
  // Adding a test to the existing file is still fine.
  await edit.execute({ path: 'tests/test_queries.py', oldText: 'def test_gt():', newText: 'def test_ge():\n    assert True\n\n\ndef test_gt():' }, { workspaceRoot: root });
  assert.match(fs.readFileSync(path.join(root, 'tests/test_queries.py'), 'utf8'), /def test_ge/);
});

test('write_file cannot add a skipping test or a deselecting conftest, but can add a repro test', async (t) => {
  const root = workspace(t);
  const write = new WriteTool();
  await assert.rejects(write.execute({ path: 'tests/test_x.py', content: 'import pytest\npytest.skip("all", allow_module_level=True)\n' }, { workspaceRoot: root }), /skips or excuses/);
  await assert.rejects(write.execute({ path: 'tests/sub/conftest.py', content: 'collect_ignore = ["../test_queries.py"]\n' }, { workspaceRoot: root }), /collected or run/);
  assert.equal(fs.existsSync(path.join(root, 'tests/test_x.py')), false);
  assert.match(await write.execute({ path: 'tests/test_repro.py', content: 'def test_repro():\n    assert 1 + 1 == 2\n' }, { workspaceRoot: root }), /^Created/);
});

test('the default registry guards edit, write_file and apply_patch alike', async (t) => {
  const root = workspace(t);
  const registry = new ToolRegistry();
  registry.allowWithoutApprover = true;
  const calls: Array<[string, Record<string, unknown>]> = [
    ['apply_patch', { patch: '--- a/tests/test_queries.py\n+++ b/tests/test_queries.py\n@@ -4 +4 @@\n-    assert not query({"value": 1})\n+    pass\n' }],
    ['edit', { path: 'tests/test_queries.py', oldText: '    assert not query({"value": 1})', newText: '    pass' }],
    ['write_file', { path: 'tests/test_skip.py', content: '@pytest.mark.skip\ndef test_a():\n    pass\n' }],
  ];
  for (const [name, args] of calls) {
    const result = await registry.executeTool(name, args, { workspaceRoot: root });
    assert.equal(result.isError, true, name);
    assert.match(result.output, /refusing to change tests\//, name);
  }
  assert.equal(fs.readFileSync(path.join(root, 'tests/test_queries.py'), 'utf8'), TEST);
});
