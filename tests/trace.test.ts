import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/core/agent-loop.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { EventBus } from '../src/core/event-bus.js';
import { registerSecret } from '../src/core/secrets.js';
import { SessionManager } from '../src/core/session.js';
import { startTrace } from '../src/core/trace.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { MockProvider } from '../src/llm/providers/mock.js';

process.env.AXIOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-home-'));

const readTrace = (runId: string) =>
  fs
    .readFileSync(path.join(process.env.AXIOM_HOME!, 'traces', `${runId}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { t: number; event: string; data: any });

test('a run writes one JSONL trace with nodes, tool call args, result, time, policy, tokens and cost', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-'));
  const agent = new AgentLoop({
    config: { ...DEFAULT_CONFIG, workspaceRoot: root },
    provider: new MockProvider('mock', [
      {
        content: 'writing',
        toolCalls: [
          { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } },
          { id: 'c2', name: 'run_command', arguments: { command: 'pip install requests' } },
        ],
      },
      'all done',
    ]),
    costTracker: new CostTracker(),
    sessionManager: new SessionManager({ workspaceRoot: root, sessionsDir: path.join(root, '.s'), autoSave: false }),
    eventBus: new EventBus(),
  });
  agent.toolRegistry.approver = async () => 'deny';
  const trace = startTrace(agent.eventBus);
  await agent.runTask('make a.txt');
  trace.close();

  const lines = readTrace(trace.runId);
  const events = lines.map((l) => l.event);
  assert.equal(events[0], 'run_start');
  assert.equal(lines[0].data.runId, trace.runId);
  assert.ok(events.includes('state_change'));
  assert.deepEqual(lines.filter((l) => l.event === 'approval').map((l) => l.data.decision), ['deny']);

  const start = lines.find((l) => l.event === 'tool_call_start')!;
  assert.deepEqual(start.data.arguments, { path: 'a.txt', content: 'x' });
  const [written, denied] = lines.filter((l) => l.event === 'tool_call_end').map((l) => l.data);
  assert.equal(written.toolCallId, 'c1');
  assert.equal(typeof written.output, 'string');
  assert.equal(typeof written.metadata.durationMs, 'number');
  assert.equal(written.metadata.policy.verdict, 'allow');
  assert.equal(denied.metadata.policy.verdict, 'ask');
  assert.equal(denied.metadata.policy.approval, 'denied');

  const costs = lines.filter((l) => l.event === 'cost_update');
  assert.equal(costs.length, 2);
  assert.ok(costs.every((c) => c.data.totalTokens > 0 && typeof c.data.costEstimate === 'number'));
  // Streamed tokens are joined into one line per answer, written before the usage of that answer.
  assert.deepEqual(lines.filter((l) => l.event === 'text').map((l) => l.data), ['writing', 'all done']);
  assert.ok(events.indexOf('text') < events.indexOf('cost_update'));
});

test('errors keep their message and close() stops writing', () => {
  const bus = new EventBus();
  const trace = startTrace(bus);
  bus.emit('error', { message: 'boom', error: new Error('boom') });
  trace.close();
  bus.emit('cost_update', { promptTokens: 1, completionTokens: 1, totalTokens: 2, costEstimate: 0 });
  const lines = readTrace(trace.runId);
  assert.deepEqual(lines.map((l) => l.event), ['run_start', 'error']);
  assert.deepEqual(lines[1].data, { message: 'boom' });
});

test('every run gets its own ID and file', () => {
  const a = startTrace(new EventBus());
  const b = startTrace(new EventBus());
  assert.notEqual(a.runId, b.runId);
  assert.ok(readTrace(a.runId).length === 1 && readTrace(b.runId).length === 1);
});

test('no registered secret value reaches the trace', () => {
  // Built at runtime so no key-shaped literal sits in the repo for secret scanners to flag.
  const secret = `sk-test-${crypto.randomBytes(12).toString('hex')}`;
  registerSecret(secret);
  const bus = new EventBus();
  const trace = startTrace(bus);
  bus.emit('tool_call_end', { toolCallId: 'c', name: 'run_command', output: `KEY=${secret}`, metadata: { args: { k: `"${secret}"` } } });
  trace.close();
  const raw = fs.readFileSync(path.join(process.env.AXIOM_HOME!, 'traces', `${trace.runId}.jsonl`), 'utf8');
  assert.ok(!raw.includes(secret));
});
