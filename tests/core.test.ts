import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/core/agent-loop.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { SessionManager } from '../src/core/session.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { RepetitionGuard } from '../src/core/repetition-guard.js';

function setup(responses: ConstructorParameters<typeof MockProvider>[1], opts: { maxSteps?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-'));
  const config = { ...DEFAULT_CONFIG, workspaceRoot: root };
  const agent = new AgentLoop({
    config,
    provider: new MockProvider('mock', responses),
    costTracker: new CostTracker(),
    sessionManager: new SessionManager({ workspaceRoot: root, sessionsDir: path.join(root, '.sessions'), autoSave: false } as never),
    ...opts,
  });
  agent.toolRegistry.allowWithoutApprover = true;
  return { agent, root };
}

test('plain answer completes', async () => {
  const { agent } = setup(['hello']);
  const r = await agent.runTask('hi');
  assert.equal(r.status, 'completed');
});

test('write tool call changes a file and is tracked', async () => {
  const { agent, root } = setup([
    { content: '', toolCalls: [{ id: 't1', name: 'write', arguments: { path: 'a.txt', content: 'x' } }] },
    'done',
  ]);
  const r = await agent.runTask('make a.txt');
  assert.equal(r.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'x');
  assert.deepEqual(r.filesChanged, ['a.txt']);
});

test('step limit fails a looping agent', async () => {
  const call = { content: '', toolCalls: [{ id: 't', name: 'read', arguments: { path: 'nope' } }] };
  const { agent } = setup([call, call, call, call], { maxSteps: 2 });
  const r = await agent.runTask('loop');
  assert.equal(r.status, 'failed');
});

test('risky call is refused without approver', async () => {
  const { agent } = setup([
    { content: '', toolCalls: [{ id: 't', name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }] },
    'ok',
  ]);
  agent.toolRegistry.allowWithoutApprover = false;
  await agent.runTask('rm');
  const tool = agent.transcript().find((m) => m.role === 'tool');
  assert.match(tool!.content, /Refusing/);
});

test('repetition guard fires on third identical call', () => {
  const g = new RepetitionGuard();
  assert.equal(g.record('x', {}), undefined);
  assert.equal(g.record('x', {}), undefined);
  assert.match(g.record('x', {})!, /REPETITION GUARD/);
});
