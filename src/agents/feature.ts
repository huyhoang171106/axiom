// src/agents/feature.ts - UC-04: plan, approve, then run steps one by one with a checkpoint after each

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
import {
  appendProgress,
  canonicalWorkspace,
  listTasks,
  loadTaskState,
  saveTaskState,
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

    const planNode = async (s: FeatureStateType, config: { configurable?: { thread_id?: string } }) => {
      const activeThreadId = config?.configurable?.thread_id ?? s.threadId ?? threadId;
      if (s.taskState) return { threadId: activeThreadId };

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

      const result = await agent.runTask(s.request ?? request, planController.signal);
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
      if (s.error || !s.taskState) return { approved: false };
      const answer = askHuman('Duyệt kế hoạch?', ['yes', 'no']);
      return { approved: answer === 'yes' };
    };

    const stepNode = async (s: FeatureStateType) => {
      if (!s.taskState) return { error: 'Missing task state in step node' };

      const step = s.taskState.steps.find((st) => st.status === 'todo' || st.status === 'doing');
      if (!step) return {};

      step.status = 'doing';
      s.taskState.updatedAt = new Date().toISOString();
      saveTaskState(s.taskState);

      const completed = s.taskState.steps.filter((st) => st.status === 'done');
      const stepPrompt = [
        `Feature Goal: ${s.taskState.goal}`,
        s.taskState.constraints.length > 0 ? `Constraints:\n${s.taskState.constraints.map((c) => `- ${c}`).join('\n')}` : '',
        `Acceptance Criteria:\n${s.taskState.acceptance.map((a) => `- ${a}`).join('\n')}`,
        completed.length > 0
          ? `Completed Steps:\n${completed.map((st) => `- Step ${st.id}: ${st.title} (done)`).join('\n')}`
          : '',
        `Current Step (${step.id}/${s.taskState.steps.length}): ${step.title}`,
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
            const v = await opts.verifier(step, { workspaceRoot: opts.workspaceRoot, threadId: s.taskState.threadId });
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

      s.taskState.updatedAt = new Date().toISOString();
      saveTaskState(s.taskState);
      appendProgress(s.taskState.threadId, `step ${step.id} ${step.status}: ${step.title}`);

      return {
        taskState: s.taskState,
        filesChanged: loopResult.filesChanged,
      };
    };

    const reportNode = async (s: FeatureStateType) => {
      let status: FeatureReport['status'] = 'completed';
      let summary = '';

      if (s.approved === false) {
        status = 'rejected';
        summary = 'Kế hoạch bị từ chối.';
      } else if (s.error) {
        status = 'failed';
        summary = s.error;
      } else if (s.taskState?.steps.some((st) => st.status === 'failed')) {
        status = 'failed';
        const failedStep = s.taskState.steps.find((st) => st.status === 'failed');
        summary = `Feature implementation failed at step ${failedStep?.id}: ${failedStep?.note ?? 'unknown error'}`;
      } else if (s.taskState && s.taskState.steps.length > 0 && s.taskState.steps.every((st) => st.status === 'done')) {
        status = 'completed';
        summary = `Feature implementation completed successfully across all ${s.taskState.steps.length} steps.`;
      } else {
        status = 'failed';
        summary = 'Feature implementation incomplete.';
      }

      const report: FeatureReport = {
        threadId: s.threadId ?? threadId,
        status,
        steps: s.taskState?.steps ?? [],
        filesChanged: s.filesChanged ?? [],
        summary,
      };

      return { finalReport: report };
    };

    const workflow = new StateGraph(FeatureState)
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
          const hasFailed = s.taskState?.steps.some((st) => st.status === 'failed');
          const hasTodo = s.taskState?.steps.some((st) => st.status === 'todo');
          if (!hasFailed && hasTodo) return 'step';
          return 'report';
        },
        ['step', 'report']
      )
      .addEdge('report', END);

    const checkpointer = opts.checkpointer ?? createCheckpointer();
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

/** `threadId` undefined: the newest unfinished task. (D2 preview & canonical identity guard) */
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

  // Khôi phục các bước đang 'doing' về lại 'todo' trước khi chạy tiếp (theo đặc tả D2)
  for (const st of existingState.steps) {
    if (st.status === 'doing') st.status = 'todo';
  }
  saveTaskState(existingState);

  // D1 Seam: gọi trực tiếp runFeature với taskState đã khôi phục
  return runFeature(existingState.goal, opts);
}
