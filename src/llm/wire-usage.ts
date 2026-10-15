// src/llm/wire-usage.ts - TokenUsage for one call, priced from the catalog model when it has a price

import type { TokenUsage } from '../core/types.js';
import type { ModelInfo } from './catalog/index.js';
import { defaultCostTracker } from './cost-tracker.js';

/** `input` excludes cache reads and writes; `promptTokens` counts all three, as CostTracker expects. */
export function wireUsage(info: ModelInfo, input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenUsage {
  const promptTokens = input + cacheRead + cacheWrite;
  const price = info.cost;
  const costEstimate = price
    ? Number(((input * price.input + output * price.output + cacheRead * (price.cacheRead ?? 0) + cacheWrite * (price.cacheWrite ?? 0)) / 1_000_000).toFixed(6))
    : defaultCostTracker.calculateCost(info.id, promptTokens, output, cacheRead);
  return {
    promptTokens,
    completionTokens: output,
    cacheReadInputTokens: cacheRead || undefined,
    cacheCreationInputTokens: cacheWrite || undefined,
    totalTokens: promptTokens + output,
    costEstimate,
  };
}
