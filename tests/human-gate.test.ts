// tests/human-gate.test.ts - askHuman pauses a graph between nodes, runGraph asks the UI and resumes
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/index.js';
import { defaultCommandRouter } from '../src/commands/index.js';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import type { CommandUI } from '../src/core/execution-context.js';
import { askHuman, runGraph } from '../src/core/human-gate.js';

const State = Annotation.Root({ answer: Annotation<string>, steps: Annotation<number> });

test('headless without --yes denies risky tool calls', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-e3-headless-'));
  const previousHome = process.env.AXIOM_HOME;
  const previousTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  process.env.AXIOM_HOME = root;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  t.after(() => {
    if (previousHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = previousHome;
    if (previousTTY) Object.defineProperty(process.stdin, 'isTTY', previousTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    fs.rmSync(root, { recursive: true, force: true });
  });
  defaultCommandRouter.register({ name: 'e3-headless', summary: '', usage: '', async run(_args, ctx) {
    const result = await ctx.tools.executeTool('write_file', { path: 'package.json', content: '{}' }, { workspaceRoot: root });
    assert.equal(result.isError, true);
    assert.equal(ctx.tools.allowWithoutApprover, false);
    assert.equal(fs.existsSync(path.join(root, 'package.json')), false);
    assert.equal(await ctx.ui.confirm('Continue?'), false);
  } });
  await runCli(['e3-headless']);
});

/** prepare -> approve (askHuman) -> work; counts how often each node body runs. */
function buildGraph(choices: readonly string[]) {
  const runs = { prepare: 0, approve: 0, work: 0 };
  const graph = new StateGraph(State)
    .addNode('prepare', async () => (runs.prepare++, {}))
    .addNode('approve', async () => (runs.approve++, { answer: askHuman('Approve the plan?', choices) }))
    .addNode('work', async (s) => (runs.work++, { steps: s.answer === 'no' ? 0 : 1 }))
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'approve')
    .addEdge('approve', 'work')
    .addEdge('work', END)
    .compile({ checkpointer: new MemorySaver() });
  return { graph, runs };
}

function fakeUI(opts: { confirm?: boolean; reply?: string }): CommandUI & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    print() {},
    async ask(q) {
      asked.push(q);
      return opts.reply ?? '';
    },
    async confirm(q) {
      asked.push(q);
      return opts.confirm ?? false;
    },
  };
}

test('runGraph stops at askHuman, asks once and resumes with the answer', async () => {
  const { graph, runs } = buildGraph(['yes', 'no']);
  const ui = fakeUI({ confirm: true });
  const result = await runGraph<{ answer: string; steps: number }>(graph, {}, { threadId: 't-yes', ui });
  assert.deepEqual(ui.asked, ['Approve the plan?']);
  assert.equal(result.answer, 'yes');
  assert.equal(result.steps, 1);
  // The node before the gate is not run again on resume; the gated node is (LangGraph re-runs it).
  assert.deepEqual(runs, { prepare: 1, approve: 2, work: 1 });
});

test('answering no reaches the next node as no', async () => {
  const { graph } = buildGraph(['yes', 'no']);
  const result = await runGraph<{ answer: string; steps: number }>(graph, {}, { threadId: 't-no', ui: fakeUI({ confirm: false }) });
  assert.equal(result.answer, 'no');
  assert.equal(result.steps, 0);
});

test('other choices go through ask; an answer that is not a choice becomes the last choice', async () => {
  const picked = await runGraph<{ answer: string }>(buildGraph(['1', '2', 'cancel']).graph, {}, { threadId: 't-pick', ui: fakeUI({ reply: '2' }) });
  assert.equal(picked.answer, '2');
  const ui = fakeUI({ reply: 'whatever' });
  const fallback = await runGraph<{ answer: string }>(buildGraph(['1', '2', 'cancel']).graph, {}, { threadId: 't-bad', ui });
  assert.deepEqual(ui.asked, Array(4).fill('Approve the plan? (1/2/cancel)'));
  assert.equal(fallback.answer, 'cancel');
});

test('an invalid answer is asked again, then falls back to the last choice', async () => {
  const ui = fakeUI({ reply: 'invalid' });
  const result = await runGraph<{ answer: string }>(buildGraph(['continue', 'no']).graph, {}, { threadId: 'retry', ui });
  assert.equal(ui.asked.length, 4);
  assert.equal(result.answer, 'no');
  let attempts = 0;
  ui.ask = async () => ++attempts === 2 ? 'continue' : 'invalid';
  const valid = await runGraph<{ answer: string }>(buildGraph(['continue', 'no']).graph, {}, { threadId: 'retry-valid', ui });
  assert.equal(attempts, 2);
  assert.equal(valid.answer, 'continue');
});
