// tests/compaction.test.ts - Tests for compaction (D3 / UC-04)

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  shouldCompact,
  missingSections,
  compactHistory,
  COMPACT_SECTIONS,
  COMPACT_THRESHOLD,
} from '../src/core/compaction.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { EventBus } from '../src/core/event-bus.js';
import type { TaskState } from '../src/core/task-state.js';
import type { Message } from '../src/core/types.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { SessionManager, defaultSessionManager } from '../src/core/session.js';
import { compactCommand } from '../src/commands/compact.js';
import type { CommandContext } from '../src/commands/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { MOCK_MODEL } from '../src/cli/agent.js';

function makeFiveSectionSummary(): string {
  return [
    '## Goal',
    'Build authentication flow',
    '',
    '## Constraints',
    '- No external auth libraries',
    '',
    '## Completed steps',
    '- Created user schema',
    '- Implemented password hashing',
    '',
    '## Current state',
    'Implementing token verification',
    '',
    '## Open risks and next step',
    'Need to test token expiry and handle refresh edge cases',
  ].join('\n');
}

test('shouldCompact is true above 60 percent of the context window', () => {
  assert.strictEqual(shouldCompact(59, 100), false);
  assert.strictEqual(shouldCompact(60, 100), true);
  assert.strictEqual(shouldCompact(80, 100), true);
  assert.strictEqual(shouldCompact(120, 100), true);
  assert.strictEqual(shouldCompact(0, 0), false);
  assert.strictEqual(shouldCompact(50, 0), false);

  // Custom threshold override
  assert.strictEqual(shouldCompact(65, 100, 0.7), false);
  assert.strictEqual(shouldCompact(70, 100, 0.7), true);
  assert.strictEqual(COMPACT_THRESHOLD, 0.6);
});

test('missingSections lists absent headings', () => {
  const full = makeFiveSectionSummary();
  assert.deepStrictEqual(missingSections(full), []);

  const missingTwo = [
    '## Goal',
    'Something',
    '## Constraints',
    'None',
    '## Open risks and next step',
    'None',
  ].join('\n');
  assert.deepStrictEqual(missingSections(missingTwo), ['Completed steps', 'Current state']);

  const empty = '';
  assert.deepStrictEqual(missingSections(empty), [...COMPACT_SECTIONS]);
});

test('a summary missing a section is retried once', async () => {
  const costTracker = new CostTracker();
  const eventBus = new EventBus();

  // Model returns a summary missing "## Open risks and next step" on first call,
  // then a complete summary on second call (the retry).
  const partialSummary = [
    '## Goal',
    'Build something',
    '## Constraints',
    'None',
    '## Completed steps',
    'Step 1',
    '## Current state',
    'In progress',
  ].join('\n');

  const fullSummary = makeFiveSectionSummary();

  let callCount = 0;
  const provider = new MockProvider('mock', [
    { content: partialSummary, usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 } },
    { content: fullSummary, usage: { promptTokens: 60, completionTokens: 30, totalTokens: 90 } },
  ]);

  const messages: Message[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'msg 1' },
    { role: 'assistant', content: 'reply 1' },
    { role: 'user', content: 'msg 2' },
    { role: 'assistant', content: 'reply 2' },
    { role: 'user', content: 'msg 3' },
    { role: 'assistant', content: 'reply 3' },
  ];

  const result = await compactHistory(messages, {
    provider,
    model: 'mock-model',
    costTracker,
    eventBus,
  });

  // Verify full summary succeeded after retry
  assert.deepStrictEqual(missingSections(result.summary), []);
  assert.strictEqual(costTracker.getSessionSummary().totalTokens, 150);

  // Test case where even after retry, it is still missing sections:
  const stillMissingSummary = [
    '## Goal',
    'Build something',
    '## Constraints',
    'None',
  ].join('\n');

  const errorBus = new EventBus();
  const errorsEmitted: string[] = [];
  errorBus.on('error', (e) => errorsEmitted.push(e.message));

  const failingProvider = new MockProvider('mock', [
    { content: stillMissingSummary, usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } },
    { content: stillMissingSummary, usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 } },
  ]);

  const failedResult = await compactHistory(messages, {
    provider: failingProvider,
    model: 'mock-model',
    eventBus: errorBus,
  });

  // Check that missing sections were appended with "(không có)" and error event was emitted
  assert.strictEqual(errorsEmitted.length, 1);
  assert.ok(errorsEmitted[0].includes('Completed steps'));
  assert.ok(failedResult.summary.includes('## Completed steps\n(không có)'));
  assert.ok(failedResult.summary.includes('## Current state\n(không có)'));
  assert.ok(failedResult.summary.includes('## Open risks and next step\n(không có)'));
});

test('compaction keeps system and last 4 messages', async () => {
  const provider = new MockProvider('mock', [makeFiveSectionSummary()]);

  const messages: Message[] = [
    { role: 'system', content: 'system instructions' },
    { role: 'user', content: 'user 1' },
    { role: 'assistant', content: 'assistant 1' },
    { role: 'user', content: 'user 2' },
    { role: 'assistant', content: 'assistant 2' },
    { role: 'user', content: 'user 3' },
    { role: 'assistant', content: 'assistant 3' },
    { role: 'user', content: 'user 4' },
    { role: 'assistant', content: 'assistant 4' },
  ];

  const result = await compactHistory(messages, {
    provider,
    model: 'mock-model',
  });

  // System prompt is kept as first message
  assert.strictEqual(result.messages[0].role, 'system');
  assert.strictEqual(result.messages[0].content, 'system instructions');

  // Second message is the compacted summary
  assert.strictEqual(result.messages[1].role, 'user');
  assert.strictEqual(result.messages[1].content, result.summary);

  // Last 4 messages are preserved exactly
  const last4 = messages.slice(-4);
  assert.deepStrictEqual(result.messages.slice(-4), last4);

  // Group preservation: assistant tool-call and tool-result must not be split
  const messagesWithTools: Message[] = [
    { role: 'system', content: 'system instructions' },
    { role: 'user', content: 'user 1' },
    { role: 'assistant', content: 'call tool', toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'a.txt' } }] },
    { role: 'tool', content: 'file content', toolCallId: 'tc1', name: 'read_file' },
    { role: 'assistant', content: 'assistant after tool' },
    { role: 'user', content: 'user final' },
    { role: 'assistant', content: 'assistant final' },
  ];

  const toolProvider = new MockProvider('mock', [makeFiveSectionSummary()]);
  const toolResult = await compactHistory(messagesWithTools, {
    provider: toolProvider,
    model: 'mock-model',
  });

  // Cutoff must not split tc1 tool call from its result
  const preservedTail = toolResult.messages.slice(2);
  const toolMsgIndex = preservedTail.findIndex((m) => m.role === 'tool');
  assert.ok(toolMsgIndex > 0, 'Tool message must be preceded by assistant tool-call in tail');
  assert.strictEqual(preservedTail[toolMsgIndex - 1].role, 'assistant');
  assert.ok(preservedTail[toolMsgIndex - 1].toolCalls?.some((c) => c.id === 'tc1'));
});

test('task goal and acceptance are copied verbatim, not summarized', async () => {
  // Model hallucinates or simplifies goal and constraints
  const modelSummary = [
    '## Goal',
    'A loosely described goal by model',
    '## Constraints',
    'No constraints identified',
    '## Completed steps',
    'Step 1 done',
    '## Current state',
    'Working on step 2',
    '## Open risks and next step',
    'No risks',
  ].join('\n');

  const provider = new MockProvider('mock', [modelSummary]);

  const task: TaskState = {
    threadId: 'th_test_compaction',
    workspaceRoot: '/test/workspace',
    goal: 'Verbatim required goal: Implement cryptographic key rotation',
    acceptance: [
      'Acceptance criteria 1: Must rotate keys every 30 days',
      'Acceptance criteria 2: Old keys must remain valid for 24h grace period',
      'Acceptance criteria 3: Never log plain secret keys',
    ],
    constraints: ['Zero downtime during rotation', 'Do not alter database schema'],
    steps: [],
    currentStepIndex: 0,
    status: 'doing',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const messages: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'msg 1' },
    { role: 'assistant', content: 'reply 1' },
    { role: 'user', content: 'msg 2' },
    { role: 'assistant', content: 'reply 2' },
    { role: 'user', content: 'msg 3' },
    { role: 'assistant', content: 'reply 3' },
  ];

  const result = await compactHistory(messages, {
    provider,
    model: 'mock-model',
    task,
  });

  // Goal must be copied verbatim
  assert.ok(result.summary.includes(task.goal));
  assert.ok(!result.summary.includes('A loosely described goal by model'));

  // Constraints and every acceptance criteria must be copied verbatim
  assert.ok(result.summary.includes('Zero downtime during rotation'));
  assert.ok(result.summary.includes('Do not alter database schema'));
  assert.ok(result.summary.includes('Acceptance criteria 1: Must rotate keys every 30 days'));
  assert.ok(result.summary.includes('Acceptance criteria 2: Old keys must remain valid for 24h grace period'));
  assert.ok(result.summary.includes('Acceptance criteria 3: Never log plain secret keys'));

  // Other sections are preserved from model
  assert.ok(result.summary.includes('Step 1 done'));
  assert.ok(result.summary.includes('Working on step 2'));
});

test('agent loop compacts automatically past the threshold', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-compaction-test-'));

  try {
    const sessionManager = new SessionManager({ workspaceRoot: tmpDir, sessionsDir: path.join(tmpDir, 'sessions') });
    sessionManager.createSession('Initial task prompt');

    // Populate session with messages
    sessionManager.addMessage({ role: 'user', content: 'Step 1: start work' });
    sessionManager.addMessage({ role: 'assistant', content: 'Step 1: completed work on component A' });
    sessionManager.addMessage({ role: 'user', content: 'Step 2: start work on component B' });
    sessionManager.addMessage({ role: 'assistant', content: 'Step 2: completed work on component B' });
    sessionManager.addMessage({ role: 'user', content: 'Step 3: start work on component C' });
    sessionManager.addMessage({ role: 'assistant', content: 'Step 3: completed work on component C' });
    sessionManager.addMessage({ role: 'user', content: 'Step 4: start work on component D' });
    sessionManager.addMessage({ role: 'assistant', content: 'Step 4: completed work on component D' });

    // MockProvider replies:
    // First call: compaction summarizer
    // Second call: agent loop response
    const provider = new MockProvider('mock', [
      makeFiveSectionSummary(),
      'All tasks are now finished successfully.',
    ]);

    const task: TaskState = {
      threadId: 'th_agent_loop_test',
      workspaceRoot: tmpDir,
      goal: 'Complete all components A through D',
      acceptance: ['All components work correctly'],
      steps: [],
      currentStepIndex: 0,
      status: 'doing',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Set contextWindow small enough so threshold (60%) is exceeded:
    // Session messages character count is ~300 chars, so ~75 tokens.
    // contextWindow = 100 -> 75 / 100 = 75% > 60% threshold.
    const loop = new AgentLoop({
      config: { workspaceRoot: tmpDir } as any,
      provider,
      sessionManager,
      contextWindow: 100,
      task,
      model: 'mock-model',
    });

    const result = await loop.runTask('Continue with next steps');
    assert.strictEqual(result.status, 'completed');

    const finalMessages = sessionManager.requireSession().messages;

    // Check that compaction happened: summary message is present in history
    const summaryMsg = finalMessages.find((m) => m.content && m.content.includes('## Goal') && m.content.includes('## Completed steps'));
    assert.ok(summaryMsg, 'Session messages should contain compacted summary');
    assert.ok(summaryMsg.content.includes('Complete all components A through D'));
    assert.ok(summaryMsg.content.includes('All components work correctly'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('/compact command summarizes conversation and prints summary', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-cmd-compact-'));
  const oldFetch = globalThis.fetch;

  try {
    const summaryText = makeFiveSectionSummary();
    globalThis.fetch = async () => {
      const body = {
        choices: [{ message: { role: 'assistant', content: summaryText } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    defaultSessionManager.createSession('Test compact command');

    for (let i = 1; i <= 6; i++) {
      defaultSessionManager.addMessage({ role: i % 2 === 1 ? 'user' : 'assistant', content: `Message number ${i}` });
    }

    const ctx: CommandContext = {
      config: { workspaceRoot: tmpDir, defaultModel: 'ollama/gpt-oss:20b', activeProvider: 'ollama' } as any,
      workspaceRoot: tmpDir,
      tools: new ToolRegistry(),
      bus: new EventBus(),
      costTracker: new CostTracker(),
      runId: 'run_compact_test',
      signal: new AbortController().signal,
      session: {
        model: { provider: 'ollama', id: 'gpt-oss:20b', baseUrl: 'http://localhost:11434/v1', api: 'openai-completions' } as any,
        setModel() {},
      },
      ui: {
        print() {},
        ask: async () => '',
        confirm: async () => true,
        notify() {},
        status() {},
        clearStatus() {},
        promptInput: async () => '',
        showMenu: async () => '',
      },
    };

    const result = await compactCommand.run('', ctx);
    assert.ok(result);
    assert.strictEqual(result.kind, 'compact');
    assert.ok(result.text.includes('Conversation compacted successfully'));
    assert.ok(result.text.includes('## Goal'));
  } finally {
    globalThis.fetch = oldFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
