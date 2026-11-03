// tests/graph.test.ts - Shared LangGraph pieces: thread IDs, node tracing, checkpointer packages
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { EventBus } from '../src/core/event-bus.js';
import { newThreadId, traceNode } from '../src/core/graph.js';
import { startTrace } from '../src/core/trace.js';

process.env.AXIOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-graph-home-'));

test('newThreadId has kind prefix and is unique', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newThreadId('feature')));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^feature-\d{8}-\d{6}-[0-9a-f]{6}$/);
});

test('traceNode emits enter then exit with graph and node names', async () => {
  const bus = new EventBus();
  const seen: unknown[] = [];
  bus.on('node', (e) => seen.push(e));
  const node = traceNode<{ n: number }>(bus, 'feature', 'plan', async (s) => ({ n: s.n + 1 }));
  assert.deepEqual(await node({ n: 1 }, { configurable: { thread_id: 'feature-1' } }), { n: 2 });
  assert.deepEqual(seen, [
    { graph: 'feature', node: 'plan', phase: 'enter', threadId: 'feature-1' },
    { graph: 'feature', node: 'plan', phase: 'exit', threadId: 'feature-1' },
  ]);
});

test('node and approval events are traced', () => {
  const bus = new EventBus();
  const trace = startTrace(bus);
  bus.emit('node', { graph: 'fix', node: 'verify', phase: 'enter' });
  bus.emit('approval', { tool: 'run_command', reason: 'installs a package', risk: 'high', decision: 'deny', approver: 'user' });
  trace.close();
  const lines = fs
    .readFileSync(path.join(process.env.AXIOM_HOME!, 'traces', `${trace.runId}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; data: Record<string, unknown> });
  assert.deepEqual(lines.find((l) => l.event === 'node')?.data, { graph: 'fix', node: 'verify', phase: 'enter' });
  assert.equal(lines.find((l) => l.event === 'approval')?.data.decision, 'deny');
});

test('the sqlite checkpointer package loads its native binding', async () => {
  const saver = SqliteSaver.fromConnString(':memory:');
  assert.equal(await saver.getTuple({ configurable: { thread_id: 'none' } }), undefined);
});
