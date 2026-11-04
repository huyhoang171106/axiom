// src/llm/cost-tracker.ts - Token usage pricing and cost tracking

import type { TokenUsage } from '../core/types.js';

export interface ModelPricing {
  input: number;      // USD per 1M tokens
  output: number;     // USD per 1M tokens
  cacheRead: number;  // USD per 1M tokens
}

export const PRICING_PER_1M: Record<string, ModelPricing> = {
  // Anthropic
  'claude-3-5-sonnet': { input: 3.00, output: 15.00, cacheRead: 0.30 },
  'claude-3-7-sonnet': { input: 3.00, output: 15.00, cacheRead: 0.30 },
  'claude-3-5-haiku':  { input: 0.80, output: 4.00, cacheRead: 0.08 },
  'claude-haiku-5.5':  { input: 0.10, output: 0.50, cacheRead: 0.02 },

  // OpenAI
  'gpt-4o':       { input: 2.50, output: 10.00, cacheRead: 1.25 },
  'gpt-4o-mini':  { input: 0.15, output: 0.60, cacheRead: 0.075 },
  'o3-mini':      { input: 1.10, output: 4.40, cacheRead: 0.55 },
  'o1':           { input: 15.00, output: 60.00, cacheRead: 7.50 },
  'o1-mini':      { input: 1.10, output: 4.40, cacheRead: 0.55 },

  // Google Gemini
  'gemini-2.5-flash': { input: 0.15, output: 0.60, cacheRead: 0.0375 },
  'gemini-2.5-pro':   { input: 1.25, output: 5.00, cacheRead: 0.3125 },
  'gemini-3.8-flash': { input: 0.15, output: 0.60, cacheRead: 0.0375 },

  // DeepSeek
  'deepseek-chat':     { input: 0.27, output: 1.10, cacheRead: 0.07 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14 },

  // Default fallback pricing
  'default': { input: 2.00, output: 8.00, cacheRead: 0.50 },
};

/**
 * Resolves the pricing entry for a given model string.
 * Normalizes model identifiers (case-insensitive, strips provider prefixes, and matches canonical model keys).
 */
/** Token counts from providers are trusted only as far as they are finite and non-negative. */
function finiteCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function getModelPricing(model: string): ModelPricing {
  const normalized = model.toLowerCase().trim();
  // Free-tier models have zero cost
  if (normalized.endsWith(':free') || normalized.includes(':free')) {
    return { input: 0, output: 0, cacheRead: 0 };
  }

  // Direct lookup
  if (PRICING_PER_1M[normalized]) {
    return PRICING_PER_1M[normalized];
  }

  // Strip provider prefix if present (e.g. "anthropic/claude-3-5-sonnet")
  const slashIdx = normalized.indexOf('/');
  const withoutPrefix = slashIdx !== -1 ? normalized.slice(slashIdx + 1) : normalized;

  if (PRICING_PER_1M[withoutPrefix]) {
    return PRICING_PER_1M[withoutPrefix];
  }

  // Prefix match for versioned names (e.g. "claude-3-5-sonnet-20241022", "gpt-4o-2024-08-06").
  //
  // Longest key first, and the key must end at a separator: with the table's own order, `gpt-4o` matched
  // `gpt-4o-mini-2024-07-18` (16.7× the real price), and a bare `includes` priced `o1-mini` and
  // `gpt-4o-transcribe` as their longer namesakes instead of falling through to `default`.
  const candidates = Object.keys(PRICING_PER_1M)
    .filter((key) => key !== 'default')
    .sort((a, b) => b.length - a.length);
  for (const key of candidates) {
    if (withoutPrefix === key) return PRICING_PER_1M[key];
    // Only a genuine version suffix counts: `gpt-4o-2024-08-06` and `claude-3-5-sonnet-latest` are the same
    // model, while `gpt-4o-transcribe` is a different (cheaper) one and must not inherit gpt-4o pricing.
    const suffix = withoutPrefix.slice(key.length);
    if (withoutPrefix.startsWith(key) && /^(?:-\d{4,}|-latest|-v\d+|\/|$)/.test(suffix)) {
      return PRICING_PER_1M[key];
    }
  }

  return PRICING_PER_1M['default'];
}

export interface ModelUsageSummary {
  calls: number;
  cost: number;
  costDollars: number;
  tokens: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}

export interface SessionSummary {
  totalTokens: number;
  totalCost: number;
  totalCostDollars: number;
  cachedTokens: number;
  totalCacheReadTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  cacheHitRatio: number;
  breakdown: Record<string, ModelUsageSummary>;
  byModel: Record<string, ModelUsageSummary>;
}

export class CostTracker {
  private totalTokens = 0;
  private totalCost = 0;
  private cachedTokens = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private breakdown: Record<string, ModelUsageSummary> = {};
  /**
   * Calculates the cost in USD for a request given model and token counts.
   */
  calculateCost(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedTokens?: number
  ): number {
    const pricing = getModelPricing(model);
    // Non-finite or negative counts (a canned mock usage, a provider that reports NaN) used to produce NaN
    // or a negative cost, and a single NaN permanently poisoned the session total because NaN + x === NaN.
    const prompt = finiteCount(promptTokens);
    const completion = finiteCount(completionTokens);
    const cached = Math.max(0, Math.min(finiteCount(cachedTokens), prompt));
    const uncachedPrompt = Math.max(0, prompt - cached);

    const cost =
      (uncachedPrompt * pricing.input +
        cached * pricing.cacheRead +
        completion * pricing.output) /
      1_000_000;

    return Number(cost.toFixed(6));
  }

  /**
   * Records a token usage event into the session summary.
   */
  record(model: string, usage: TokenUsage): void {
    const prompt = finiteCount(usage.promptTokens);
    const completion = finiteCount(usage.completionTokens);
    const cached = finiteCount(usage.cacheReadInputTokens);
    const tokens = finiteCount(usage.totalTokens) || prompt + completion;

    // An explicit zero is authoritative (free tier): recomputing it only repeated the pricing-table scan.
    const cost =
      Number.isFinite(usage.costEstimate) && usage.costEstimate >= 0
        ? usage.costEstimate
        : this.calculateCost(model, prompt, completion, cached);

    this.promptTokens += prompt;
    this.completionTokens += completion;
    this.totalTokens += tokens;
    this.totalCost = Number((this.totalCost + cost).toFixed(6));
    this.cachedTokens += cached;

    if (!this.breakdown[model]) {
      this.breakdown[model] = { calls: 0, cost: 0, costDollars: 0, tokens: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 };
    }

    const item = this.breakdown[model];
    item.calls += 1;
    item.promptTokens += prompt;
    item.completionTokens += completion;
    item.cost = Number((item.cost + cost).toFixed(6));
    item.costDollars = item.cost;
    item.tokens += tokens;
    item.totalTokens += tokens;
  }

  /**
   * Returns current aggregated session usage metrics.
   */
  getSessionSummary(): SessionSummary {
    const totalCost = Number(this.totalCost.toFixed(6));
    const cacheHitRatio = this.promptTokens > 0 ? Number((this.cachedTokens / this.promptTokens).toFixed(4)) : 0;
    const breakdownCopy = Object.fromEntries(Object.entries(this.breakdown).map(([model, usage]) => [model, { ...usage }]));
    return {
      totalTokens: this.totalTokens,
      totalCost,
      totalCostDollars: totalCost,
      cachedTokens: this.cachedTokens,
      totalCacheReadTokens: this.cachedTokens,
      totalPromptTokens: this.promptTokens,
      totalCompletionTokens: this.completionTokens,
      cacheHitRatio,
      breakdown: breakdownCopy,
      byModel: breakdownCopy,
    };
  }
  /**
   * Clears accumulated session counters.
   */
  reset(): void {
    this.totalTokens = 0;
    this.totalCost = 0;
    this.cachedTokens = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.breakdown = {};
  }
}

export const defaultCostTracker = new CostTracker();
