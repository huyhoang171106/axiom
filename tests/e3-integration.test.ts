// tests/e3-integration.test.ts - Kiểm chứng dialog, registry và kết quả của lệnh đầu phiên.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultCommandRouter } from '../src/commands/index.js';
import type { CommandContext } from '../src/commands/types.js';
import { TuiController } from '../src/tui/controller.js';
import { TuiStore } from '../src/tui/store.js';
import { buildTriageGraph } from '../src/agents/triage.js';
import { runGraph } from '../src/core/human-gate.js';
import { createExecutionContext } from '../src/core/execution-context.js';
import { traceNode } from '../src/core/graph.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { SessionManager } from '../src/core/session.js';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

async function waitFor(store: TuiStore, predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    store.flush();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('dialog did not open');
}

function setup(t: { after(fn: () => void): void }) {
  const previous = process.env.AXIOM_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-e3-'));
  process.env.AXIOM_HOME = root;
  const store = new TuiStore();
  t.after(() => {
    store.dispose();
    if (previous === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, controller: new TuiController(store, { workspaceRoot: root, mock: true }) };
}

test('first slash command uses approval dialog and preserves kind/data for the renderer', async (t) => {
  const { root, store, controller } = setup(t);
  const payload = { answer: 42 };
  let context: CommandContext | undefined;
  defaultCommandRouter.register({ name: 'e3-dialog', summary: '', usage: '', async run(_args, ctx) {
    context = ctx;
    assert.equal(await ctx.ui.confirm('Continue?'), true);
    const result = await ctx.tools.executeTool('write_file', { path: 'package.json', content: '{}' }, { workspaceRoot: root });
    assert.equal(result.isError, false);
    return { kind: 'e3-result', data: payload, text: 'finished' };
  } });
  const submitted = controller.submit('/e3-dialog');
  await waitFor(store, () => store.getSnapshot().pendingApproval?.name === 'confirm');
  assert.equal(store.getSnapshot().question, null);
  store.resolveApproval('approve');
  await waitFor(store, () => store.getSnapshot().pendingApproval?.name === 'write_file');
  store.resolveApproval('approve');
  await submitted;
  store.flush();
  assert.ok(context?.tools.approver);
  assert.ok(context.bus && context.costTracker && context.runId);
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), '{}');
  const turn = store.getSnapshot().entries.at(-1)!;
  assert.equal(turn.kind, 'e3-result');
  assert.deepEqual(turn.data, payload);
});

test('abort refuses pending tool approval and human confirmation without hanging', async (t) => {
  const { root, store, controller } = setup(t);
  for (const human of [false, true]) {
    const name = human ? 'e3-abort-human' : 'e3-abort-tool';
    defaultCommandRouter.register({ name, summary: '', usage: '', async run(_args, ctx) {
      if (human) assert.equal(await ctx.ui.confirm('Continue?'), false);
      else {
        const result = await ctx.tools.executeTool('write_file', { path: 'package.json', content: '{}' }, { workspaceRoot: root });
        assert.equal(result.isError, true);
      }
    } });
    const submitted = controller.submit(`/${name}`);
    await waitFor(store, () => store.getSnapshot().pendingApproval !== null);
    controller.abort();
    await submitted;
    store.flush();
    assert.equal(store.getSnapshot().pendingApproval, null);
    assert.equal(store.getSnapshot().busy, false);
    assert.equal(fs.existsSync(path.join(root, 'package.json')), false);
  }
});

test('an aborted command cannot open a late question', async (t) => {
  const { store, controller } = setup(t);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let context: CommandContext | undefined;
  let rejected = false;
  defaultCommandRouter.register({ name: 'e3-late-question', summary: '', usage: '', async run(_args, ctx) {
    context = ctx;
    await waiting;
    try { await ctx.ui.ask('Too late?'); }
    catch (error) { rejected = error instanceof Error && error.message === 'Cancelled'; }
  } });
  const submitted = controller.submit('/e3-late-question');
  await waitFor(store, () => context !== undefined);
  controller.abort();
  release();
  // Quan sát trước khi cleanup để phát hiện câu hỏi treo mà không treo cả test.
  await new Promise((resolve) => setTimeout(resolve, 20));
  store.flush();
  const lateQuestion = store.getSnapshot().question;
  store.cancelInteraction();
  await submitted;
  assert.equal(lateQuestion, null);
  assert.equal(rejected, true);
});

test('triage and workflow record real node, tool, usage and approval events on the session trace', async (t) => {
  const { root } = setup(t);
  const exec = createExecutionContext();
  exec.tools.approver = async () => 'deny';
  const provider = () => new MockProvider('mock', [{ content: '', toolCalls: [
    { id: 'risky', name: 'read_file', arguments: { path: '.env' } },
    { id: 'ticket', name: 'submit_issue_ticket', arguments: { ticket: {
      type: 'question', priority: 'P3 - question', affected_files: [], reproduction_steps: [],
      acceptance_criteria: ['answered'], missing_info: [], route: 'answer',
    } } },
  ] }, 'finished']);
  const graph = buildTriageGraph({ issue: 'How?', workspaceRoot: root, provider: provider(),
    tools: exec.tools, bus: exec.bus, costTracker: exec.costTracker });
  await runGraph(graph, { issue: 'How?', ticket: null, warnings: [], confirmed: false }, { threadId: 'e3-triage', ui: {
    print() {}, async ask() { return 'no'; }, async confirm() { return false; },
  } });
  assert.ok(graph.checkpointer instanceof SqliteSaver);
  graph.checkpointer.db.close();
  const first = fs.readFileSync(path.join(root, 'traces', `${exec.runId}.jsonl`), 'utf8');
  await traceNode(exec.bus, 'workflow', 'execute', async () => {
    const agent = new AgentLoop({ config: { ...DEFAULT_CONFIG, workspaceRoot: root },
      provider: provider(), toolRegistry: exec.tools.scoped(['read_file']),
      sessionManager: new SessionManager({ workspaceRoot: root, sessionsDir: path.join(root, 'sessions'), autoSave: false }),
      eventBus: exec.bus, costTracker: exec.costTracker });
    await agent.runTask('Try the action');
    return {};
  })({}, { configurable: { thread_id: 'e3-workflow' } });
  const complete = fs.readFileSync(path.join(root, 'traces', `${exec.runId}.jsonl`), 'utf8');
  for (const part of [first, complete.slice(first.length)]) {
    const events = part.trim().split('\n').map((line) => JSON.parse(line) as { event: string });
    for (const expected of ['node', 'tool_call_start', 'tool_call_end', 'cost_update', 'approval']) {
      assert.ok(events.some(({ event }) => event === expected), `missing ${expected}`);
    }
  }
  assert.ok(exec.costTracker.getSessionSummary().totalTokens > 0);
});
