// tests/verifier.test.ts - runPytest under bwrap, result parsing, regressions, run_tests tool
//
// Sandbox tests need Linux + bwrap + Python + pytest. They are skipped elsewhere (Windows has no bwrap, so
// run_tests refuses there; see the refusal test), but on CI they must run: a missing sandbox fails them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRegressions, parsePytestReport, runPytest, type TestRun } from '../src/core/verifier.js';
import { pythonBin } from '../src/core/paths.js';
import { isBwrapUsable } from '../src/tools/sandbox.js';
import { formatTestRun } from '../src/tools/run-tests.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { TARGET_REPO } from '../evals/issues/bugs.js';

const hasPytest = spawnSync(pythonBin(), ['-m', 'pytest', '--version'], { windowsHide: true }).status === 0;
const canSandbox = process.platform === 'linux' && isBwrapUsable() && hasPytest;
const onCi = process.env.CI === 'true';
/** Skip with a reason off CI; on CI an unusable sandbox is a failure, not a skip. */
const sandboxed = { skip: !canSandbox && !onCi && 'needs Linux + usable bwrap + python with pytest' };
const requireSandbox = () => assert.ok(canSandbox, `CI must run the sandbox tests: linux=${process.platform === 'linux'} bwrap=${isBwrapUsable()} pytest=${hasPytest}`);

function repo(t: test.TestContext, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-verifier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const run = (over: Partial<TestRun>): TestRun => ({ passed: [], failed: [], skipped: [], errors: [], timedOut: false, exitCode: 0, output: '', complete: true, ...over });

test('parses every outcome from the report, worst outcome per test wins', () => {
  const report = [
    { kind: 'test', nodeid: 't.py::a', outcome: 'passed' },
    { kind: 'test', nodeid: 't.py::b', outcome: 'passed' },
    { kind: 'test', nodeid: 't.py::b', outcome: 'failed' }, // teardown error after a passing call
    { kind: 'test', nodeid: 't.py::c', outcome: 'skipped' },
    { kind: 'collect', nodeid: 'broken.py' },
    { kind: 'session', exitstatus: 1 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n{"kind": "test", "nodeid": "cut';
  assert.deepEqual(parsePytestReport(report), { passed: ['t.py::a'], failed: ['t.py::b'], skipped: ['t.py::c'], errors: ['broken.py'], complete: true });
  assert.equal(parsePytestReport('').complete, false);
});

test('findRegressions reports tests that passed before and fail after', () => {
  const before = run({ passed: ['a', 'b', 'c', 'd'] });
  const after = run({ passed: ['a'], failed: ['b'], skipped: ['c'], exitCode: 1 });
  assert.deepEqual(findRegressions(before, after), ['b (failed)', 'c (skipped)', 'd (missing)']);
  assert.deepEqual(findRegressions(before, run({ passed: ['a', 'b', 'c', 'd', 'new'] })), []);
});

test('findRegressions flags a timeout, an unfinished run, collection errors and odd exit codes', () => {
  const before = run({ passed: [] });
  assert.deepEqual(findRegressions(before, run({ timedOut: true, complete: false, exitCode: null })), ['<run> timed out']);
  assert.deepEqual(findRegressions(before, run({ complete: false, exitCode: 137 })), ['<run> did not finish', '<run> pytest exit code 137']);
  assert.deepEqual(findRegressions(before, run({ errors: ['tests/test_x.py'], exitCode: 2 })), ['<run> collection error in tests/test_x.py', '<run> pytest exit code 2']);
});

test('an all-skipped or empty run is not reported as passing', () => {
  assert.match(formatTestRun(run({ skipped: ['a'] })), /not a passing suite/);
  assert.match(formatTestRun(run({ exitCode: 5 })), /exit code 5/);
});

test('target outside the workspace is rejected', async (t) => {
  const root = repo(t, { 'tests/test_a.py': 'def test_a():\n    pass\n' });
  await assert.rejects(runPytest(root, { target: '../elsewhere/test_x.py' }), /outside the workspace/);
  await assert.rejects(runPytest(root, { target: '/etc/passwd' }), /outside the workspace/);
  await assert.rejects(runPytest(root, { target: '-p evil' }), /invalid test target/);
});

test('without bwrap, run_tests refuses instead of running tests unisolated', async (t) => {
  const root = repo(t, { 'tests/test_a.py': 'def test_a():\n    pass\n' });
  const saved = process.env.AXIOM_SANDBOX;
  process.env.AXIOM_SANDBOX = 'off';
  t.after(() => (saved === undefined ? delete process.env.AXIOM_SANDBOX : (process.env.AXIOM_SANDBOX = saved)));
  await assert.rejects(runPytest(root), /needs the bwrap sandbox.*"local" backend/);
  const result = await new ToolRegistry().executeTool('run_tests', {}, { workspaceRoot: root });
  assert.equal(result.isError, true);
  assert.match(result.output, /Tests are not run unisolated/);
});

test('reports a complete summary even when the console log is cut', sandboxed, async (t) => {
  requireSandbox();
  const root = repo(t, {
    'tests/test_mix.py': [
      'import pytest',
      'def test_pass():\n    print("x" * 20000)\n    assert True',
      'def test_fail():\n    assert 1 == 2',
      '@pytest.mark.skip(reason="later")\ndef test_skip():\n    pass',
      '@pytest.mark.xfail\ndef test_xfail():\n    assert False',
      '@pytest.fixture\ndef broken():\n    raise RuntimeError("setup")',
      'def test_setup_error(broken):\n    pass',
      '',
    ].join('\n\n'),
  });
  const result = await runPytest(root);
  assert.deepEqual(result.passed, ['tests/test_mix.py::test_pass']);
  assert.deepEqual([...result.failed].sort(), ['tests/test_mix.py::test_fail', 'tests/test_mix.py::test_setup_error']);
  assert.deepEqual([...result.skipped].sort(), ['tests/test_mix.py::test_skip', 'tests/test_mix.py::test_xfail']);
  assert.equal(result.complete, true);
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.length <= 8000, `output is ${result.output.length} chars`);
});

test('a collection error is reported, not mistaken for a clean run', sandboxed, async (t) => {
  requireSandbox();
  const root = repo(t, { 'tests/test_ok.py': 'def test_ok():\n    pass\n', 'tests/test_broken.py': 'def test_x(:\n' });
  const result = await runPytest(root);
  assert.deepEqual(result.errors, ['tests/test_broken.py']);
  assert.notEqual(result.exitCode, 0);
  assert.ok(findRegressions(run({ passed: ['tests/test_ok.py::test_ok'] }), result).length > 0);
});

test('runs the target repo with its own pytest.ini (addopts overridden)', sandboxed, async () => {
  requireSandbox();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tinydb-'));
  try {
    fs.cpSync(TARGET_REPO, tmp, { recursive: true, filter: (src) => !/[\\/](\.venv|\.git|__pycache__)$/.test(src) });
    const result = await runPytest(tmp, { target: 'tests/test_queries.py' });
    assert.equal(result.exitCode, 0, result.output);
    assert.ok(result.passed.length > 20, `passed ${result.passed.length}`);
    assert.deepEqual(result.failed, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a hanging test is killed at the timeout, with its child processes', sandboxed, async (t) => {
  requireSandbox();
  const root = repo(t, {
    'tests/test_hang.py': [
      'import subprocess, sys, time',
      'def test_first():\n    pass',
      // A grandchild keeps writing a heartbeat; it must die with the run, not outlive it.
      'def test_hang():\n    subprocess.Popen([sys.executable, "-c", "import time\\nwhile True:\\n    open(\'beat\', \'w\').write(str(time.time()))\\n    time.sleep(0.1)"])\n    time.sleep(600)',
      '',
    ].join('\n\n'),
  });
  const started = Date.now();
  const result = await runPytest(root, { timeoutMs: 4000 });
  assert.ok(Date.now() - started < 20_000);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.complete, false);
  assert.deepEqual(result.passed, ['tests/test_hang.py::test_first']);
  assert.ok(findRegressions(run({}), result).includes('<run> timed out'));
  const beat = path.join(root, 'beat');
  const first = fs.existsSync(beat) ? fs.readFileSync(beat, 'utf8') : '';
  await new Promise((r) => setTimeout(r, 700));
  const second = fs.existsSync(beat) ? fs.readFileSync(beat, 'utf8') : '';
  assert.equal(second, first, 'the grandchild process kept running after the timeout');
});

test('cancelling through the signal stops the run', sandboxed, async (t) => {
  requireSandbox();
  const root = repo(t, { 'tests/test_slow.py': 'import time\ndef test_slow():\n    time.sleep(600)\n' });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1500);
  const started = Date.now();
  await assert.rejects(runPytest(root, { signal: controller.signal }), /cancelled/);
  assert.ok(Date.now() - started < 15_000);
});

test('a test that opens a socket fails under bwrap', sandboxed, async (t) => {
  requireSandbox();
  // A server on the host's loopback: reachable from the host, not from the sandbox's empty network namespace.
  const server = net.createServer((s) => s.end('hello'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const port = (server.address() as net.AddressInfo).port;
  const root = repo(t, {
    'tests/test_net.py': `import socket\ndef test_loopback():\n    socket.create_connection(("127.0.0.1", ${port}), timeout=3).recv(5)\n\ndef test_internet():\n    socket.create_connection(("1.1.1.1", 53), timeout=3)\n`,
  });
  const result = await runPytest(root);
  assert.deepEqual([...result.failed].sort(), ['tests/test_net.py::test_internet', 'tests/test_net.py::test_loopback']);
});

test('a test cannot read files outside the workspace under bwrap', sandboxed, async (t) => {
  requireSandbox();
  const secretPath = path.join(os.homedir(), `.axiom-verifier-secret-${process.pid}`);
  fs.writeFileSync(secretPath, 'TOP-SECRET-VALUE');
  t.after(() => fs.rmSync(secretPath, { force: true }));
  const root = repo(t, {
    'tests/test_read.py': `def test_home_file():\n    print(open(${JSON.stringify(secretPath)}).read())\n\ndef test_ssh_dir():\n    import os\n    assert os.listdir(os.path.expanduser("~/.ssh"))\n\ndef test_etc():\n    print(open("/etc/hostname").read())\n`,
  });
  const result = await runPytest(root);
  assert.equal(result.passed.length, 0, `read outside the workspace: ${result.passed.join(', ')}`);
  assert.equal(result.failed.length, 3);
  assert.ok(!result.output.includes('TOP-SECRET-VALUE'));
});

test('run_tests reports counts and failed tests through the registry', sandboxed, async (t) => {
  requireSandbox();
  const root = repo(t, { 'tests/test_a.py': 'def test_ok():\n    pass\n\ndef test_bad():\n    assert 1 == 2\n' });
  const result = await new ToolRegistry().executeTool('run_tests', {}, { workspaceRoot: root });
  assert.equal(result.isError, false, result.output);
  assert.match(result.output, /^passed 1, failed 1, skipped 0, collection errors 0\nFailed:\n  tests\/test_a\.py::test_bad/);
  const one = await new ToolRegistry().executeTool('run_tests', { target: 'tests/test_a.py::test_ok' }, { workspaceRoot: root });
  assert.match(one.output, /^passed 1, failed 0/);
});
