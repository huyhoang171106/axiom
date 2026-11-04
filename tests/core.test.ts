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

test('budget is scoped to each run while session usage is retained', async () => {
  const { agent } = setup([
    { content: 'first', usage: { costEstimate: 6 } },
    { content: '', usage: { costEstimate: 5 }, toolCalls: [{ id: 't', name: 'read_file', arguments: { path: 'missing' } }] },
  ]);
  assert.equal((await agent.runTask('first')).status, 'completed');
  const second = await agent.runTask('second');
  assert.equal(second.status, 'failed');
  assert.match(second.error!, /Budget limit reached/);
  assert.equal(agent.costTracker.getSessionSummary().totalCost, 11);
});

test('plain answer completes', async () => {
  const { agent } = setup(['hello']);
  const r = await agent.runTask('hi');
  assert.equal(r.status, 'completed');
});

test('write tool call changes a file and is tracked', async () => {
  const { agent, root } = setup([
    { content: '', toolCalls: [{ id: 't1', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } }] },
    'done',
  ]);
  const r = await agent.runTask('make a.txt');
  assert.equal(r.status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'x');
  assert.deepEqual(r.filesChanged, ['a.txt']);
});

test('step limit fails a looping agent', async () => {
  const call = { content: '', toolCalls: [{ id: 't', name: 'read_file', arguments: { path: 'nope' } }] };
  const { agent } = setup([call, call, call, call], { maxSteps: 2 });
  const r = await agent.runTask('loop');
  assert.equal(r.status, 'failed');
});

test('risky call is refused without approver', async () => {
  const { agent } = setup([
    { content: '', toolCalls: [{ id: 't', name: 'run_command', arguments: { command: 'rm -rf x' } }] },
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

test('write_file refuses to overwrite an existing file', async () => {
  const { agent, root } = setup([
    { content: '', toolCalls: [{ id: 't', name: 'write_file', arguments: { path: 'a.txt', content: 'new' } }] },
    'ok',
  ]);
  fs.writeFileSync(path.join(root, 'a.txt'), 'old');
  await agent.runTask('overwrite');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'old');
  assert.match(agent.transcript().find((m) => m.role === 'tool')!.content, /already exists/);
});

test('role options set the system prompt and model sent to the provider', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-'));
  const seen: { model: string; system?: string }[] = [];
  class Spy extends MockProvider {
    override async chat(params: Parameters<MockProvider['chat']>[0]) {
      seen.push({ model: params.model, system: params.messages.find((m) => m.role === 'system')?.content });
      return super.chat(params);
    }
  }
  const agent = new AgentLoop({
    config: { ...DEFAULT_CONFIG, workspaceRoot: root },
    provider: new Spy('mock', ['ok']),
    costTracker: new CostTracker(),
    sessionManager: new SessionManager({ workspaceRoot: root, sessionsDir: path.join(root, '.s'), autoSave: false } as never),
    systemPrompt: 'You are the reviewer.',
    model: 'cheap-model',
  });
  await agent.runTask('review');
  assert.deepEqual(seen, [{ model: 'cheap-model', system: 'You are the reviewer.' }]);
});

test('tool result keeps the model tool call id', async () => {
  const { agent } = setup([{ content: '', toolCalls: [{ id: 'call-42', name: 'read_file', arguments: { path: 'nope' } }] }, 'done']);
  const ids: string[] = [];
  agent.eventBus.on('tool_call_end', (r) => ids.push(r.toolCallId));
  await agent.runTask('read');
  assert.deepEqual(ids, ['call-42']);
});
