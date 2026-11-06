// evals/uc04/run.ts - Runner for UC-04 (multi-step features, resume, compaction, memory)
import fs from 'node:fs';
import path from 'node:path';
import { runFeature, resumeTask, type FeatureOptions } from '../../src/agents/feature.js';
import { loadCatalog } from '../../src/llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../../src/llm/model-resolver.js';
import { hasProvider } from '../uc01/cases.js';
import { MockProvider } from '../../src/llm/providers/mock.js';
import { measureCase } from '../measure.js';
import type { UcCaseResult, UcResult, UcRunner, UcRunOptions } from '../types.js';
import type { CaseProvenance, EvidencedUcResult } from '../evidence.js';
import { createCheckpointer, newThreadId } from '../../src/core/graph.js';
import { EventBus } from '../../src/core/event-bus.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { compactHistory, missingSections } from '../../src/core/compaction.js';
import { addMemory, loadMemory } from '../../src/core/memory.js';
import { buildSystemPrompt } from '../../src/core/prompt.js';
import {
  canonicalWorkspace,
  loadTaskState,
  saveTaskState,
  type TaskState,
} from '../../src/core/task-state.js';
import {
  copyWorkspace,
  gradeFeature,
  loadFeatureCase,
  UC04_CASE_IDS,
} from './cases.js';

export const runUc04: UcRunner = async ({ mock, config, workDir }: UcRunOptions) => {
  const catalog = loadCatalog();
  const info = mock ? undefined : resolveModel('@code', catalog, config);
  if (info && !hasProvider(config, info, catalog)) {
    throw new Error(`UC 04: provider ${info.provider} is not set up; run /login or pass --mock`);
  }

  const cases: UcCaseResult[] = [];
  const provenance: CaseProvenance = {
    mock,
    models: [
      {
        provider: info?.provider ?? 'mock',
        model: info?.id ?? 'mock-code',
        role: 'code',
      },
    ],
  };

  // Helper tạo mock provider cho từng feature khi chạy mock mode
  function createMockStraightProvider(ws: string) {
    return new MockProvider('mock', [
      {
        content: '',
        toolCalls: [
          {
            id: 'call_plan',
            name: 'submit_plan',
            arguments: {
              plan: {
                goal: 'Implement Table and TinyDB count_where',
                constraints: ['Preserve backward compatibility'],
                acceptance: ['Table.count_where returns document count'],
                steps: [
                  { title: 'Step 1: Inspect table.py', files: ['tinydb/table.py'] },
                  { title: 'Step 2: Add count_where to table.py', files: ['tinydb/table.py'] },
                  { title: 'Step 3: Add count_where to database.py', files: ['tinydb/database.py'] },
                  { title: 'Step 4: Update __init__.py export', files: ['tinydb/__init__.py'] },
                ],
              },
            },
          },
        ],
      },
      // Step 1
      'Step 1 inspected.',
      // Step 2
      {
        content: '',
        toolCalls: [
          {
            id: 'call_edit_1',
            name: 'edit',
            arguments: {
              path: 'tinydb/table.py',
              oldText: '        return len(self.search(cond))\n',
              newText:
                '        return len(self.search(cond))\n\n    def count_where(self, cond: QueryLike) -> int:\n        return self.count(cond)\n',
            },
          },
        ],
      },
      'Step 2 edit applied.',
      // Step 3
      {
        content: '',
        toolCalls: [
          {
            id: 'call_edit_2',
            name: 'edit',
            arguments: {
              path: 'tinydb/database.py',
              oldText: '        return len(self.table(self.default_table_name))\n',
              newText:
                '        return len(self.table(self.default_table_name))\n\n    def count_where(self, cond):\n        return self.table(self.default_table_name).count_where(cond)\n',
            },
          },
        ],
      },
      'Step 3 edit applied.',
      // Step 4
      {
        content: '',
        toolCalls: [
          {
            id: 'call_edit_3',
            name: 'edit',
            arguments: {
              path: 'tinydb/__init__.py',
              oldText: "('TinyDB', 'Storage', 'JSONStorage', 'Query', 'where')",
              newText: "('TinyDB', 'Storage', 'JSONStorage', 'Query', 'where', 'count_where')",
            },
          },
        ],
      },
      'Step 4 edit applied.',
    ]);
  }

  // 1. Case: uc04-straight (feat-01 một lèo)
  const straightCase = await measureCase('uc04-straight', async (tracker) => {
    const caseDir = path.join(workDir, 'uc04-straight');
    const ws = path.join(caseDir, 'workspace');
    const home = path.join(caseDir, 'home');
    copyWorkspace(ws);
    process.env.AXIOM_HOME = home;

    const feat = loadFeatureCase('feat-01');
    const provider = mock ? createMockStraightProvider(ws) : await createProviderFor(info!);
    const bus = new EventBus();
    const tools = new ToolRegistry();
    tools.allowWithoutApprover = true;

    const report = await runFeature(feat.request, {
      workspaceRoot: ws,
      provider,
      model: info?.id ?? 'mock-code',
      bus,
      tools,
      costTracker: tracker,
      ui: { print: () => {}, ask: async () => 'yes', confirm: async () => true },
    });

    const grade = await gradeFeature(ws, 'feat-01');
    const passed =
      report.status === 'completed' &&
      report.filesChanged.length >= feat.minFiles &&
      grade.passed;

    return {
      passed,
      metrics: {
        completed: report.status === 'completed',
        filesChangedCount: report.filesChanged.length,
        acceptancePassed: grade.acceptancePassed,
        regressionsCount: grade.regressions.length,
      },
    };
  });

  cases.push({
    id: 'uc04-straight',
    passed: straightCase.value?.passed ?? false,
    metrics: straightCase.value?.metrics ?? {},
    tokens: straightCase.tokens,
    costDollars: straightCase.costDollars,
    latencyMs: straightCase.latencyMs,
    ...(straightCase.error ? { error: straightCase.error } : {}),
  });

  // 2. Case: uc04-resume-1 (feat-02 ngắt sau bước 2 và resume)
  const resume1Case = await measureCase('uc04-resume-1', async (tracker) => {
    const caseDir = path.join(workDir, 'uc04-resume-1');
    const ws = path.join(caseDir, 'workspace');
    const home = path.join(caseDir, 'home');
    copyWorkspace(ws);
    process.env.AXIOM_HOME = home;

    const feat = loadFeatureCase('feat-02');
    const dbPath = path.join(home, 'checkpoints.db');
    const checkpointer = createCheckpointer(dbPath);

    const executedSteps: number[] = [];
    const threadId = newThreadId('feature');

    // Chạy các bước đầu và giả lập crash ở bước 3
    // Chuẩn bị trạng thái task đã xong bước 1 & 2
    const taskState: TaskState = {
      threadId,
      workspaceRoot: canonicalWorkspace(ws),
      goal: feat.name,
      constraints: ['Preserve backward compatibility'],
      acceptance: ['Table.search supports limit'],
      steps: [
        { id: 1, title: 'Step 1: Inspect search', files: ['tinydb/table.py'], status: 'done' },
        { id: 2, title: 'Step 2: Add limit parameter to Table.search', files: ['tinydb/table.py'], status: 'done' },
        { id: 3, title: 'Step 3: Add limit parameter to TinyDB.search', files: ['tinydb/database.py'], status: 'todo' },
        { id: 4, title: 'Step 4: Update docstring and verify', files: ['tinydb/__init__.py'], status: 'todo' },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveTaskState(taskState);

    // Áp dụng trước thay đổi của bước 2
    const tablePy = path.join(ws, 'tinydb/table.py');
    let tableCode = fs.readFileSync(tablePy, 'utf8');
    tableCode = tableCode.replace(
      'def search(self, cond: QueryLike) -> list[Document]:',
      'def search(self, cond: QueryLike, limit: Optional[int] = None) -> list[Document]:\n        if limit is not None and limit <= 0:\n            return []'
    );
    tableCode = tableCode.replace('return cached_results[:]', 'return cached_results[:limit] if limit is not None else cached_results[:]');
    tableCode = tableCode.replace('return docs', 'return docs[:limit] if limit is not None else docs');
    fs.writeFileSync(tablePy, tableCode, 'utf8');

    // Mock provider tiếp tục cho các bước 3 & 4 khi resume
    const resumeMockProvider = new MockProvider('mock', [
      {
        content: '',
        toolCalls: [
          {
            id: 'call_edit_res1',
            name: 'edit',
            arguments: {
              path: 'tinydb/database.py',
              edits: [
                {
                  oldText: '        return len(self.table(self.default_table_name))\n',
                  newText:
                    '        return len(self.table(self.default_table_name))\n\n    def search(self, cond, limit=None):\n        return self.table(self.default_table_name).search(cond, limit=limit)\n',
                },
              ],
            },
          },
        ],
      },
      'Step 3 completed on resume.',
      {
        content: '',
        toolCalls: [
          {
            id: 'call_edit_res2',
            name: 'edit',
            arguments: {
              path: 'tinydb/__init__.py',
              edits: [
                {
                  oldText: "('TinyDB', 'Storage', 'JSONStorage', 'Query', 'where')",
                  newText: "('TinyDB', 'Storage', 'JSONStorage', 'Query', 'where')\n# Search limit supported",
                },
              ],
            },
          },
        ],
      },
      'Step 4 completed on resume.',
    ]);

    const provider = mock ? resumeMockProvider : await createProviderFor(info!);
    const bus = new EventBus();
    const tools = new ToolRegistry();
    tools.allowWithoutApprover = true;

    // Chạy resume
    const report = await resumeTask(threadId, {
      workspaceRoot: ws,
      provider,
      model: info?.id ?? 'mock-code',
      bus,
      tools,
      costTracker: tracker,
      checkpointer,
      ui: { print: () => {}, ask: async () => 'yes', confirm: async () => true },
      verifier: async (step) => {
        executedSteps.push(step.id);
        return { ok: true };
      },
    });

    const grade = await gradeFeature(ws, 'feat-02');
    const stepsNotRerun = !executedSteps.includes(1) && !executedSteps.includes(2);
    const passed =
      report.status === 'completed' &&
      stepsNotRerun &&
      grade.passed;

    return {
      passed,
      metrics: {
        completed: report.status === 'completed',
        stepsNotRerun,
        executedStepsCount: executedSteps.length,
        acceptancePassed: grade.acceptancePassed,
        regressionsCount: grade.regressions.length,
      },
    };
  });

  cases.push({
    id: 'uc04-resume-1',
    passed: resume1Case.value?.passed ?? false,
    metrics: resume1Case.value?.metrics ?? {},
    tokens: resume1Case.tokens,
    costDollars: resume1Case.costDollars,
    latencyMs: resume1Case.latencyMs,
    ...(resume1Case.error ? { error: resume1Case.error } : {}),
  });

  // 3. Case: uc04-resume-2 (feat-03 ngắt 2 lần và hoàn tất)
  const resume2Case = await measureCase('uc04-resume-2', async (tracker) => {
    const caseDir = path.join(workDir, 'uc04-resume-2');
    const ws = path.join(caseDir, 'workspace');
    const home = path.join(caseDir, 'home');
    copyWorkspace(ws);
    process.env.AXIOM_HOME = home;

    const feat = loadFeatureCase('feat-03');
    const dbPath = path.join(home, 'checkpoints.db');
    const checkpointer = createCheckpointer(dbPath);

    const executedSteps: number[] = [];
    const threadId = newThreadId('feature');

    // Thiết lập trạng thái task với bước 1 và 2 đã xong qua 2 lần ngắt
    const taskState: TaskState = {
      threadId,
      workspaceRoot: canonicalWorkspace(ws),
      goal: feat.name,
      constraints: ['Zero dependencies'],
      acceptance: ['ReadOnlyMiddleware raises PermissionError on write'],
      steps: [
        { id: 1, title: 'Step 1: Add ReadOnlyMiddleware class', files: ['tinydb/middlewares.py'], status: 'done' },
        { id: 2, title: 'Step 2: Export in __init__.py', files: ['tinydb/__init__.py'], status: 'done' },
        { id: 3, title: 'Step 3: Document and verify storage integration', files: ['tinydb/storages.py'], status: 'todo' },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveTaskState(taskState);

    // Áp dụng trước thay đổi bước 1 và 2
    const midPy = path.join(ws, 'tinydb/middlewares.py');
    let midCode = fs.readFileSync(midPy, 'utf8');
    midCode += '\nclass ReadOnlyMiddleware(Middleware):\n    def write(self, data):\n        raise PermissionError("Cannot write to read-only storage")\n';
    fs.writeFileSync(midPy, midCode, 'utf8');

    const initPy = path.join(ws, 'tinydb/__init__.py');
    let initCode = fs.readFileSync(initPy, 'utf8');
    initCode = initCode.replace('from .database import TinyDB\n', 'from .database import TinyDB\nfrom .middlewares import ReadOnlyMiddleware\n');
    initCode = initCode.replace("('TinyDB', 'Storage', 'JSONStorage', 'Query', 'where')", "('TinyDB', 'Storage', 'JSONStorage', 'Query', 'where', 'ReadOnlyMiddleware')");
    fs.writeFileSync(initPy, initCode, 'utf8');

    // Mock provider hoàn tất bước 3
    const resumeMockProvider = new MockProvider('mock', [
      {
        content: '',
        toolCalls: [
          {
            id: 'call_edit_res3',
            name: 'edit',
            arguments: {
              path: 'tinydb/storages.py',
              edits: [
                {
                  oldText: 'class Storage(ABC):',
                  newText: '# ReadOnlyMiddleware supported\nclass Storage(ABC):',
                },
              ],
            },
          },
        ],
      },
      'Step 3 completed.',
    ]);

    const provider = mock ? resumeMockProvider : await createProviderFor(info!);
    const bus = new EventBus();
    const tools = new ToolRegistry();
    tools.allowWithoutApprover = true;

    const report = await resumeTask(threadId, {
      workspaceRoot: ws,
      provider,
      model: info?.id ?? 'mock-code',
      bus,
      tools,
      costTracker: tracker,
      checkpointer,
      ui: { print: () => {}, ask: async () => 'yes', confirm: async () => true },
      verifier: async (step) => {
        executedSteps.push(step.id);
        return { ok: true };
      },
    });

    const grade = await gradeFeature(ws, 'feat-03');
    const priorStepsNotRerun = !executedSteps.includes(1) && !executedSteps.includes(2);
    const passed =
      report.status === 'completed' &&
      priorStepsNotRerun &&
      grade.passed;

    return {
      passed,
      metrics: {
        completed: report.status === 'completed',
        priorStepsNotRerun,
        executedStepsCount: executedSteps.length,
        acceptancePassed: grade.acceptancePassed,
        regressionsCount: grade.regressions.length,
      },
    };
  });

  cases.push({
    id: 'uc04-resume-2',
    passed: resume2Case.value?.passed ?? false,
    metrics: resume2Case.value?.metrics ?? {},
    tokens: resume2Case.tokens,
    costDollars: resume2Case.costDollars,
    latencyMs: resume2Case.latencyMs,
    ...(resume2Case.error ? { error: resume2Case.error } : {}),
  });

  // 4. Case: uc04-compaction (context window nhỏ, nén giữ nguyên acceptance và 5 mục)
  const compactionCase = await measureCase('uc04-compaction', async () => {
    const goal = 'Implement Table.count_where method';
    const acceptance = [
      'Table.count_where returns number of matching documents',
      'TinyDB.count_where delegates to default table',
    ];
    const task: TaskState = {
      threadId: newThreadId('feature'),
      workspaceRoot: '/tmp/workspace',
      goal,
      constraints: ['Zero dependencies'],
      acceptance,
      steps: [
        { id: 1, title: 'Inspect', files: [], status: 'done' },
        { id: 2, title: 'Implement', files: [], status: 'doing' },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockSummary = [
      '## Goal',
      goal,
      '',
      '## Constraints',
      '- Zero dependencies',
      '',
      '## Completed steps',
      '- Step 1: Inspect',
      '',
      '## Current state',
      'Step 2: Implement in progress',
      '',
      '## Open risks and next step',
      'None',
    ].join('\n');

    const provider = new MockProvider('mock', [mockSummary]);
    const history = [
      { role: 'system' as const, content: 'You are Axiom.' },
      { role: 'user' as const, content: 'Please start step 1' },
      { role: 'assistant' as const, content: 'Step 1 is inspecting the files.' },
      { role: 'user' as const, content: 'Step 1 looks good, please start step 2' },
      { role: 'assistant' as const, content: 'Step 2 is implementing count_where.' },
      { role: 'user' as const, content: 'Please continue with step 3' },
      { role: 'assistant' as const, content: 'Step 3 is implementing delegation in database.' },
      { role: 'user' as const, content: 'Now please start step 4' },
      { role: 'assistant' as const, content: 'Step 4 is updating exports in __init__.' },
    ];

    const result = await compactHistory(history, {
      provider,
      model: 'mock-model',
      task,
    });

    const missing = missingSections(result.summary);
    const acceptancePreserved = acceptance.every((crit) => result.summary.includes(crit));
    const passed = missing.length === 0 && acceptancePreserved;

    return {
      passed,
      metrics: {
        missingSectionsCount: missing.length,
        acceptancePreserved,
      },
    };
  });

  cases.push({
    id: 'uc04-compaction',
    passed: compactionCase.value?.passed ?? false,
    metrics: compactionCase.value?.metrics ?? {},
    tokens: compactionCase.tokens,
    costDollars: compactionCase.costDollars,
    latencyMs: compactionCase.latencyMs,
    ...(compactionCase.error ? { error: compactionCase.error } : {}),
  });

  // 5. Case: uc04-memory (phiên 1 addMemory, phiên 2 kiểm system prompt và tuân thủ convention)
  const memoryCase = await measureCase('uc04-memory', async () => {
    const caseDir = path.join(workDir, 'uc04-memory');
    const ws = path.join(caseDir, 'workspace');
    const home = path.join(caseDir, 'home');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    process.env.AXIOM_HOME = home;

    const convention = 'Always add docstrings and type annotations to new public methods';

    // Phiên 1: Lưu memory
    addMemory(ws, convention);
    const savedMemory = loadMemory(ws);

    // Phiên 2: Kiểm tra system prompt
    const prompt = buildSystemPrompt('Base instructions.', ws);
    const memoryInPrompt =
      prompt.includes('# Project memory') &&
      prompt.includes(convention);

    const passed = savedMemory.includes(convention) && memoryInPrompt;

    return {
      passed,
      metrics: {
        memorySaved: savedMemory.includes(convention),
        memoryInPrompt,
      },
    };
  });

  cases.push({
    id: 'uc04-memory',
    passed: memoryCase.value?.passed ?? false,
    metrics: memoryCase.value?.metrics ?? {},
    tokens: memoryCase.tokens,
    costDollars: memoryCase.costDollars,
    latencyMs: memoryCase.latencyMs,
    ...(memoryCase.error ? { error: memoryCase.error } : {}),
  });

  // Tính summary metrics
  const featureCases = ['uc04-straight', 'uc04-resume-1', 'uc04-resume-2'];
  const passedFeatures = cases.filter((c) => featureCases.includes(c.id) && c.passed).length;
  const featurePassRate = passedFeatures / 3;
  const resumeOk =
    cases.find((c) => c.id === 'uc04-resume-1')?.passed &&
    cases.find((c) => c.id === 'uc04-resume-2')?.passed
      ? 1
      : 0;
  const compactionOk = cases.find((c) => c.id === 'uc04-compaction')?.passed ? 1 : 0;
  const memoryOk = cases.find((c) => c.id === 'uc04-memory')?.passed ? 1 : 0;

  const result: UcResult = {
    uc: '04',
    cases,
    summary: {
      featurePassRate,
      resumeOk,
      compactionOk,
      memoryOk,
    },
  };

  const evidenced: EvidencedUcResult = {
    ...result,
    cases: result.cases.map((c) => ({ ...c, provenance })),
    expectedCaseIds: [...UC04_CASE_IDS],
    gates: [
      {
        id: mock ? 'uc04-pipeline-smoke' : 'uc04-acceptance',
        passed: passesUc04(result, mock),
      },
    ],
  };

  return evidenced;
};

export function passesUc04(result: UcResult, mock: boolean): boolean {
  if (result.uc !== '04') return false;
  if (result.cases.length !== 5) return false;
  const ids = new Set(result.cases.map((c) => c.id));
  if (ids.size !== 5) return false;
  for (const id of UC04_CASE_IDS) {
    if (!ids.has(id)) return false;
  }
  const featureCases = ['uc04-straight', 'uc04-resume-1', 'uc04-resume-2'];
  const passedFeatures = result.cases.filter((c) => featureCases.includes(c.id) && c.passed).length;
  const featurePassRate = passedFeatures / 3;
  const resume1 = result.cases.find((c) => c.id === 'uc04-resume-1');
  const resume2 = result.cases.find((c) => c.id === 'uc04-resume-2');
  const compaction = result.cases.find((c) => c.id === 'uc04-compaction');
  const memory = result.cases.find((c) => c.id === 'uc04-memory');

  if (!resume1?.passed || !resume2?.passed || !compaction?.passed || !memory?.passed) return false;
  return featurePassRate >= (mock ? 1 : 2 / 3);
}
