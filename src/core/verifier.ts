// src/core/verifier.ts - Run pytest in the sandbox and compare runs for regressions (UC-03)
//
// Results come from a small pytest plugin that appends one JSON line per test report to a file outside
// the workspace, so every outcome (skipped, setup errors, collection errors) is known before the console
// log is cut down for display, and a timeout still leaves the results of the tests that finished.
//
// Test code is untrusted: it runs only under bwrap with the network unshared and the host hidden except
// the Python install. Without bwrap (Windows, macOS, a Linux without user namespaces, the sandbox service
// whose isolation we cannot check) runPytest refuses instead of running unisolated.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { escapesWorkspace } from '../tools/permissions.js';
import { bwrapInvocation, planSandbox } from '../tools/sandbox.js';
import { pythonBin } from './paths.js';
import { redact, scrubEnv } from './secrets.js';

export interface TestRun {
  passed: string[];
  /** Node ids that failed, or errored in setup/teardown. */
  failed: string[];
  timedOut: boolean;
  exitCode: number | null;
  output: string;
  /** Node ids skipped or xfailed: they ran no assertion that counts. */
  skipped: string[];
  /** Files or nodes pytest could not collect (import errors, syntax errors). */
  errors: string[];
  /** pytest reached the end of the session; false after a timeout, a cancel or a crash. */
  complete: boolean;
}

/** `-o addopts=` drops the target repo's own addopts (tinydb: `--cov ...`), so plain pytest is enough. */
export const PYTEST_ARGS: readonly string[] = ['-m', 'pytest', '-q', '-rA', '-p', 'no:cacheprovider', '-o', 'addopts='];
export const TEST_TIMEOUT_MS = 120_000;
const OUTPUT_CHARS = 8000;
const PLUGIN_MODULE = 'axiom_pytest_report';
const PLUGIN_SOURCE = `# Written by Axiom's verifier: one JSON line per report, read back after the run.
import json, os

_PATH = os.environ["AXIOM_PYTEST_REPORT"]


def _emit(record):
    with open(_PATH, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\\n")


def pytest_collectreport(report):
    if report.failed:
        _emit({"kind": "collect", "nodeid": report.nodeid or "<session>"})


def pytest_runtest_logreport(report):
    if report.when != "call" and report.passed:
        return
    outcome = report.outcome
    if hasattr(report, "wasxfail"):
        outcome = "skipped" if report.skipped else outcome
    elif report.when != "call" and report.failed:
        outcome = "failed"
    _emit({"kind": "test", "nodeid": report.nodeid, "outcome": outcome})


def pytest_sessionfinish(session, exitstatus):
    _emit({"kind": "session", "exitstatus": int(exitstatus)})
`;

/** Worst outcome wins: a test that passed its call but failed teardown is failed. */
const RANK: Record<string, number> = { passed: 0, skipped: 1, failed: 2 };

/** Reads the plugin's JSON lines; a line that is not a known record is ignored. */
export function parsePytestReport(jsonl: string): Pick<TestRun, 'passed' | 'failed' | 'skipped' | 'errors' | 'complete'> {
  const outcomes = new Map<string, string>();
  const errors: string[] = [];
  let complete = false;
  for (const line of jsonl.split('\n')) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // empty trailing line, or a line cut by a kill mid-write
    }
    if (!record || typeof record !== 'object') continue;
    const { kind, nodeid, outcome } = record as Record<string, unknown>;
    if (kind === 'session') complete = true;
    else if (kind === 'collect' && typeof nodeid === 'string') errors.push(nodeid);
    else if (kind === 'test' && typeof nodeid === 'string' && typeof outcome === 'string' && outcome in RANK) {
      const previous = outcomes.get(nodeid);
      if (previous === undefined || RANK[outcome] > RANK[previous]) outcomes.set(nodeid, outcome);
    }
  }
  const pick = (want: string) => [...outcomes].filter(([, o]) => o === want).map(([id]) => id);
  return { passed: pick('passed'), failed: pick('failed'), skipped: pick('skipped'), errors, complete };
}

/**
 * What got worse from `before` to `after`: each test that passed before and does not pass now (failed,
 * skipped or gone), plus run-level problems of `after` (timeout, unfinished run, collection errors, a pytest
 * exit code other than 0 or 1). Empty means no regression.
 */
export function findRegressions(before: TestRun, after: TestRun): string[] {
  const nowPassing = new Set(after.passed);
  const out: string[] = [];
  const failed = new Set(after.failed);
  const skipped = new Set(after.skipped);
  for (const id of before.passed) {
    if (nowPassing.has(id)) continue;
    out.push(`${id} (${failed.has(id) ? 'failed' : skipped.has(id) ? 'skipped' : 'missing'})`);
  }
  if (after.timedOut && !before.timedOut) out.push('<run> timed out');
  else if (!after.complete && before.complete) out.push('<run> did not finish');
  const beforeErrors = new Set(before.errors);
  for (const id of after.errors) {
    if (!beforeErrors.has(id)) out.push(`<run> collection error in ${id}`);
  }
  if (after.exitCode !== null && after.exitCode !== 0 && after.exitCode !== 1 && after.exitCode !== before.exitCode) {
    out.push(`<run> pytest exit code ${after.exitCode}`);
  }
  return out;
}

const readableRootsCache = new Map<string, string[]>();

/** The Python install the sandbox must keep readable: prefixes (venv, setup-python), user site, the binary's dir. */
function pythonRoots(python: string): string[] {
  const cached = readableRootsCache.get(python);
  if (cached) return cached;
  const probe = spawnSync(
    python,
    ['-I', '-c', "import os, site, sys; print(sys.prefix, sys.base_prefix, site.getusersitepackages(), os.path.dirname(os.path.realpath(sys.executable)), sep='\\n')"],
    { encoding: 'utf8', timeout: 15_000 }
  );
  if (probe.status !== 0) throw new Error(`${python} did not start (${probe.error?.message ?? probe.stderr.trim()}); set AXIOM_PYTHON`);
  const roots = new Set<string>();
  for (const line of probe.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    roots.add(line);
    try {
      roots.add(fs.realpathSync(line));
    } catch {
      // The user site dir often does not exist; nothing to bind then.
    }
  }
  const result = [...roots].filter((r) => r !== '/');
  readableRootsCache.set(python, result);
  return result;
}

/** POSIX single-quote quoting for the `bash -c` line bwrap runs. */
const shellQuote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

/** Rejects a target that is not a path inside `root`, or that pytest would read as an option. */
function checkTarget(root: string, target: string): string {
  const trimmed = target.trim();
  const file = trimmed.split('::')[0];
  if (!trimmed || trimmed.startsWith('-')) throw new Error(`invalid test target "${target}"`);
  if (path.isAbsolute(file) || escapesWorkspace(file, root)) throw new Error(`test target ${file} is outside the workspace`);
  return trimmed;
}

/**
 * Runs pytest (only pytest: the argv is fixed, `target` is one path or node id inside `root`) under bwrap with
 * the network off. Throws when the run cannot be isolated, when `target` is invalid, or when Python is missing.
 */
export async function runPytest(root: string, opts?: { target?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<TestRun> {
  const workspace = path.resolve(root);
  const target = opts?.target === undefined ? undefined : checkTarget(workspace, opts.target);
  const plan = planSandbox();
  const allowLocal = process.env.AXIOM_ALLOW_LOCAL_TESTS === '1';

  if (plan.kind !== 'bwrap' && !allowLocal) {
    throw new Error(
      `run_tests needs the bwrap sandbox (Linux with unprivileged user namespaces) to cut the network and hide host files; ` +
        `the "${plan.kind}" backend cannot guarantee that (${plan.detail}). Tests are not run unisolated.`
    );
  }
  const python = pythonBin();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-pytest-'));
  try {
    fs.writeFileSync(path.join(scratch, `${PLUGIN_MODULE}.py`), PLUGIN_SOURCE);
    const report = path.join(scratch, 'report.jsonl');
    const argv = [python, ...PYTEST_ARGS, '-p', PLUGIN_MODULE, ...(target ? [target] : [])];

    let file: string;
    let args: string[];
    let env: NodeJS.ProcessEnv;

    if (plan.kind === 'bwrap') {
      const inv = bwrapInvocation(`exec ${argv.map(shellQuote).join(' ')}`, workspace, {
        isolateNetwork: true,
        readableRoots: pythonRoots(python),
        extraWritable: [scratch],
      });
      file = inv.file;
      args = inv.args;
      env = {
        ...scrubEnv(process.env),
        HOME: scratch,
        PYTHONPATH: scratch,
        PYTHONDONTWRITEBYTECODE: '1',
        AXIOM_PYTEST_REPORT: report,
      };
    } else {
      // Local execution fallback for Windows or explicit opt-in
      file = python;
      args = [...PYTEST_ARGS, '-p', PLUGIN_MODULE, ...(target ? [target] : [])];
      env = {
        ...scrubEnv(process.env),
        PYTHONPATH: scratch,
        PYTHONDONTWRITEBYTECODE: '1',
        AXIOM_PYTEST_REPORT: report,
      };
    }

    const { exitCode, timedOut, output } = await runKillable(file, args, {
      cwd: workspace,
      env,
      timeoutMs: opts?.timeoutMs ?? TEST_TIMEOUT_MS,
      signal: opts?.signal,
    });
    const results = parsePytestReport(fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '');
    return { ...results, timedOut, exitCode, output: redact(output).slice(-OUTPUT_CHARS) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Spawns `file` in its own process group and, on timeout or abort, SIGKILLs the whole group. bwrap's
 * `--unshare-pid` + `--die-with-parent` then take every process in the sandbox down with it.
 */
function runKillable(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }
): Promise<{ exitCode: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('test run cancelled'));
      return;
    }
    const isWin = process.platform === 'win32';
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, detached: !isWin, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // Keep a bounded tail: a test printing in a loop must not exhaust memory before the timeout fires.
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_CHARS * 4);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    let cancelled = false;
    const killTree = () => {
      try {
        if (child.pid !== undefined) {
          if (isWin) {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        }
      } catch {
        // The group is already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killTree();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (cancelled) reject(new Error('test run cancelled'));
      else resolve({ exitCode: timedOut ? null : code, timedOut, output });
    });
  });
}
