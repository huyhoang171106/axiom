// src/agents/ask.ts - UC-02: answer a question about the repo with `path:Lx-Ly` citations

import type { EventBus } from '../core/event-bus.js';
import type { Citation, Embedder } from '../core/rag/types.js';
import type { BaseLLMProvider } from '../llm/base-provider.js';
import type { CostTracker } from '../llm/cost-tracker.js';

export interface AskOptions {
  workspaceRoot: string;
  provider: BaseLLMProvider;
  model: string;
  embedder: Embedder;
  signal?: AbortSignal;
  bus?: EventBus;
  /** Records every chat call (eval tokens and cost per case); defaults to defaultCostTracker. */
  costTracker?: CostTracker;
}

export interface AskAnswer {
  text: string;
  citations: Citation[];
  found: boolean;
}

export async function answerQuestion(question: string, opts: AskOptions): Promise<AskAnswer> {
  throw new Error('chưa làm (B4)');
}
