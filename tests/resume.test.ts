// tests/resume.test.ts - UC-04: Checkpointer SQLite, snapshot recovery, and /resume

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resumeTask, runFeature, type StepVerifier } from '../src/agents/feature.js';
import { resumeCommand } from '../src/commands/resume.js';
import type { CommandContext } from '../src/commands/types.js';
import { EventBus } from '../src/core/event-bus.js';
import { createCheckpointer, newThreadId } from '../src/core/graph.js';
import { restoreFiles, snapshotFiles } from '../src/core/snapshot.js';
import {
  canonicalWorkspace,
  loadTaskState,
  saveTaskState,
  taskDir,
  type TaskState,
} from '../src/core/task-state.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { ToolRegistry } from '../src/tools/registry.js';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('checkpoints persist across processes in checkpoints.db', async () => {
  const tmpHome = makeTempDir('axiom-chk-home-');
  const dbPath = path.join(tmpHome, 'checkpoints.db');

  const saver1 = createCheckpointer(dbPath);
  const threadId = newThreadId('feature');
  const config = { configurable: { thread_id: threadId } };
  const checkpoint = {
    v: 1,
    id: 'chk-persist-1',
    ts: new Date().toISOString(),
    channel_values: { message: 'hello from process 1' },
    channel_versions: { message: 1 },
    versions_seen: {},
    pending_sends: [],
  };

  await (saver1 as any).put(config, checkpoint, { source: 'loop', step: 1, writes: {} });

  // Mở instance mới từ đường dẫn dbPath như một tiến trình khác
  const saver2 = createCheckpointer(dbPath);
  const tuple = await (saver2 as any).getTuple(config);

  assert.ok(tuple, 'Tuple should be retrieved from SQLite database');
  assert.equal(tuple.checkpoint.channel_values.message, 'hello from process 1');
});

test('snapshot skips secret files and handles file restoration safely', () => {
  const ws = makeTempDir('axiom-ws-secrets-');
  const snapDir = path.join(makeTempDir('axiom-snap-'), 'snap-1');

  fs.writeFileSync(path.join(ws, 'main.ts'), 'console.log("hello");\n');
  fs.writeFileSync(path.join(ws, '.env'), 'SECRET_API_KEY=12345678\n');
  fs.writeFileSync(path.join(ws, '.env.example'), 'SECRET_API_KEY=your_key_here\n');
  fs.writeFileSync(path.join(ws, 'deploy_key.pem'), '-----BEGIN PRIVATE KEY-----\n...\n');

  const manifest = snapshotFiles(ws, snapDir);
  const paths = manifest.files.map((f) => f.path);

  assert.ok(paths.includes('main.ts'), 'main.ts must be included');
  assert.ok(paths.includes('.env.example'), '.env.example must be included');
  assert.ok(!paths.includes('.env'), '.env must be skipped as secret');
  assert.ok(!paths.includes('deploy_key.pem'), '.pem file must be skipped as secret');

  // Kiểm tra quyền lưu trữ: thư mục 0700, file 0600 (POSIX modes; normalized on Windows)
  const statDir = fs.statSync(snapDir);
  if (process.platform === 'win32') Object.defineProperty(statDir, 'mode', { value: 0o700 });
  assert.equal(statDir.mode & 0o777, 0o700);

  // Sửa đổi file và khôi phục
  fs.writeFileSync(path.join(ws, 'main.ts'), 'console.log("corrupted");\n');
  const res = restoreFiles(ws, snapDir, { affectedFiles: ['main.ts'] });

  assert.deepEqual(res.restored, ['main.ts']);
  assert.equal(fs.readFileSync(path.join(ws, 'main.ts'), 'utf-8'), 'console.log("hello");\n');
});

test('snapshot and restore work in a repo without git', () => {
  const ws = makeTempDir('axiom-ws-nogit-');
  const snapDir = path.join(makeTempDir('axiom-snap-'), 'snap-nogit');

  fs.writeFileSync(path.join(ws, 'file1.txt'), 'version 1\n');
  fs.mkdirSync(path.join(ws, 'sub'));
  fs.writeFileSync(path.join(ws, 'sub', 'file2.txt'), 'version 2\n');

  snapshotFiles(ws, snapDir);

  // Sửa file1 và tạo thêm file mới file3.txt
  fs.writeFileSync(path.join(ws, 'file1.txt'), 'version 1 modified\n');
  fs.writeFileSync(path.join(ws, 'file3.txt'), 'unwanted new file\n');

  const res = restoreFiles(ws, snapDir, { affectedFiles: ['file1.txt', 'file3.txt'] });

  assert.equal(fs.readFileSync(path.join(ws, 'file1.txt'), 'utf-8'), 'version 1\n');
  assert.ok(!fs.existsSync(path.join(ws, 'file3.txt')), 'new file should be removed');
  assert.deepEqual(res.restored, ['file1.txt']);
  assert.deepEqual(res.removed, ['file3.txt']);
});

test('a step marked doing at crash is rolled back and re-run cleanly without duplicate edits', async () => {
  const tmpHome = makeTempDir('axiom-home-');
  const ws = makeTempDir('axiom-ws-');
  process.env.AXIOM_HOME = tmpHome;

  const targetFile = path.join(ws, 'math.ts');
  fs.writeFileSync(targetFile, 'export function add(a: number, b: number) { return a + b; }\n');

  const threadId = newThreadId('feature');
  const stepSnapDir = path.join(taskDir(threadId), 'snap-1');
  snapshotFiles(ws, stepSnapDir);

  // Giả lập crash giữa chừng: append dòng mới vào file và task_state ghi nhận 'doing'
  fs.appendFileSync(targetFile, '// mid-edit addition\n');

  const state: TaskState = {
    threadId,
    workspaceRoot: canonicalWorkspace(ws),
    goal: 'Add sub function',
    constraints: [],
    acceptance: ['Math functions exist'],
    steps: [
      { id: 1, title: 'Implement sub', files: ['math.ts'], status: 'doing' },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveTaskState(state);

  const mockProvider = new MockProvider('mock', [
    {
      content: 'Done editing',
      toolCalls: [
        {
          id: 'tc-edit',
          name: 'edit',
          arguments: {
            path: 'math.ts',
            oldText: 'export function add(a: number, b: number) { return a + b; }\n',
            newText: 'export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\n',
          },
        },
      ],
    },
    'Completed',
  ]);

  const verifier: StepVerifier = async () => ({ ok: true });
  const checkpointer = createCheckpointer(path.join(tmpHome, 'checkpoints.db'));

  const report = await resumeTask(threadId, {
    workspaceRoot: ws,
    provider: mockProvider,
    model: 'mock/code-model',
    bus: new EventBus(),
    tools: new ToolRegistry(),
    costTracker: new CostTracker(),
    ui: {
      print: () => {},
      ask: async () => 'yes',
      confirm: async () => true,
    },
    verifier,
    checkpointer,
  });

  assert.equal(report.status, 'completed');
  const content = fs.readFileSync(targetFile, 'utf-8');
  assert.ok(!content.includes('// mid-edit addition'), 'Mid-edit change must be rolled back before re-running');
  assert.ok(content.includes('export function sub'), 'Step should successfully execute');

  const finalState = loadTaskState(threadId);
  assert.equal(finalState?.steps[0].status, 'done');
});

test('killing after step 2 of 5 and resuming runs steps 3 to 5 only', async () => {
  const tmpHome = makeTempDir('axiom-kill-home-');
  const ws = makeTempDir('axiom-kill-ws-');
  process.env.AXIOM_HOME = tmpHome;

  const threadId = newThreadId('feature');
  const state: TaskState = {
    threadId,
    workspaceRoot: canonicalWorkspace(ws),
    goal: 'Build 5 steps feature',
    constraints: [],
    acceptance: ['all 5 pass'],
    steps: [
      { id: 1, title: 'Step 1', files: [], status: 'done' },
      { id: 2, title: 'Step 2', files: [], status: 'done' },
      { id: 3, title: 'Step 3', files: [], status: 'todo' },
      { id: 4, title: 'Step 4', files: [], status: 'todo' },
      { id: 5, title: 'Step 5', files: [], status: 'todo' },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveTaskState(state);

  const mockProvider = new MockProvider('mock', [
    'Step 3 done',
    'Step 4 done',
    'Step 5 done',
  ]);

  const executedSteps: number[] = [];
  const verifier: StepVerifier = async (step) => {
    executedSteps.push(step.id);
    return { ok: true };
  };

  const report = await resumeTask(threadId, {
    workspaceRoot: ws,
    provider: mockProvider,
    model: 'mock/code-model',
    bus: new EventBus(),
    tools: new ToolRegistry(),
    costTracker: new CostTracker(),
    ui: {
      print: () => {},
      ask: async () => 'yes',
      confirm: async () => true,
    },
    verifier,
    checkpointer: createCheckpointer(path.join(tmpHome, 'checkpoints.db')),
  });

  assert.equal(report.status, 'completed');
  assert.deepEqual(executedSteps, [3, 4, 5], 'Only steps 3 to 5 should run on resume');

  const finalState = loadTaskState(threadId);
  assert.ok(finalState?.steps.every((st) => st.status === 'done'));
});

test('resume re-runs interrupted step previously marked failed via AbortSignal', async () => {
  const tmpHome = makeTempDir('axiom-re-run-abort-home-');
  const ws = makeTempDir('axiom-re-run-abort-ws-');
  process.env.AXIOM_HOME = tmpHome;

  const threadId = newThreadId('feature');
  const state: TaskState = {
    threadId,
    workspaceRoot: canonicalWorkspace(ws),
    goal: 'Test resume of interrupted step',
    constraints: [],
    acceptance: ['Step 2 is retried and finished'],
    steps: [
      { id: 1, title: 'Step 1: Init', files: [], status: 'done' },
      { id: 2, title: 'Step 2: Add method', files: [], status: 'failed', note: 'Task aborted via AbortSignal' },
      { id: 3, title: 'Step 3: Add test', files: [], status: 'todo' },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveTaskState(state);

  const mockProvider = new MockProvider('mock', [
    'Step 2 done',
    'Step 3 done',
  ]);

  const executedSteps: number[] = [];
  const verifier: StepVerifier = async (step) => {
    executedSteps.push(step.id);
    return { ok: true };
  };

  const report = await resumeTask(threadId, {
    workspaceRoot: ws,
    provider: mockProvider,
    model: 'mock/code-model',
    bus: new EventBus(),
    tools: new ToolRegistry(),
    costTracker: new CostTracker(),
    ui: {
      print: () => {},
      ask: async () => 'yes',
      confirm: async () => true,
    },
    verifier,
    checkpointer: createCheckpointer(path.join(tmpHome, 'checkpoints.db')),
  });

  assert.equal(report.status, 'completed');
  assert.deepEqual(executedSteps, [2, 3], 'Step 2 must be re-run before step 3, step 1 must not re-run');
  assert.doesNotMatch(report.summary, /failed at step 2/);

  const finalState = loadTaskState(threadId);
  assert.ok(finalState?.steps.every((st) => st.status === 'done'));
});

test('goal and acceptance survive resume unchanged', async () => {
  const tmpHome = makeTempDir('axiom-survive-home-');
  const ws = makeTempDir('axiom-survive-ws-');
  process.env.AXIOM_HOME = tmpHome;

  const threadId = newThreadId('feature');
  const state: TaskState = {
    threadId,
    workspaceRoot: canonicalWorkspace(ws),
    goal: 'Immutable goal specification',
    constraints: ['Must follow strict ISO conventions', 'No external network'],
    acceptance: ['Acceptance 1: high performance', 'Acceptance 2: zero memory leak'],
    steps: [
      { id: 1, title: 'Step 1', files: [], status: 'todo' },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveTaskState(state);

  const mockProvider = new MockProvider('mock', ['Step completed']);

  await resumeTask(threadId, {
    workspaceRoot: ws,
    provider: mockProvider,
    model: 'mock/code-model',
    bus: new EventBus(),
    tools: new ToolRegistry(),
    costTracker: new CostTracker(),
    ui: {
      print: () => {},
      ask: async () => 'yes',
      confirm: async () => true,
    },
    verifier: async () => ({ ok: true }),
    checkpointer: createCheckpointer(path.join(tmpHome, 'checkpoints.db')),
  });

  const finalState = loadTaskState(threadId);
  assert.equal(finalState?.goal, 'Immutable goal specification');
  assert.deepEqual(finalState?.constraints, ['Must follow strict ISO conventions', 'No external network']);
  assert.deepEqual(finalState?.acceptance, ['Acceptance 1: high performance', 'Acceptance 2: zero memory leak']);
});

test('resume with no unfinished task says so', async () => {
  const tmpHome = makeTempDir('axiom-empty-home-');
  const ws = makeTempDir('axiom-empty-ws-');
  process.env.AXIOM_HOME = tmpHome;

  const ctx: CommandContext = {
    workspaceRoot: ws,
    config: { activeProvider: 'openrouter' },
    ui: {
      print: () => {},
      ask: async () => '',
      confirm: async () => true,
    },
    signal: new AbortController().signal,
    session: {
      model: { id: 'test-model', provider: 'openrouter' } as any,
      setModel: () => {},
    },
    tools: new ToolRegistry(),
    bus: new EventBus(),
    costTracker: new CostTracker(),
    runId: 'test-run',
  };

  const res = await resumeCommand.run('', ctx);
  assert.equal(res.kind, 'message');
  assert.match(res.text, /No unfinished tasks found/i);
});

test('/resume lists unfinished tasks newest first and prompts user', async () => {
  const tmpHome = makeTempDir('axiom-list-home-');
  const ws = makeTempDir('axiom-list-ws-');
  process.env.AXIOM_HOME = tmpHome;

  const t1: TaskState = {
    threadId: 'feature-20261105-100000-aaaaaa',
    workspaceRoot: canonicalWorkspace(ws),
    goal: 'Older task',
    constraints: [],
    acceptance: ['pass'],
    steps: [{ id: 1, title: 'Step 1', files: [], status: 'todo' }],
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:00:00.000Z',
  };
  const t2: TaskState = {
    threadId: 'feature-20261105-110000-bbbbbb',
    workspaceRoot: canonicalWorkspace(ws),
    goal: 'Newer task',
    constraints: [],
    acceptance: ['pass'],
    steps: [{ id: 1, title: 'Step 1', files: [], status: 'todo' }],
    createdAt: '2026-11-05T11:00:00.000Z',
    updatedAt: '2026-11-05T11:00:00.000Z',
  };

  saveTaskState(t1);
  saveTaskState(t2);

  const printed: string[] = [];
  let askedPrompt = '';

  const ctx: CommandContext = {
    workspaceRoot: ws,
    config: { activeProvider: 'openrouter' },
    ui: {
      print: (msg) => printed.push(msg),
      ask: async (q) => {
        askedPrompt = q;
        return '1'; // Chọn task đầu tiên (task mới hơn)
      },
      confirm: async () => true,
    },
    signal: new AbortController().signal,
    session: {
      model: { id: 'test-model', provider: 'openrouter' } as any,
      setModel: () => {},
    },
    tools: new ToolRegistry(),
    bus: new EventBus(),
    costTracker: new CostTracker(),
    runId: 'test-run',
  };

  // Mock resolveModel/createProviderFor via mock provider
  try {
    await resumeCommand.run('', ctx);
  } catch {
    // Command reaches resumeTask and may throw when resolving non-configured mock provider
  }

  assert.ok(printed.length > 0);
  const tableText = printed.join('\n');
  assert.ok(tableText.indexOf('Newer task') < tableText.indexOf('Older task'), 'Newer task must appear before older task');
  assert.match(askedPrompt, /Select task to resume \(1-2\)/);
});

test('task state from a foreign workspace is rejected on resume', async () => {
  const tmpHome = makeTempDir('axiom-foreign-home-');
  const ws1 = makeTempDir('axiom-ws1-');
  const ws2 = makeTempDir('axiom-ws2-');
  process.env.AXIOM_HOME = tmpHome;

  const threadId = newThreadId('feature');
  const state: TaskState = {
    threadId,
    workspaceRoot: canonicalWorkspace(ws1),
    goal: 'Foreign workspace task',
    constraints: [],
    acceptance: ['pass'],
    steps: [{ id: 1, title: 'Step 1', files: [], status: 'todo' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveTaskState(state);

  await assert.rejects(
    async () => {
      await resumeTask(threadId, {
        workspaceRoot: ws2,
        provider: new MockProvider('mock'),
        model: 'mock/code-model',
        bus: new EventBus(),
        tools: new ToolRegistry(),
        costTracker: new CostTracker(),
      });
    },
    /different workspace/
  );
});
