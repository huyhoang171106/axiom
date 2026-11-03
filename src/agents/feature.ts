// src/agents/feature.ts - UC-04: plan, approve, then run steps one by one with a checkpoint after each

import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { CommandUI } from '../core/execution-context.js';
import type { EventBus } from '../core/event-bus.js';
import type { PlanStep } from '../core/task-state.js';
import type { BaseLLMProvider } from '../llm/base-provider.js';
import type { CostTracker } from '../llm/cost-tracker.js';
import type { ToolRegistry } from '../tools/registry.js';

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
}

export interface FeatureReport {
  threadId: string;
  status: 'completed' | 'failed' | 'aborted' | 'rejected';
  steps: PlanStep[];
  filesChanged: string[];
  summary: string;
}

export async function runFeature(request: string, opts: FeatureOptions): Promise<FeatureReport> {
  throw new Error('chưa làm (D1)');
}

/** `threadId` undefined: the newest unfinished task. */
export async function resumeTask(threadId: string | undefined, opts: FeatureOptions): Promise<FeatureReport> {
  throw new Error('chưa làm (D2)');
}
