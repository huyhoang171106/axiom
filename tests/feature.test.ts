// tests/feature.test.ts - UC-04: multi-step feature implementation graph, task state, fail-closed verifier
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../src/core/event-bus.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { CommandUI } from '../src/core/execution-context.js';
import {
  runFeature,
  resumeTask,
  type FeatureOptions,
} from '../src/agents/feature.js';
import {
  canonicalWorkspace,
  listTasks,
  loadTaskState,
  saveTaskState,
  taskDir,
  type TaskState,
} from '../src/core/task-state.js';
import { extractPatchPaths } from '../src/core/agent-loop.js';
import { featureCommand } from '../src/commands/feature.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { CommandContext } from '../src/commands/types.js';

function setupEnvironment() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-feature-home-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-feature-ws-'));
  process.env.AXIOM_HOME = home;
  return { home, workspace };
}

function fakeUI(opts: { confirm?: boolean; ask?: string } = {}): CommandUI & { asked: string[]; confirmed: string[] } {
  const asked: string[] = [];
  const confirmed: string[] = [];
  return {
    asked,
    confirmed,
    print() {},
    async ask(q) {
      asked.push(q);
      return opts.ask ?? 'yes';
    },
    async confirm(q) {
      confirmed.push(q);
      return opts.confirm ?? true;
    },
  };
}

const samplePlan = {
  goal: 'Implement Table.count_where',
  constraints: ['Zero dependencies', 'Preserve backward compatibility'],
  acceptance: ['Table.count_where returns number of matching documents'],
  steps: [
    { title: 'Step 1: Inspect Table implementation', files: ['tinydb/table.py'] },
    { title: 'Step 2: Add count_where method signature', files: ['tinydb/table.py'] },
    { title: 'Step 3: Implement query filtering count', files: ['tinydb/table.py'] },
    { title: 'Step 4: Verify with test suite', files: ['tests/test_table.py'] },
  ],
};

function createPlanResponse() {
  return {
    content: '',
    toolCalls: [
      {
        id: 'call_plan_1',
        name: 'submit_plan',
        arguments: { plan: samplePlan },
      },
    ],
  };
}

test('a 4-step plan runs every step and ends completed', async () => {
  const { workspace } = setupEnvironment();
  const provider = new MockProvider('mock', [
    createPlanResponse(),
    'Step 1 finished.',
    'Step 2 finished.',
    'Step 3 finished.',
    'Step 4 finished.',
  ]);

  const bus = new EventBus();
  const tools = new ToolRegistry();
  const ui = fakeUI({ confirm: true });

  const report = await runFeature('Add Table.count_where', {
    workspaceRoot: workspace,
    provider,
    model: 'mock-model',
    bus,
    tools,
    ui,
    verifier: async () => ({ ok: true }),
  });

  assert.equal(report.status, 'completed');
  assert.equal(report.steps.length, 4);
  assert.equal(report.steps.every((s) => s.status === 'done'), true);
  assert.match(report.summary, /completed successfully across all 4 steps/i);
});

test('task_state.json reflects todo, doing, done in order', async () => {
  const { workspace } = setupEnvironment();
  const provider = new MockProvider('mock', [
    createPlanResponse(),
    'Step 1 finished.',
    'Step 2 finished.',
    'Step 3 finished.',
    'Step 4 finished.',
  ]);

  const observedStatuses: string[][] = [];

  const report = await runFeature('Add Table.count_where', {
    workspaceRoot: workspace,
    provider,
    model: 'mock-model',
    bus: new EventBus(),
    tools: new ToolRegistry(),
    ui: fakeUI({ confirm: true }),
    verifier: async (step, context) => {
      // Trong lúc verifier chạy, bước hiện tại phải đang có trạng thái 'doing' trên đĩa
      const state = context.threadId ? loadTaskState(context.threadId) : null;
      if (state) {
        observedStatuses.push(state.steps.map((s) => s.status));
      }
      return { ok: true };
    },
  });

  assert.equal(report.status, 'completed');
  // Bước 1 đang doing, các bước sau còn todo
  assert.deepEqual(observedStatuses[0], ['doing', 'todo', 'todo', 'todo']);
  // Bước 2 đang doing, bước 1 đã done, các bước sau còn todo
  assert.deepEqual(observedStatuses[1], ['done', 'doing', 'todo', 'todo']);
  // Bước 3 đang doing
  assert.deepEqual(observedStatuses[2], ['done', 'done', 'doing', 'todo']);
  // Bước 4 đang doing
  assert.deepEqual(observedStatuses[3], ['done', 'done', 'done', 'doing']);

  // Sau khi hoàn thành, toàn bộ 4 bước là done
  const finalState = loadTaskState(report.threadId);
  assert.ok(finalState);
  assert.deepEqual(
    finalState.steps.map((s) => s.status),
    ['done', 'done', 'done', 'done']
  );
});

test('answering no at approve runs no step', async () => {
  const { workspace } = setupEnvironment();
  const provider = new MockProvider('mock', [
    createPlanResponse(),
    'Should never be reached.',
  ]);

  let verifierCalled = false;
  const report = await runFeature('Add Table.count_where', {
    workspaceRoot: workspace,
    provider,
    model: 'mock-model',
    bus: new EventBus(),
    tools: new ToolRegistry(),
    ui: fakeUI({ confirm: false }),
    verifier: async () => {
      verifierCalled = true;
      return { ok: true };
    },
  });

  assert.equal(report.status, 'rejected');
  assert.equal(verifierCalled, false);
  assert.equal(report.steps.every((s) => s.status === 'todo'), true);
  const logFile = path.join(taskDir(report.threadId), 'progress.log');
  assert.equal(fs.existsSync(logFile), false);
});

test('a failed step stops the graph with status failed', async () => {
  const { workspace } = setupEnvironment();
  const provider = new MockProvider('mock', [
    createPlanResponse(),
    'Step 1 finished.',
    'Step 2 failed verification.',
  ]);

  const report = await runFeature('Add Table.count_where', {
    workspaceRoot: workspace,
    provider,
    model: 'mock-model',
    bus: new EventBus(),
    tools: new ToolRegistry(),
    ui: fakeUI({ confirm: true }),
    verifier: async (step) => {
      if (step.id === 2) return { ok: false, reason: 'Query parsing syntax error' };
      return { ok: true };
    },
  });

  assert.equal(report.status, 'failed');
  assert.equal(report.steps[0].status, 'done');
  assert.equal(report.steps[1].status, 'failed');
  assert.equal(report.steps[1].note, 'Query parsing syntax error');
  assert.equal(report.steps[2].status, 'todo');
  assert.equal(report.steps[3].status, 'todo');
  assert.match(report.summary, /failed at step 2/i);
});

test('progress.log has one line per step', async () => {
  const { workspace } = setupEnvironment();
  const provider = new MockProvider('mock', [
    createPlanResponse(),
    'Step 1 finished.',
    'Step 2 finished.',
    'Step 3 finished.',
    'Step 4 finished.',
  ]);

  const report = await runFeature('Add Table.count_where', {
    workspaceRoot: workspace,
    provider,
    model: 'mock-model',
    bus: new EventBus(),
    tools: new ToolRegistry(),
    ui: fakeUI({ confirm: true }),
    verifier: async () => ({ ok: true }),
  });

  assert.equal(report.status, 'completed');
  const logFile = path.join(taskDir(report.threadId), 'progress.log');
  assert.ok(fs.existsSync(logFile));
  const lines = fs
    .readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0);

  assert.equal(lines.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.match(lines[i], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z step \d+ done: /);
  }
});

test('task state persists canonical workspace identity and rejects foreign workspace', async () => {
  const { workspace: ws1 } = setupEnvironment();
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-foreign-ws-'));

  const state: TaskState = {
    threadId: 'feature-identity-check',
    workspaceRoot: canonicalWorkspace(ws1),
    goal: 'Cross-repo guard check',
    constraints: [],
    acceptance: ['Never run across repositories'],
    steps: [{ id: 1, title: 'Step 1', files: [], status: 'todo' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  saveTaskState(state);

  const foundWs1 = listTasks(ws1);
  assert.equal(foundWs1.some((t) => t.threadId === 'feature-identity-check'), true);

  const foundWs2 = listTasks(ws2);
  assert.equal(foundWs2.some((t) => t.threadId === 'feature-identity-check'), false);

  await assert.rejects(
    async () => {
      await resumeTask('feature-identity-check', {
        workspaceRoot: ws2,
        provider: new MockProvider('mock'),
        model: 'mock-model',
        bus: new EventBus(),
        tools: new ToolRegistry(),
      });
    },
    /different workspace/
  );
});

test('step is fail-closed: fails if verifier does not pass even when model completes without error', async () => {
  const { workspace } = setupEnvironment();
  const provider = new MockProvider('mock', [
    createPlanResponse(),
    'Model asserts everything is done without checking.',
  ]);

  const report = await runFeature('Add Table.count_where', {
    workspaceRoot: workspace,
    provider,
    model: 'mock-model',
    bus: new EventBus(),
    tools: new ToolRegistry(),
    ui: fakeUI({ confirm: true }),
    verifier: async () => ({ ok: false, reason: 'Unit test failed: AssertionError' }),
  });

  assert.equal(report.status, 'failed');
  assert.equal(report.steps[0].status, 'failed');
  assert.equal(report.steps[0].note, 'Unit test failed: AssertionError');
});

test('feature report tracks files changed by write_file, edit, and apply_patch', async () => {
  const patch = [
    '--- a/tinydb/table.py',
    '+++ b/tinydb/table.py',
    '@@ -1,3 +1,3 @@',
    '-old',
    '+new',
    '--- /dev/null',
    '+++ b/tinydb/utils.py',
    '@@ -0,0 +1,1 @@',
    '+helper',
  ].join('\n');

  const extracted = extractPatchPaths(patch);
  assert.deepEqual(extracted.sort(), ['tinydb/table.py', 'tinydb/utils.py'].sort());
});

test('feature command resolves @code and runs feature workflow', async () => {
  const { workspace } = setupEnvironment();

  const ctx: CommandContext = {
    workspaceRoot: workspace,
    config: {
      ...DEFAULT_CONFIG,
      activeProvider: 'mock',
    },
    tools: new ToolRegistry(),
    bus: new EventBus(),
    costTracker: new CostTracker(),
    runId: 'test-run-id',
    signal: new AbortController().signal,
    ui: fakeUI({ confirm: true, ask: 'Add Table.count_where' }),
    session: {
      model: { id: 'mock-model', provider: 'mock', name: 'Mock' } as never,
      setModel() {},
    },
  };

  const result = await featureCommand.run('Add Table.count_where', ctx);
  assert.ok(result);
  assert.equal(result.kind, 'feature-report');
  assert.ok(result.text.length > 0);
});
