// src/agents/fix.ts - UC-03: reproduce, locate, patch, verify a bug in at most 5 rounds
//
// baseline -> reproduce -> locate -> patch -> verify -> (locate | keep | report) -> report
//
// Every model call goes through one token budget and one deadline for the whole workflow, so retries and
// the explanation call count too. "fixed" needs the reproduction targets to pass on their own and a full
// suite that finished with no regression against the baseline (findRegressions: lost or skipped tests,
// timeout, collection errors, abnormal exit codes all count).
import path from 'node:path';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { AgentLoop } from '../core/agent-loop.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import type { CommandUI } from '../core/execution-context.js';
import type { EventBus } from '../core/event-bus.js';
import { createCheckpointer, newThreadId, traceNode } from '../core/graph.js';
import { askHuman, runGraph } from '../core/human-gate.js';
import { axiomHome } from '../core/paths.js';
import { buildSystemPrompt } from '../core/prompt.js';
import { SessionManager } from '../core/session.js';
import { findRegressions, runPytest, type TestRun } from '../core/verifier.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../llm/base-provider.js';
import { CostTracker } from '../llm/cost-tracker.js';
import { ApplyPatchTool } from '../tools/apply-patch.js';
import { BaseTool, type ToolExecutionContext } from '../tools/base-tool.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface FixOptions {
  issue: string;                 // issue.md content or what the user typed
  workspaceRoot: string;
  provider: BaseLLMProvider;
  model: string;
  bus: EventBus;
  /** Session registry; every node takes `tools.scoped([...])` so approvals and denials carry across nodes. */
  tools: ToolRegistry;
  /** Records every model call (eval tokens and cost per case); defaults to a fresh tracker. */
  costTracker?: CostTracker;
  ui?: CommandUI;                // absent: no "Keep the fix?" question, the fix is kept
  maxRounds?: number;            // default 5
  budgetTokens?: number;         // default 200_000
  timeLimitMs?: number;          // default 15 minutes
  signal?: AbortSignal;
  /** Test seam: replaces the sandboxed verifier. Production always uses runPytest. */
  runTests?: (root: string, opts?: { target?: string; signal?: AbortSignal }) => Promise<TestRun>;
}

export interface FixRound { round: number; hypothesis: string; patchApplied: boolean; testsPassed: number; testsFailed: number; regressions: string[] }

export interface FixReport {
  status: 'fixed' | 'failed' | 'aborted';
  rounds: FixRound[];
  filesChanged: string[];
  diffStat: { files: number; added: number; removed: number };
  explanation?: string;          // required when diffStat.files > 3 or added + removed > 100
  summary: string;               // fixed: cause and fix; failed: what was tried, rejected hypotheses, next step
}

export const DEFAULT_MAX_ROUNDS = 5;
export const DEFAULT_BUDGET_TOKENS = 200_000;
export const DEFAULT_TIME_LIMIT_MS = 15 * 60_000;
/** Failed apply_patch calls allowed in one round before the patch node gives up (UC-03 criterion 5). */
export const MAX_PATCH_FAILURES = 3;
const LARGE_DIFF_FILES = 3;
const LARGE_DIFF_LINES = 100;
const OUTPUT_FOR_PROMPT = 2000;

/** Thrown by the budgeted provider; AgentLoop turns it into a failed run. */
class BudgetExceeded extends Error {}

/** Counts every model call of the workflow against one token budget; refuses the call once it is spent. */
class BudgetedProvider extends BaseLLMProvider {
  readonly name: BaseLLMProvider['name'];
  used = 0;
  constructor(private readonly inner: BaseLLMProvider, readonly budget: number) {
    super();
    this.name = inner.name;
  }
  get exhausted(): boolean {
    return this.used >= this.budget;
  }
  async chat(params: ChatParams): Promise<ChatResult> {
    if (this.exhausted) throw new BudgetExceeded(`token budget of ${this.budget} exhausted (${this.used} used)`);
    const result = await this.inner.chat(params);
    this.used += result.usage?.totalTokens ?? 0;
    return result;
  }
}

type PatchFailure = 'conflict' | 'invalid' | 'tamper' | 'refused';

/** Sorts an apply_patch error by cause, so the round report and the cap count the right thing. */
export function classifyPatchError(output: string): PatchFailure {
  if (/does not apply/.test(output)) return 'conflict';
  if (/invalid diff|non-empty unified diff/.test(output)) return 'invalid';
  if (/refusing to change/.test(output)) return 'tamper';
  return 'refused';
}

/**
 * `apply_patch` as the fix workflow offers it: the real tool (test guard included), plus what the report
 * needs (changed files, line counts) and the per-round failure cap. Registered on a scoped view, so the
 * session's policy and approver still decide every call first.
 */
class TrackedApplyPatch extends BaseTool {
  readonly name = 'apply_patch';
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  private readonly inner = new ApplyPatchTool();
  readonly changes = new Map<string, { added: number; removed: number }>();
  failures: PatchFailure[] = [];
  applied = 0;
  tampered = false;
  /** Called when this round reaches MAX_PATCH_FAILURES. */
  onLimit?: () => void;

  constructor() {
    super();
    this.description = this.inner.description;
    this.parameters = this.inner.parameters;
  }

  startRound(onLimit: () => void): void {
    this.failures = [];
    this.applied = 0;
    this.onLimit = onLimit;
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    if (this.failures.length >= MAX_PATCH_FAILURES) return `Error: ${MAX_PATCH_FAILURES} patches failed this round; stop patching.`;
    const out = await this.inner.execute(args, context);
    if (out.startsWith('Error')) {
      const kind = classifyPatchError(out);
      if (kind === 'tamper') this.tampered = true;
      this.failures.push(kind);
      if (this.failures.length >= MAX_PATCH_FAILURES) {
        this.onLimit?.();
        return `${out}\n${MAX_PATCH_FAILURES} patches failed this round; the round ends here.`;
      }
      return out;
    }
    this.applied++;
    for (const match of out.matchAll(/^Applied: (.+?) \(\+(\d+) -(\d+)/gm)) {
      const [, label, added, removed] = match;
      // A rename lists `old -> new`: both paths changed, its lines count once, on the new path.
      const paths = label.split(' -> ');
      for (const file of paths) if (!this.changes.has(file)) this.changes.set(file, { added: 0, removed: 0 });
      const entry = this.changes.get(paths[paths.length - 1])!;
      entry.added += Number(added);
      entry.removed += Number(removed);
    }
    return out;
  }
}

/** `submit_repro`: the targets must really fail (or hang) now; the harness runs each one before accepting. */
class SubmitReproTool extends BaseTool {
  readonly name = 'submit_repro';
  readonly description =
    'Submit the pytest targets (node ids or test files) that reproduce the bug. Each one is run now and must fail or hang; a target that passes or cannot be collected is rejected.';
  readonly parameters = {
    type: 'object',
    properties: { targetTests: { type: 'array', items: { type: 'string' }, description: 'pytest node ids or paths, e.g. tests/test_x.py::test_y' } },
    required: ['targetTests'],
  };
  accepted?: string[];
  constructor(
    private readonly runTests: NonNullable<FixOptions['runTests']>,
    private readonly root: string,
    private readonly signal: AbortSignal,
    private readonly onAccepted: () => void
  ) {
    super();
  }
  async execute(args: Record<string, unknown>): Promise<string> {
    const raw = Array.isArray(args.targetTests) ? args.targetTests : [];
    const targets = [...new Set(raw.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()))];
    if (!targets.length) return 'Error: targetTests must list at least one test that fails because of the bug.';
    const problems: string[] = [];
    for (const target of targets) {
      let run: TestRun;
      try {
        run = await this.runTests(this.root, { target, signal: this.signal });
      } catch (err) {
        return `Error: could not run ${target}: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (run.errors.length) problems.push(`${target}: collection error (${run.errors.join(', ')}); fix the test so it imports and runs`);
      else if (!run.timedOut && run.failed.length === 0) {
        problems.push(`${target}: does not reproduce (passed ${run.passed.length}, skipped ${run.skipped.length}, failed 0)`);
      }
    }
    if (problems.length) return `Error: not accepted.\n${problems.join('\n')}`;
    this.accepted = targets;
    this.onAccepted();
    return `Reproduction accepted: ${targets.join(', ')}`;
  }
}

/** `submit_hypothesis`: the cause the next patch will address. */
class SubmitHypothesisTool extends BaseTool {
  readonly name = 'submit_hypothesis';
  readonly description = 'Submit one hypothesis for the cause of the bug and the files the fix will change.';
  readonly parameters = {
    type: 'object',
    properties: {
      hypothesis: { type: 'string', description: 'One or two sentences: file, function, and why it causes the symptom' },
      files: { type: 'array', items: { type: 'string' }, description: 'Files the fix will change' },
    },
    required: ['hypothesis'],
  };
  submitted?: { hypothesis: string; files: string[] };
  constructor(private readonly onAccepted: () => void) {
    super();
  }
  async execute(args: Record<string, unknown>): Promise<string> {
    const hypothesis = typeof args.hypothesis === 'string' ? args.hypothesis.trim() : '';
    if (!hypothesis) return 'Error: hypothesis must be a non-empty sentence.';
    const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string') : [];
    this.submitted = { hypothesis, files };
    this.onAccepted();
    return 'Hypothesis recorded.';
  }
}

const SUBMIT_TOOLS = new Set(['submit_repro', 'submit_hypothesis']);
const SKILL_NOTE = 'Follow the bug-fix skill listed in the skills index (read it with read_file first).';

export const FIX_REPRODUCE_PROMPT = [
  'Axiom /fix, step: reproduce.',
  SKILL_NOTE,
  'Find or write a pytest test that fails because of the bug in the issue. A new test file goes under tests/ through apply_patch from /dev/null.',
  'Never change or remove existing tests. When a test fails for the reason in the issue, call submit_repro with its node id.',
].join('\n');
export const FIX_LOCATE_PROMPT = [
  'Axiom /fix, step: locate.',
  SKILL_NOTE,
  'Read the code on the failing path with read_file, search_code and list_dir. Do not edit files.',
  'Call submit_hypothesis with one cause (file, function, why) and the files the fix will change. Do not repeat a rejected hypothesis.',
].join('\n');
export const FIX_PATCH_PROMPT = [
  'Axiom /fix, step: patch.',
  SKILL_NOTE,
  `Make the smallest change that removes the cause, with apply_patch (unified diff with context lines). After ${MAX_PATCH_FAILURES} failed patches the round ends.`,
  'Never change, skip or remove existing tests. When the patch is applied, reply with one line saying what changed.',
].join('\n');

const FixState = Annotation.Root({
  before: Annotation<TestRun | undefined>,
  targets: Annotation<string[]>({ reducer: (_c, u) => u, default: () => [] }),
  round: Annotation<number>({ reducer: (_c, u) => u, default: () => 0 }),
  hypothesis: Annotation<{ hypothesis: string; files: string[] } | undefined>,
  rejected: Annotation<string[]>({ reducer: (c, u) => [...c, ...u], default: () => [] }),
  rounds: Annotation<FixRound[]>({ reducer: (c, u) => [...c, ...u], default: () => [] }),
  lastOutput: Annotation<string>({ reducer: (_c, u) => u, default: () => '' }),
  patchApplied: Annotation<boolean>({ reducer: (_c, u) => u, default: () => false }),
  fixed: Annotation<boolean>({ reducer: (_c, u) => u, default: () => false }),
  stop: Annotation<string | undefined>,
  kept: Annotation<boolean | undefined>,
  finalReport: Annotation<FixReport | undefined>,
});
type FixStateType = typeof FixState.State;

const short = (run: TestRun) =>
  `passed ${run.passed.length}, failed ${run.failed.length}, skipped ${run.skipped.length}, collection errors ${run.errors.length}` +
  (run.timedOut ? ', TIMED OUT' : '') +
  (run.failed.length ? `\nFailed: ${run.failed.slice(0, 20).join(', ')}` : '') +
  (run.output ? `\nOutput (tail):\n${run.output.slice(-OUTPUT_FOR_PROMPT)}` : '');

/** Runs the reproduce/locate/patch/verify loop and returns the report; never throws for a failed fix. */
export async function fixIssue(opts: FixOptions): Promise<FixReport> {
  const root = path.resolve(opts.workspaceRoot);
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const runTests = opts.runTests ?? runPytest;
  const provider = new BudgetedProvider(opts.provider, opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS);
  const costTracker = opts.costTracker ?? new CostTracker();
  const deadline = AbortSignal.timeout(opts.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  const patchTool = new TrackedApplyPatch();
  const threadId = newThreadId('fix');
  // Mirrors the state, so a cancel that interrupts the graph still yields a report of what happened.
  let progress: FixStateType | undefined;

  /** Why the workflow must stop now, or undefined. */
  const stopReason = (): string | undefined => {
    if (opts.signal?.aborted) return 'aborted';
    if (deadline.aborted) return `time limit of ${Math.round((opts.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS) / 1000)}s reached`;
    if (provider.exhausted) return `token budget of ${provider.budget} exhausted (${provider.used} used)`;
    return undefined;
  };

  /** One AgentLoop run on a scoped view; `extra` tools are registered on that view only. */
  const runAgent = async (prompt: string, system: string, names: string[], extra: BaseTool[], nodeSignal: AbortSignal) => {
    const view = opts.tools.scoped(names);
    for (const tool of extra) view.registerTool(tool);
    const agent = new AgentLoop({
      config: { ...DEFAULT_CONFIG, workspaceRoot: root },
      provider,
      toolRegistry: view,
      sessionManager: new SessionManager({ workspaceRoot: root, sessionsDir: path.join(axiomHome(), 'sessions'), autoSave: false }),
      costTracker,
      eventBus: opts.bus,
      systemPrompt: buildSystemPrompt(system, root),
      model: opts.model,
      maxSteps: 25,
      signal: nodeSignal,
    });
    const result = await agent.runTask(prompt, nodeSignal);
    const lastText = [...agent.transcript()].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content.trim() ?? '';
    return { ...result, lastText };
  };

  /** A node-local abort that also fires on the workflow signal; submit tools end their node early through it. */
  const nodeController = () => {
    const controller = new AbortController();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
    return controller;
  };

  const baseline = async () => {
    try {
      const before = await runTests(root, { signal });
      return { before, lastOutput: short(before) };
    } catch (err) {
      return { stop: stopReason() ?? `baseline test run failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const reproduce = async (s: FixStateType) => {
    if (s.stop) return {};
    const controller = nodeController();
    const submit = new SubmitReproTool(runTests, root, signal, () => controller.abort());
    patchTool.startRound(() => controller.abort());
    const prompt = `Issue:\n${opts.issue}\n\nBaseline test run: ${s.lastOutput}`;
    await runAgent(prompt, FIX_REPRODUCE_PROMPT, ['read_file', 'search_code', 'list_dir', 'apply_patch', 'run_tests', 'submit_repro'], [patchTool, submit], controller.signal);
    if (submit.accepted) return { targets: submit.accepted };
    return { stop: stopReason() ?? 'could not reproduce the bug: no failing test was submitted with submit_repro' };
  };

  const locate = async (s: FixStateType) => {
    const round = s.round + 1;
    const controller = nodeController();
    const submit = new SubmitHypothesisTool(() => controller.abort());
    const prompt = [
      `Issue:\n${opts.issue}`,
      `Reproduction targets (must pass after the fix): ${s.targets.join(', ')}`,
      `Round ${round} of ${maxRounds}. Latest test run: ${s.lastOutput}`,
      s.rejected.length ? `Rejected hypotheses (Đã loại), do not repeat:\n${s.rejected.map((h) => `- ${h}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    await runAgent(prompt, FIX_LOCATE_PROMPT, ['read_file', 'search_code', 'list_dir', 'submit_hypothesis'], [submit], controller.signal);
    return { round, hypothesis: submit.submitted ?? { hypothesis: '(no hypothesis submitted)', files: [] }, patchApplied: false };
  };

  const patch = async (s: FixStateType) => {
    const controller = nodeController();
    patchTool.startRound(() => controller.abort());
    const h = s.hypothesis ?? { hypothesis: '(none)', files: [] };
    const prompt = [
      `Issue:\n${opts.issue}`,
      `Hypothesis: ${h.hypothesis}`,
      h.files.length ? `Files to change: ${h.files.join(', ')}` : '',
      `Reproduction targets: ${s.targets.join(', ')}`,
    ].filter(Boolean).join('\n\n');
    await runAgent(prompt, FIX_PATCH_PROMPT, ['read_file', 'apply_patch'], [patchTool], controller.signal);
    return { patchApplied: patchTool.applied > 0 };
  };

  const verify = async (s: FixStateType) => {
    const hypothesis = s.hypothesis?.hypothesis ?? '(none)';
    const before = s.before!;
    const failedRound = (lastOutput: string, regressions: string[], after?: TestRun) => ({
      rounds: [{ round: s.round, hypothesis, patchApplied: s.patchApplied, testsPassed: after?.passed.length ?? 0, testsFailed: after?.failed.length ?? 0, regressions }],
      rejected: [hypothesis],
      lastOutput,
    });
    if (!s.patchApplied) {
      const failures = patchTool.failures.length ? ` (${patchTool.failures.join(', ')})` : '';
      return failedRound(`No patch was applied in round ${s.round}${failures}.`, []);
    }
    let after: TestRun;
    const targetProblems: string[] = [];
    try {
      after = await runTests(root, { signal });
      for (const target of s.targets) {
        const run = await runTests(root, { target, signal });
        const ok = run.complete && !run.timedOut && run.errors.length === 0 && run.failed.length === 0 && run.passed.length > 0;
        if (!ok) targetProblems.push(`${target} still not passing (${short(run).split('\n')[0]})`);
      }
    } catch (err) {
      return { ...failedRound(`Test run failed: ${err instanceof Error ? err.message : String(err)}`, ['<run> could not run']), stop: stopReason() };
    }
    const regressions = findRegressions(before, after);
    const fixed = targetProblems.length === 0 && regressions.length === 0 && after.complete && !after.timedOut && after.errors.length === 0;
    const record: FixRound = { round: s.round, hypothesis, patchApplied: true, testsPassed: after.passed.length, testsFailed: after.failed.length, regressions };
    if (fixed) return { rounds: [record], fixed: true, lastOutput: short(after) };
    const problems = [...targetProblems, ...regressions.map((r) => `regression: ${r}`)];
    return { rounds: [record], rejected: [hypothesis], lastOutput: `${problems.join('\n')}\n${short(after)}` };
  };

  const keep = async () => {
    if (!opts.ui) return { kept: true };
    // Nothing may happen before askHuman: LangGraph re-runs this node on resume (DESIGN.md 2026-11-03).
    const answer = askHuman('Giữ bản sửa?', ['yes', 'no']);
    // TODO(D2): on "no", restore this run's files through D2's recovery (#25). Until it exists nothing is
    // reverted, and the report says so instead of claiming a rollback.
    return { kept: answer === 'yes' };
  };

  const report = async (s: FixStateType) => {
    const files = [...patchTool.changes.keys()].sort();
    const added = [...patchTool.changes.values()].reduce((n, c) => n + c.added, 0);
    const removed = [...patchTool.changes.values()].reduce((n, c) => n + c.removed, 0);
    const diffStat = { files: files.length, added, removed };
    let explanation: string | undefined;
    if (diffStat.files > LARGE_DIFF_FILES || added + removed > LARGE_DIFF_LINES) {
      const result = await runAgent(
        `The fix for this issue changed ${diffStat.files} files (+${added} -${removed}): ${files.join(', ')}.\nIssue:\n${opts.issue}\n\nIn 2 to 4 sentences, explain why a change this large was needed.`,
        'Axiom /fix, step: report. Explain the size of the change. Do not call tools.',
        [], [], nodeController().signal
      );
      explanation = result.status === 'completed' && result.lastText ? result.lastText : `(no explanation: ${result.error ?? result.status})`;
    }
    const status: FixReport['status'] = s.fixed ? 'fixed' : s.stop === 'aborted' ? 'aborted' : 'failed';
    let summary: string;
    if (s.fixed) {
      const last = s.rounds[s.rounds.length - 1];
      summary = `Fixed in round ${last.round}. Cause: ${last.hypothesis} Changed: ${files.join(', ') || '(none)'}.`;
      if (s.kept === false) summary += ' You chose not to keep the fix, but automatic rollback is not available yet (waits for D2 #25): the files above are still changed.';
    } else {
      const reason = s.stop ?? (s.round >= maxRounds ? `stopped after ${maxRounds} rounds` : 'stopped');
      const tried = s.rounds.map((r) => `- round ${r.round}: ${r.hypothesis} (${r.patchApplied ? `patch applied, ${r.testsFailed} failing, ${r.regressions.length} regressions` : 'no patch applied'})`);
      summary = [
        `Not fixed: ${reason}.`,
        s.targets.length ? `Reproduction: ${s.targets.join(', ')}.` : 'The bug was not reproduced.',
        tried.length ? `Tried:\n${tried.join('\n')}` : 'No hypothesis was tested.',
        s.rejected.length ? `Rejected hypotheses: ${[...new Set(s.rejected)].join(' | ')}` : '',
        `Last test result: ${s.lastOutput.split('\n')[0] || '(none)'}`,
        patchTool.tampered ? 'At least one patch tried to change an existing test and was refused; if the issue contradicts the tests, the tests are not wrong unless a human says so.' : '',
        `Next step: ${s.targets.length ? 'review the rejected hypotheses and the failing output, then narrow the cause by hand or give more detail in the issue' : 'add exact reproduction steps or a failing test to the issue'}.`,
      ].filter(Boolean).join('\n');
    }
    if (files.length) summary += `\nFiles changed: ${files.join(', ')}${s.fixed ? '' : ' (left in place for review)'}.`;
    return { finalReport: { status, rounds: s.rounds, filesChanged: files, diffStat, ...(explanation !== undefined && { explanation }), summary } };
  };

  const afterVerify = (s: FixStateType) => {
    if (s.fixed) return 'keep';
    if (s.stop || stopReason() || s.round >= maxRounds) return 'report';
    return 'locate';
  };

  const tracked = <K extends string>(name: K, fn: (s: FixStateType) => Promise<Partial<FixStateType>>) =>
    traceNode<FixStateType>(opts.bus, 'fix', name, async (s) => {
      const update = await fn(s);
      // Budget, deadline or cancel hit inside the node: record it so the edges go to report.
      const stop = update.stop ?? s.stop ?? (name === 'report' ? undefined : stopReason());
      progress = { ...s, ...update, rounds: [...s.rounds, ...(update.rounds ?? [])], rejected: [...s.rejected, ...(update.rejected ?? [])], stop } as FixStateType;
      return stop && !s.stop && name !== 'report' ? { ...update, stop } : update;
    });

  const graph = new StateGraph(FixState)
    .addNode('baseline', tracked('baseline', baseline))
    .addNode('reproduce', tracked('reproduce', reproduce))
    .addNode('locate', tracked('locate', locate))
    .addNode('patch', tracked('patch', patch))
    .addNode('verify', tracked('verify', verify))
    .addNode('keep', tracked('keep', keep))
    .addNode('report', tracked('report', report))
    .addEdge(START, 'baseline')
    .addConditionalEdges('baseline', (s) => (s.stop ? 'report' : 'reproduce'), ['reproduce', 'report'])
    .addConditionalEdges('reproduce', (s) => (s.stop ? 'report' : 'locate'), ['locate', 'report'])
    .addConditionalEdges('locate', (s) => (s.stop ? 'report' : 'patch'), ['patch', 'report'])
    .addEdge('patch', 'verify')
    .addConditionalEdges('verify', afterVerify, ['keep', 'locate', 'report'])
    .addEdge('keep', 'report')
    .addEdge('report', END)
    .compile({ checkpointer: createCheckpointer() });

  // submit_* are workflow tools with no catalog entry (decide() asks); approve them here, nothing else.
  const session = opts.tools;
  const originalApprover = session.approver;
  session.approver = async (req) => {
    if (SUBMIT_TOOLS.has(req.name)) return 'approve';
    if (originalApprover) return originalApprover(req);
    return session.allowWithoutApprover ? 'approve' : 'deny';
  };
  const ui: CommandUI = opts.ui ?? { print() {}, async ask() { return 'yes'; }, async confirm() { return true; } };
  try {
    const final = await runGraph<FixStateType>(graph, {}, { threadId, ui, signal: opts.signal });
    return final.finalReport!;
  } catch (err) {
    if (!opts.signal?.aborted) throw err;
    const s = progress;
    return {
      status: 'aborted',
      rounds: s?.rounds ?? [],
      filesChanged: [...patchTool.changes.keys()].sort(),
      diffStat: { files: patchTool.changes.size, added: [...patchTool.changes.values()].reduce((n, c) => n + c.added, 0), removed: [...patchTool.changes.values()].reduce((n, c) => n + c.removed, 0) },
      summary: `Aborted after ${s?.rounds.length ?? 0} round(s); changed files are left in place for review.`,
    };
  } finally {
    session.approver = originalApprover;
  }
}
