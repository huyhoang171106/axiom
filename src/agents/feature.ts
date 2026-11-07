// src/agents/feature.ts - UC-04: plan, approve, then run steps one by one with a checkpoint after each

import fs from 'node:fs';
import path from 'node:path';
import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';
import { z } from 'zod';
import { AgentLoop } from '../core/agent-loop.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import type { CommandUI } from '../core/execution-context.js';
import type { EventBus } from '../core/event-bus.js';
import { createCheckpointer, newThreadId, traceNode } from '../core/graph.js';
import { askHuman, runGraph } from '../core/human-gate.js';
import { axiomHome } from '../core/paths.js';
import { buildSystemPrompt } from '../core/prompt.js';
import { SessionManager } from '../core/session.js';
import { snapshotFiles, restoreFiles } from '../core/snapshot.js';
import { addMemory } from '../core/memory.js';
import {
  appendProgress,
  canonicalWorkspace,
  listTasks,
  loadTaskState,
  saveTaskState,
  taskDir,
  type PlanStep,
  type TaskState,
} from '../core/task-state.js';
import { runPytest } from '../core/verifier.js';
import type { BaseLLMProvider } from '../llm/base-provider.js';
import { CostTracker } from '../llm/cost-tracker.js';
import { BaseTool } from '../tools/base-tool.js';
import type { ToolRegistry } from '../tools/registry.js';

export type StepVerifier = (
  step: PlanStep,
  context: { workspaceRoot: string; threadId?: string }
) => Promise<{ ok: boolean; reason?: string }>;

export interface FeatureOptions {
  workspaceRoot: string;
  provider: BaseLLMProvider;
  model: string;
  bus: EventBus;
  /** Session registry; every node takes `tools.scoped([...])`. */
  tools: ToolRegistry;
  /** Records every model call (eval tokens and cost per case); defaults to defaultCostTracker. */
  costTracker?: CostTracker;
  ui?: CommandUI;
  signal?: AbortSignal;
  checkpointer?: BaseCheckpointSaver;
  verifier?: StepVerifier;
}

export interface FeatureReport {
  threadId: string;
  status: 'completed' | 'failed' | 'aborted' | 'rejected';
  steps: PlanStep[];
  filesChanged: string[];
  summary: string;
  conventions?: string[];
}

export const planStepSchema = z.object({
  title: z.string().min(1, 'title must not be empty'),
  files: z.array(z.string()).default([]),
});

export const planSubmissionSchema = z.object({
  goal: z.string().min(1, 'goal must not be empty'),
  constraints: z.array(z.string()).default([]),
  acceptance: z.array(z.string().min(1)).min(1, 'at least one acceptance criterion'),
  steps: z
    .array(planStepSchema)
    .min(3, 'plan must have at least 3 steps')
    .max(7, 'plan must have at most 7 steps'),
});

export type PlanSubmission = z.infer<typeof planSubmissionSchema>;

export class SubmitPlanTool extends BaseTool {
  readonly name = 'submit_plan';
  readonly description = 'Submit the structured multi-step plan (3 to 7 steps) to implement the feature.';
  readonly parameters = {
    type: 'object',
    properties: {
      plan: { ...z.toJSONSchema(planSubmissionSchema), description: 'The planned feature steps' },
      goal: { type: 'string', description: 'Overall goal of the feature' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints to follow' },
      acceptance: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
          },
          required: ['title'],
        },
      },
    },
  };

  public submittedPlan?: PlanSubmission;
  public lastError?: string;

  constructor(private readonly onAccepted: (plan: PlanSubmission) => void) {
    super();
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const raw = typeof args['plan'] === 'object' && args['plan'] !== null ? args['plan'] : args;
    const parsed = planSubmissionSchema.safeParse(raw);
    if (!parsed.success) {
      this.lastError = parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ');
      return `Error: Plan schema invalid: ${this.lastError}. Revise and call submit_plan again.`;
    }
    this.submittedPlan = parsed.data;
    this.onAccepted(parsed.data);
    return 'Plan accepted. Proceeding to approval.';
  }
}

export const FEATURE_PLAN_SYSTEM_PROMPT = [
  'You are Axiom\'s feature planning agent. Formulate a 3 to 7 step plan to implement the feature request.',
  '1. Inspect the codebase first using read_file, list_dir, and search_code.',
  '2. Break down the implementation into 3 to 7 concrete, sequential steps.',
  '3. Provide clear acceptance criteria that can be verified with tests.',
  '4. Submit the final plan by calling submit_plan.',
].join('\n');

export const FEATURE_STEP_SYSTEM_PROMPT = [
  'You are Axiom, implementing a step of a planned feature.',
  '1. Inspect target files before editing.',
  '2. Make surgical edits to implement only what this step requires.',
  '3. Run tests or typechecks to verify your changes.',
  '4. When finished, summarize your changes concisely.',
].join('\n');

const FeatureState = Annotation.Root({
  request: Annotation<string>,
  threadId: Annotation<string>,
  taskState: Annotation<TaskState>,
  approved: Annotation<boolean>,
  error: Annotation<string | undefined>,
  filesChanged: Annotation<string[]>({
    reducer: (curr, update) => Array.from(new Set([...(curr ?? []), ...(update ?? [])])),
    default: () => [],
  }),
  conventions: Annotation<string[]>({
    reducer: (curr, update) => Array.from(new Set([...(curr ?? []), ...(update ?? [])])),
    default: () => [],
  }),
  finalReport: Annotation<FeatureReport>,
});

type FeatureStateType = typeof FeatureState.State;

const defaultCommandUI: CommandUI = {
  print() {},
  async ask() {
    throw new Error('Interactive input required but no UI provided');
  },
  async confirm() {
    return false;
  },
};

/** Builds the state graph for the feature workflow. */
export function buildFeatureWorkflow(
  opts: FeatureOptions,
  fallbackThreadId: string,
  request?: string
) {
  const planNode = async (s: FeatureStateType, config: { configurable?: { thread_id?: string } }) => {
    const activeThreadId = config?.configurable?.thread_id ?? s.threadId ?? fallbackThreadId;
    const diskState = loadTaskState(activeThreadId);
    if (diskState) return { threadId: activeThreadId, taskState: diskState };
    if (s.taskState) return { threadId: activeThreadId, taskState: s.taskState };

    const planController = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) planController.abort();
      else opts.signal.addEventListener('abort', () => planController.abort(), { once: true });
    }

    let acceptedPlan: PlanSubmission | undefined;
    const submitTool = new SubmitPlanTool((plan) => {
      acceptedPlan = plan;
      planController.abort();
    });

    const planTools = opts.tools.scoped(['read_file', 'list_dir', 'search_code', 'submit_plan']);
    planTools.registerTool(submitTool);

    const agent = new AgentLoop({
      config: { ...DEFAULT_CONFIG, workspaceRoot: opts.workspaceRoot },
      provider: opts.provider,
      toolRegistry: planTools,
      sessionManager: new SessionManager({
        workspaceRoot: opts.workspaceRoot,
        sessionsDir: path.join(axiomHome(), 'sessions'),
        autoSave: false,
      }),
      costTracker: opts.costTracker ?? new CostTracker(),
      eventBus: opts.bus,
      systemPrompt: buildSystemPrompt(FEATURE_PLAN_SYSTEM_PROMPT, opts.workspaceRoot),
      model: opts.model,
      maxSteps: 12,
      signal: planController.signal,
    });

    const result = await agent.runTask(s.request ?? request ?? '', planController.signal);
    if (!acceptedPlan && submitTool.submittedPlan) acceptedPlan = submitTool.submittedPlan;

    if (!acceptedPlan) {
      const errorMsg = submitTool.lastError ?? result.error ?? 'Planning failed: submit_plan was not called';
      return { threadId: activeThreadId, error: errorMsg };
    }

    const taskState: TaskState = {
      threadId: activeThreadId,
      workspaceRoot: canonicalWorkspace(opts.workspaceRoot),
      goal: acceptedPlan.goal,
      constraints: acceptedPlan.constraints ?? [],
      acceptance: acceptedPlan.acceptance,
      steps: acceptedPlan.steps.map((st, idx) => ({
        id: idx + 1,
        title: st.title,
        files: st.files ?? [],
        status: 'todo',
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    saveTaskState(taskState);
    return { threadId: activeThreadId, taskState };
  };

  const approveNode = async (s: FeatureStateType) => {
    if (s.approved !== undefined) return { approved: s.approved };
    if (s.error || !s.taskState) return { approved: false };
    const answer = askHuman('Duyệt kế hoạch?', ['yes', 'no']);
    return { approved: answer === 'yes' };
  };

  const stepNode = async (s: FeatureStateType, config: { configurable?: { thread_id?: string } }) => {
    const activeThreadId = config?.configurable?.thread_id ?? s.threadId ?? fallbackThreadId;
    const currentTaskState = loadTaskState(activeThreadId) ?? s.taskState;
    if (!currentTaskState) return { error: 'Missing task state in step node' };

    const step = currentTaskState.steps.find((st) => st.status === 'todo' || st.status === 'doing');
    if (!step) return {};

    // Kiểm soát side effects trong chế độ read-only: không sửa đổi workspace hoặc tạo snapshot khi chỉ đọc
    if (opts.tools.isReadOnly()) {
      step.status = 'failed';
      step.note = 'Cannot execute mutating steps in read-only mode.';
      currentTaskState.updatedAt = new Date().toISOString();
      saveTaskState(currentTaskState);
      appendProgress(currentTaskState.threadId, `step ${step.id} failed: read-only mode, mutation prevented`);
      return {
        taskState: currentTaskState,
        error: 'Cannot execute mutating steps in read-only mode.',
      };
    }

    // P7: Chụp snapshot files trước khi chuyển sang 'doing'
    const snapDir = path.join(taskDir(currentTaskState.threadId), `snap-${step.id}`);
    snapshotFiles(opts.workspaceRoot, snapDir);

    step.status = 'doing';
    currentTaskState.updatedAt = new Date().toISOString();
    saveTaskState(currentTaskState);

    const completed = currentTaskState.steps.filter((st) => st.status === 'done');
    const stepPrompt = [
      `Feature Goal: ${currentTaskState.goal}`,
      currentTaskState.constraints.length > 0 ? `Constraints:\n${currentTaskState.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      `Acceptance Criteria:\n${currentTaskState.acceptance.map((a) => `- ${a}`).join('\n')}`,
      completed.length > 0
        ? `Completed Steps:\n${completed.map((st) => `- Step ${st.id}: ${st.title} (done)`).join('\n')}`
        : '',
      `Current Step (${step.id}/${currentTaskState.steps.length}): ${step.title}`,
      step.files.length > 0 ? `Target Files: ${step.files.join(', ')}` : '',
      'Implement this step. Modify files as needed and verify your changes.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const stepTools = opts.tools.scoped([
      'read_file',
      'search_code',
      'list_dir',
      'edit',
      'write_file',
      'apply_patch',
      'run_tests',
    ]);

    const agent = new AgentLoop({
      config: { ...DEFAULT_CONFIG, workspaceRoot: opts.workspaceRoot },
      provider: opts.provider,
      toolRegistry: stepTools,
      sessionManager: new SessionManager({
        workspaceRoot: opts.workspaceRoot,
        sessionsDir: path.join(axiomHome(), 'sessions'),
        autoSave: false,
      }),
      costTracker: opts.costTracker ?? new CostTracker(),
      eventBus: opts.bus,
      systemPrompt: buildSystemPrompt(FEATURE_STEP_SYSTEM_PROMPT, opts.workspaceRoot),
      model: opts.model,
      maxSteps: 20,
      signal: opts.signal,
    });

    const loopResult = await agent.runTask(stepPrompt, opts.signal);

    // Verifier seam fail-closed: bước chỉ hoàn tất khi verifier xác nhận đạt
    let stepOk = false;
    let failReason: string | undefined;

    if (loopResult.status === 'completed') {
      if (opts.verifier) {
        try {
          const v = await opts.verifier(step, { workspaceRoot: opts.workspaceRoot, threadId: currentTaskState.threadId });
          stepOk = v.ok;
          failReason = v.reason;
        } catch (err) {
          stepOk = false;
          failReason = err instanceof Error ? err.message : String(err);
        }
      } else {
        // Default verifier gọi runPytest trong sandbox; fail-closed nếu lỗi hoặc chưa cài
        try {
          const testRun = await runPytest(opts.workspaceRoot, { signal: opts.signal });
          stepOk = testRun.exitCode === 0 && testRun.failed.length === 0 && !testRun.timedOut;
          if (!stepOk) {
            failReason = `Pytest verification failed (exitCode=${testRun.exitCode}, failed=${testRun.failed.length})`;
          }
        } catch (err) {
          stepOk = false;
          failReason = err instanceof Error ? err.message : String(err);
        }
      }
    } else {
      stepOk = false;
      failReason = loopResult.error ?? `Agent loop finished with status: ${loopResult.status}`;
    }

    if (stepOk) {
      step.status = 'done';
      step.note = undefined;
    } else {
      step.status = 'failed';
      step.note = failReason ?? 'Verification failed';
    }

    currentTaskState.updatedAt = new Date().toISOString();
    saveTaskState(currentTaskState);
    appendProgress(currentTaskState.threadId, `step ${step.id} ${step.status}: ${step.title}`);

    return {
      taskState: currentTaskState,
      filesChanged: loopResult.filesChanged,
    };
  };

  const reportNode = async (s: FeatureStateType, config: { configurable?: { thread_id?: string } }) => {
    const activeThreadId = config?.configurable?.thread_id ?? s.threadId ?? fallbackThreadId;
    const currentTaskState = loadTaskState(activeThreadId) ?? s.taskState;
    let status: FeatureReport['status'] = 'completed';
    let summary = '';

    if (s.approved === false) {
      status = 'rejected';
      summary = 'Kế hoạch bị từ chối.';
    } else if (s.error) {
      status = 'failed';
      summary = s.error;
    } else if (currentTaskState?.steps.some((st) => st.status === 'failed')) {
      status = 'failed';
      const failedStep = currentTaskState.steps.find((st) => st.status === 'failed');
      summary = `Feature implementation failed at step ${failedStep?.id}: ${failedStep?.note ?? 'unknown error'}`;
    } else if (
      currentTaskState &&
      currentTaskState.steps.length > 0 &&
      currentTaskState.steps.every((st) => st.status === 'done')
    ) {
      status = 'completed';
      summary = `Feature implementation completed successfully across all ${currentTaskState.steps.length} steps.`;
    } else {
      status = 'failed';
      summary = 'Feature implementation incomplete.';
    }

    const conventions = s.conventions ?? [];
    if (status === 'completed' && conventions.length > 0) {
      for (const conv of conventions) {
        const approved = opts.ui?.confirm
          ? await opts.ui.confirm(`Lưu quy ước mới vào memory dự án: "${conv}"?`)
          : false;
        if (approved) {
          addMemory(opts.workspaceRoot, conv);
        }
      }
    }

    const report: FeatureReport = {
      threadId: activeThreadId,
      status,
      steps: currentTaskState?.steps ?? [],
      filesChanged: s.filesChanged ?? [],
      summary,
      conventions,
    };

    return { finalReport: report };
  };

  return new StateGraph(FeatureState)
    .addNode('plan', traceNode(opts.bus, 'feature', 'plan', planNode))
    .addNode('approve', traceNode(opts.bus, 'feature', 'approve', approveNode))
    .addNode('step', traceNode(opts.bus, 'feature', 'step', stepNode))
    .addNode('report', traceNode(opts.bus, 'feature', 'report', reportNode))
    .addEdge(START, 'plan')
    .addEdge('plan', 'approve')
    .addConditionalEdges('approve', (s) => (s.approved ? 'step' : 'report'), ['step', 'report'])
    .addConditionalEdges(
      'step',
      (s) => {
        const tState = (s.threadId ? loadTaskState(s.threadId) : null) ?? s.taskState;
        const hasFailed = tState?.steps.some((st) => st.status === 'failed');
        const hasTodo = tState?.steps.some((st) => st.status === 'todo' || st.status === 'doing');
        if (!hasFailed && hasTodo) return 'step';
        return 'report';
      },
      ['step', 'report']
    )
    .addEdge('report', END);
}

/** Builds and runs the multi-step feature implementation graph. */
export async function runFeature(request: string, opts: FeatureOptions): Promise<FeatureReport> {
  const origApprover = opts.tools.approver;
  // Tự động cho phép submit_plan qua approver nội bộ, các tool rủi ro khác vẫn giữ nguyên approver của session
  opts.tools.approver = async (req) => {
    if (req.name === 'submit_plan') return 'approve';
    return origApprover ? origApprover(req) : 'deny';
  };

  try {
    const threadId = newThreadId('feature');
    const checkpointer = opts.checkpointer ?? createCheckpointer();
    const workflow = buildFeatureWorkflow(opts, threadId, request);
    const compiled = workflow.compile({ checkpointer });

    const finalState = await runGraph<FeatureStateType>(
      compiled,
      { request, threadId },
      { threadId, ui: opts.ui ?? defaultCommandUI, signal: opts.signal }
    );

    return finalState.finalReport;
  } finally {
    opts.tools.approver = origApprover;
  }
}

/** Continues an unfinished feature task (threadId undefined = newest unfinished task). */
export async function resumeTask(threadId: string | undefined, opts: FeatureOptions): Promise<FeatureReport> {
  const currentCanonical = canonicalWorkspace(opts.workspaceRoot);
  let targetId = threadId;

  if (!targetId) {
    const candidates = listTasks(opts.workspaceRoot).filter((t) =>
      t.steps.some((st) => st.status === 'todo' || st.status === 'doing')
    );
    if (candidates.length === 0) throw new Error('No unfinished tasks found to resume.');
    targetId = candidates[0].threadId;
  }

  const existingState = loadTaskState(targetId);
  if (!existingState) throw new Error(`Task state not found for thread: ${targetId}`);

  if (existingState.workspaceRoot && canonicalWorkspace(existingState.workspaceRoot) !== currentCanonical) {
    throw new Error(
      `Task ${targetId} was created for a different workspace (${existingState.workspaceRoot}) and cannot be resumed in ${opts.workspaceRoot}`
    );
  }

  // Khôi phục các bước đang 'doing' về lại 'todo' trước khi chạy tiếp (P7: rollback files từ snapshot)
  for (const st of existingState.steps) {
    if (st.status === 'doing') {
      const snapDir = path.join(taskDir(targetId), `snap-${st.id}`);
      if (fs.existsSync(snapDir)) {
        restoreFiles(opts.workspaceRoot, snapDir, { affectedFiles: st.files });
      }
      st.status = 'todo';
    }
  }
  existingState.updatedAt = new Date().toISOString();
  saveTaskState(existingState);

  const checkpointer = opts.checkpointer ?? createCheckpointer();
  const workflow = buildFeatureWorkflow(opts, targetId, existingState.goal);
  const compiled = workflow.compile({ checkpointer });

  let input: Partial<FeatureStateType> | null = null;
  let hasCheckpoint = false;
  if (typeof (checkpointer as any).getTuple === 'function') {
    const tuple = await (checkpointer as any).getTuple({ configurable: { thread_id: targetId } });
    if (tuple) hasCheckpoint = true;
  }

  if (!hasCheckpoint) {
    input = {
      threadId: targetId,
      taskState: existingState,
      approved: true,
    };
  }

  const origApprover = opts.tools.approver;
  opts.tools.approver = async (req) => {
    if (req.name === 'submit_plan') return 'approve';
    return origApprover ? origApprover(req) : 'deny';
  };

  try {
    const finalState = await runGraph<FeatureStateType>(
      compiled,
      input,
      { threadId: targetId, ui: opts.ui ?? defaultCommandUI, signal: opts.signal }
    );
    return finalState.finalReport;
  } finally {
    opts.tools.approver = origApprover;
  }
}
