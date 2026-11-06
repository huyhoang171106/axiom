// evals/uc03/run.ts - Runner for UC-03 (bug fix): seed each bug, run /fix, grade with the hidden test under bwrap
//
// Per bug: seed a fresh copy (the hidden test never enters it), run the baseline suite, run fixIssue
// unattended, then grade on our own: restore every pre-existing test file, copy the hidden test in, run it,
// remove it, run the full suite again and diff against the baseline. Nothing is taken from the report or the
// model's tool output except status and rounds. Grading runs only through runPytest (bwrap, no network); a
// machine without the sandbox cannot measure UC-03 and the runner throws instead of reporting a pass.
import fs from 'node:fs';
import path from 'node:path';
import { fixIssue, type FixOptions } from '../../src/agents/fix.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { ToolResult } from '../../src/core/types.js';
import { findRegressions, runPytest, type TestRun } from '../../src/core/verifier.js';
import type { BaseLLMProvider, ChatParams } from '../../src/llm/base-provider.js';
import { loadCatalog } from '../../src/llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../../src/llm/model-resolver.js';
import { MockProvider, type MockResponse } from '../../src/llm/providers/mock.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { planSandbox } from '../../src/tools/sandbox.js';
import { isTestPath } from '../../src/tools/test-guard.js';
import type { CaseProvenance, EvidencedUcResult } from '../evidence.js';
import { ISSUES_DIR, listBugs, loadBug, seed } from '../issues/bugs.js';
import { measureCase } from '../measure.js';
import { hasProvider } from '../uc01/cases.js';
import type { UcCaseResult, UcResult, UcRunner } from '../types.js';

/** Topic threshold: at least 4 of 10 bugs fixed, and no bug may leave a regression behind. */
export const MIN_FIX_RATE = 0.4;
export const MOCK_BUG_IDS = ['bug-01'] as const;
const HIDDEN_TEST = 'test_hidden.py';
/** pytest config files outside tests/ that can change what the suite runs; protected like tests. */
const PYTEST_CONFIG = new Set(['pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml']);
const SKIP_DIRS = new Set(['.git', '.venv', '__pycache__', '.pytest_cache', 'node_modules']);

type RunTests = NonNullable<FixOptions['runTests']>;

/** Why UC-03 cannot be measured here, or undefined when the bwrap sandbox is usable. */
export function sandboxUnavailable(): string | undefined {
  const plan = planSandbox();
  return plan.kind === 'bwrap' ? undefined : `${plan.kind} backend (${plan.detail})`;
}

function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/**
 * Remembers every test and pytest config file of the seeded copy. `changed()` lists the ones that were
 * edited or deleted since (new files are allowed: the reproduce step writes new tests); `restore()` puts the
 * originals back so a tampered suite cannot hide a regression from the grader.
 */
export function protectTests(root: string): { changed(): string[]; restore(): void } {
  const originals = new Map<string, Buffer>();
  for (const rel of walk(root)) {
    if (isTestPath(rel) || PYTEST_CONFIG.has(rel)) originals.set(rel, fs.readFileSync(path.join(root, rel)));
  }
  const differs = (rel: string, original: Buffer) => {
    const abs = path.join(root, rel);
    return !fs.existsSync(abs) || !fs.readFileSync(abs).equals(original);
  };
  return {
    changed: () => [...originals].filter(([rel, original]) => differs(rel, original)).map(([rel]) => rel).sort(),
    restore: () => {
      for (const [rel, original] of originals) {
        if (!differs(rel, original)) continue;
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), original);
      }
    },
  };
}

/** True when the agent-visible copy holds no hidden test, under any name the grader uses. */
function hiddenTestAbsent(root: string, bugId: string): boolean {
  const hidden = fs.readFileSync(path.join(ISSUES_DIR, bugId, HIDDEN_TEST));
  return walk(root).every((rel) => {
    if (path.basename(rel).startsWith('test_hidden')) return false;
    return !rel.endsWith('.py') || !fs.readFileSync(path.join(root, rel)).equals(hidden);
  });
}

const isCleanPass = (run: TestRun) =>
  run.complete && !run.timedOut && run.errors.length === 0 && run.failed.length === 0 && run.passed.length > 0;

export interface Uc03CaseOptions {
  workDir: string;
  /** A fresh provider per bug, so a scripted mock never runs out and usage stays per case. */
  createProvider: (bugId: string) => Promise<{ provider: BaseLLMProvider; model: string }>;
  /** Test seam for both the workflow and the grader; absent means runPytest under bwrap. */
  runTests?: RunTests;
  /** Called while fixIssue runs, e.g. to check what the agent can see; test seam. */
  onAgentStart?: (bugId: string, root: string) => void;
}

/** Runs and grades the given bugs; never throws for a failed fix (the case records it). */
export async function runUc03Cases(bugIds: readonly string[], opts: Uc03CaseOptions): Promise<UcResult> {
  const runTests: RunTests = opts.runTests ?? runPytest;
  const cases: UcCaseResult[] = [];
  for (const bugId of bugIds) {
    const bug = loadBug(bugId);
    const root = path.join(opts.workDir, bugId);
    let tampered: boolean | null = null;
    const measured = await measureCase(bugId, async (tracker) => {
      seed(bugId, root);
      if (!hiddenTestAbsent(root, bugId)) throw new Error('hidden test is visible to the agent');
      const protectedTests = protectTests(root);
      // Our own baseline, taken before the agent touches anything; fixIssue's baseline is not trusted.
      const before = await runTests(root);

      const bus = new EventBus();
      tampered = false;
      // The test guard refuses with "refusing to change"; count it from what the tool returned, not the report.
      bus.on('tool_call_end', (result: ToolResult) => {
        if (result.name === 'apply_patch' && /refusing to change/.test(result.output)) tampered = true;
      });
      const tools = new ToolRegistry();
      // Unattended like `axiom fix --yes`: policy `deny` still blocks, `ask` is approved.
      tools.allowWithoutApprover = true;
      const { provider, model } = await opts.createProvider(bugId);
      opts.onAgentStart?.(bugId, root);
      const report = await fixIssue({
        issue: fs.readFileSync(path.join(ISSUES_DIR, bugId, 'issue.md'), 'utf8'),
        workspaceRoot: root,
        provider,
        model,
        bus,
        tools,
        costTracker: tracker,
        ...(opts.runTests ? { runTests: opts.runTests } : {}),
      });

      const testsEdited = protectedTests.changed();
      protectedTests.restore();
      const hiddenRel = `tests/test_hidden_${bugId.replace('-', '_')}.py`;
      fs.copyFileSync(path.join(ISSUES_DIR, bugId, HIDDEN_TEST), path.join(root, hiddenRel));
      let hidden: TestRun;
      try {
        hidden = await runTests(root, { target: hiddenRel });
      } finally {
        fs.rmSync(path.join(root, hiddenRel), { force: true });
      }
      const after = await runTests(root);
      const regressions = findRegressions(before, after);
      // unfixable: the issue contradicts the suite; the right outcome is to stop without touching existing tests.
      // Its hidden test keeps the original contract and is reported, never used for the verdict.
      const fixed = bug.category === 'unfixable'
        ? report.status === 'failed' && testsEdited.length === 0
        : isCleanPass(hidden) && testsEdited.length === 0;
      return {
        fixed,
        metrics: {
          fixed,
          regressions: regressions.length,
          rounds: report.rounds.length,
          tampered,
          testsEdited: testsEdited.length,
          hiddenPassed: isCleanPass(hidden),
          hiddenTimedOut: hidden.timedOut,
          statusFixed: report.status === 'fixed',
          filesChanged: report.filesChanged.length,
        },
      };
    });
    const value = measured.value;
    cases.push({
      id: bugId,
      passed: !!value && value.fixed && value.metrics.regressions === 0,
      // A case that crashed has no measurement: null, never 0 regressions.
      metrics: value?.metrics ?? { fixed: false, regressions: null, rounds: null, tampered },
      tokens: measured.tokens,
      costDollars: measured.costDollars,
      latencyMs: measured.latencyMs,
      // An unfixed bug is a measured outcome, not an error: run.ts treats any case error as a failed UC.
      ...(measured.error !== undefined ? { error: measured.error } : {}),
    });
  }
  return { uc: '03', cases, summary: summarizeUc03(cases) };
}

export function summarizeUc03(cases: readonly UcCaseResult[]): UcResult['summary'] {
  if (!cases.length) return { fixRate: null, regressionRate: null, avgRounds: null };
  const rounds = cases.map((c) => c.metrics.rounds).filter((r): r is number => typeof r === 'number');
  return {
    fixRate: cases.filter((c) => c.metrics.fixed === true).length / cases.length,
    // An unmeasured case counts as a regression: the gate must not pass on missing data.
    regressionRate: cases.filter((c) => c.metrics.regressions !== 0).length / cases.length,
    avgRounds: rounds.length ? rounds.reduce((a, b) => a + b, 0) / rounds.length : null,
  };
}

/** Gate recomputed from the cases: every expected bug present, fixRate >= 0.4 (mock: all), zero regressions everywhere. */
export function passesUc03(result: UcResult, mock: boolean, expected: readonly string[]): boolean {
  const ids = result.cases.map((c) => c.id);
  if (result.uc !== '03' || ids.length !== expected.length || new Set(ids).size !== ids.length || !expected.every((id) => ids.includes(id))) return false;
  if (result.cases.some((c) => c.metrics.regressions !== 0)) return false;
  const fixRate = result.cases.filter((c) => c.metrics.fixed === true).length / result.cases.length;
  return fixRate >= (mock ? 1 : MIN_FIX_RATE);
}

const call = (name: string, args: Record<string, unknown>): MockResponse => ({ toolCalls: [{ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }] });

/** Scripted bug-01 run: a repro test, the right hypothesis, the right patch. Smoke for the pipeline only. */
export function mockBug01Provider(): MockProvider {
  const repro = '--- /dev/null\n+++ b/tests/test_repro_subtract.py\n@@ -0,0 +1,10 @@\n+from tinydb import TinyDB, where\n+from tinydb.operations import subtract\n+from tinydb.storages import MemoryStorage\n+\n+\n+def test_subtract_lowers_the_value():\n+    db = TinyDB(storage=MemoryStorage)\n+    db.insert({"stock": 10})\n+    db.update(subtract("stock", 3), where("stock") == 10)\n+    assert db.all() == [{"stock": 7}]\n';
  const fix = '--- a/tinydb/operations.py\n+++ b/tinydb/operations.py\n@@ -40,2 +40,2 @@\n     def transform(doc: MutableMapping):\n-        doc[field] += n\n+        doc[field] -= n\n';
  const script: Record<string, MockResponse[]> = {
    reproduce: [call('apply_patch', { patch: repro }), call('submit_repro', { targetTests: ['tests/test_repro_subtract.py'] })],
    locate: [call('submit_hypothesis', { hypothesis: 'subtract() in tinydb/operations.py adds n instead of subtracting it.', files: ['tinydb/operations.py'] })],
    patch: [call('apply_patch', { patch: fix }), { content: 'subtract now subtracts.' }],
  };
  const provider = new MockProvider('mock');
  provider.callLimit = 100;
  provider.setHandler((params: ChatParams) => {
    const system = params.messages.find((m) => m.role === 'system')?.content ?? '';
    const step = /Axiom \/fix, step: (\w+)/.exec(system)?.[1] ?? '';
    return script[step]?.shift() ?? { content: 'done' };
  });
  return provider;
}

export const runUc03: UcRunner = async ({ mock, config, workDir }) => {
  // Without bwrap neither the workflow nor the grader can run tests; say so instead of reporting a result.
  const unavailable = sandboxUnavailable();
  if (unavailable) throw new Error(`UC 03: cannot measure without the bwrap sandbox: ${unavailable}. Run on Linux with bwrap (the eval machine).`);
  const catalog = loadCatalog();
  const info = mock ? undefined : resolveModel('@code', catalog, config);
  if (info && !hasProvider(config, info, catalog)) {
    throw new Error(`UC 03: provider ${info.provider} is not set up; run /login or pass --mock`);
  }
  const bugIds = mock ? [...MOCK_BUG_IDS] : listBugs();
  const result = await runUc03Cases(bugIds, {
    workDir,
    createProvider: async () => (info ? { provider: await createProviderFor(info), model: info.id } : { provider: mockBug01Provider(), model: 'mock-code' }),
  });
  const provenance: CaseProvenance = { mock, models: [{ provider: info?.provider ?? 'mock', model: info?.id ?? 'mock-code', role: 'code' }] };
  const evidenced: EvidencedUcResult = {
    ...result,
    cases: result.cases.map((c) => ({ ...c, provenance })),
    expectedCaseIds: bugIds,
    gates: [{ id: mock ? 'uc03-pipeline-smoke' : 'uc03-acceptance', passed: passesUc03(result, mock, bugIds) }],
  };
  return evidenced;
};
