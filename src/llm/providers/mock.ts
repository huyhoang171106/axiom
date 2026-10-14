// src/llm/providers/mock.ts - Mock LLM Provider for testing and benchmarks

import type {
  LLMProviderType,
  ToolCall,
  TokenUsage,
} from '../../core/types.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { defaultCostTracker } from '../cost-tracker.js';

export interface MockResponse {
  content?: string;
  toolCalls?: ToolCall[];
  usage?: Partial<TokenUsage>;
  thinking?: string;
}

export type MockResponseHandler = (
  params: ChatParams
) => Promise<MockResponse | string> | MockResponse | string;

/** Finite, non-negative number or undefined, so a malformed canned usage cannot reach the cost tracker. */
function nonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Prompt-token approximation, incremental while the same message array only grows (the harness re-sends the
 * whole history every turn, so a full reduce per call was O(n²) across a session).
 */
let approxCache: { messages: readonly unknown[]; length: number; total: number } | undefined;
function approxTokensOf(messages: ChatParams['messages']): number {
  if (approxCache && approxCache.messages === messages && messages.length >= approxCache.length) {
    let total = approxCache.total;
    for (let i = approxCache.length; i < messages.length; i++) {
      total += Math.max(1, Math.ceil((messages[i].content ?? '').length / 4));
    }
    approxCache = { messages, length: messages.length, total };
    return total;
  }
  const total = messages.reduce((sum, m) => sum + Math.max(1, Math.ceil((m.content ?? '').length / 4)), 10);
  approxCache = { messages, length: messages.length, total };
  return total;
}

export class MockProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;
  private cannedResponses: MockResponse[] = [];
  private handler?: MockResponseHandler;
  /**
   * Bounded: the provider is cached per process (ProviderRegistry), so an unbounded history retained every
   * request's full message array for the lifetime of a long benchmark run. Tests that need every call can
   * raise the cap before running.
   */
  public callLimit = 50;
  public callHistory: ChatParams[] = [];

  constructor(
    providerName: LLMProviderType = 'antigravity',
    initialResponses?: (MockResponse | string)[]
  ) {
    super();
    this.name = providerName;
    if (initialResponses) {
      this.setResponses(initialResponses);
    }
  }

  setResponses(responses: (MockResponse | string)[]): void {
    this.cannedResponses = responses.map((r) =>
      typeof r === 'string' ? { content: r } : r
    );
  }

  addResponse(response: MockResponse | string): void {
    this.cannedResponses.push(
      typeof response === 'string' ? { content: response } : response
    );
  }

  setHandler(handler?: MockResponseHandler): void {
    this.handler = handler;
  }

  clearHistory(): void {
    this.callHistory = [];
  }

  getLastCall(): ChatParams | undefined {
    return this.callHistory[this.callHistory.length - 1];
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    if (params.signal?.aborted) {
      throw new Error('Request was aborted');
    }

    this.callHistory.push(params);
    if (this.callHistory.length > this.callLimit) this.callHistory.splice(0, this.callHistory.length - this.callLimit);

    let resolvedResponse: MockResponse;

    if (this.handler) {
      const result = await this.handler(params);
      resolvedResponse = typeof result === 'string' ? { content: result } : result;
    } else if (this.cannedResponses.length > 0) {
      resolvedResponse = this.cannedResponses.shift()!;
    } else {
      resolvedResponse = {
        content: `Mock response for model ${params.model} with ${params.messages.length} messages.`,
      };
    }

    const content = resolvedResponse.content ?? '';

    if (resolvedResponse.thinking && params.onThinking) {
      params.onThinking(resolvedResponse.thinking);
    }

    if (params.onToken && content.length > 0) {
      const chunks = content.split(/(\s+)/);
      for (const chunk of chunks) {
        if (chunk) {
          params.onToken(chunk);
        }
      }
    }

    const approxPromptTokens = approxTokensOf(params.messages);
    const approxCompletionTokens = Math.max(1, Math.ceil(content.length / 4));

    // `??` passes NaN through, and a canned NaN/negative usage used to reach the cost tracker and poison the
    // whole session total. A non-finite or negative canned value falls back to the approximation instead.
    const canned = resolvedResponse.usage;
    const promptTokens = nonNegative(canned?.promptTokens) ?? approxPromptTokens;
    const completionTokens = nonNegative(canned?.completionTokens) ?? approxCompletionTokens;
    const cacheReadInputTokens = nonNegative(canned?.cacheReadInputTokens);
    const cacheCreationInputTokens = nonNegative(canned?.cacheCreationInputTokens);
    const totalTokens = nonNegative(canned?.totalTokens) ?? promptTokens + completionTokens;

    const costEstimate =
      nonNegative(canned?.costEstimate) ??
      defaultCostTracker.calculateCost(
        params.model,
        promptTokens,
        completionTokens,
        cacheReadInputTokens
      );

    const usage: TokenUsage = {
      promptTokens,
      completionTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalTokens,
      costEstimate,
    };

    return {
      content,
      toolCalls: resolvedResponse.toolCalls,
      usage,
    };
  }
}
