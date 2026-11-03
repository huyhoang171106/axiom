// tests/human-gate.test.ts - askHuman pauses a graph between nodes, runGraph asks the UI and resumes
import test from 'node:test';
import assert from 'node:assert/strict';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import type { CommandUI } from '../src/core/execution-context.js';
import { askHuman, runGraph } from '../src/core/human-gate.js';

const State = Annotation.Root({ answer: Annotation<string>, steps: Annotation<number> });

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
  assert.deepEqual(ui.asked, ['Approve the plan? (1/2/cancel)']);
  assert.equal(fallback.answer, 'cancel');
});
