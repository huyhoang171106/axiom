// src/core/compaction.ts - Summarize the middle of a long conversation into 5 fixed sections (UC-04)

import type { BaseLLMProvider } from '../llm/base-provider.js';
import type { CostTracker } from '../llm/cost-tracker.js';
import type { TaskState } from './task-state.js';
import type { Message } from './types.js';

export const COMPACT_SECTIONS = ['Goal', 'Constraints', 'Completed steps', 'Current state', 'Open risks and next step'] as const;
export const COMPACT_THRESHOLD = 0.6;

export function shouldCompact(usedTokens: number, contextWindow: number, threshold?: number): boolean {
  // TODO(D3)
  return false;
}

export async function compactHistory(
  messages: readonly Message[],
  opts: { provider: BaseLLMProvider; model: string; task?: TaskState; signal?: AbortSignal; costTracker?: CostTracker }
): Promise<{ summary: string; messages: Message[] }> {
  // TODO(D3)
  return { summary: '', messages: [...messages] };
}

/** Section names with no `## <name>` heading in `summary`. */
export function missingSections(summary: string): string[] {
  // TODO(D3)
  return [];
}
