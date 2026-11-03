// src/agents/fix.ts - UC-03: reproduce, locate, patch, verify a bug in at most 5 rounds

import type { CommandUI } from '../core/execution-context.js';
import type { EventBus } from '../core/event-bus.js';
import type { BaseLLMProvider } from '../llm/base-provider.js';
import type { CostTracker } from '../llm/cost-tracker.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface FixOptions {
  issue: string;                 // issue.md content or what the user typed
  workspaceRoot: string;
  provider: BaseLLMProvider;
  model: string;
  bus: EventBus;
  /** Session registry; every node takes `tools.scoped([...])` so approvals and denials carry across nodes. */
  tools: ToolRegistry;
  /** Records every model call (eval tokens and cost per case); defaults to defaultCostTracker. */
  costTracker?: CostTracker;
  ui?: CommandUI;                // absent: no "Keep the fix?" question, the fix is kept
  maxRounds?: number;            // default 5
  budgetTokens?: number;         // default 200_000
  timeLimitMs?: number;          // default 15 minutes
  signal?: AbortSignal;
}

export interface FixRound { round: number; hypothesis: string; patchApplied: boolean; testsPassed: number; testsFailed: number; regressions: string[] }

export interface FixReport {
  status: 'fixed' | 'failed' | 'aborted';
  rounds: FixRound[];
  filesChanged: string[];
  diffStat: { files: number; added: number; removed: number };
  explanation?: string;          // required when diffStat.files > 3 or added + removed > 100
  summary: string;               // fixed: cause and fix; failed: what was tried, rejected hypotheses, next step
}

export async function fixIssue(opts: FixOptions): Promise<FixReport> {
  throw new Error('chưa làm (C5)');
}
