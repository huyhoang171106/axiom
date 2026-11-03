// src/core/rag/embedder.ts - Text to vectors through the @embed model; a deterministic fake for tests

import type { ModelInfo } from '../../llm/catalog/index.js';
import type { CostTracker } from '../../llm/cost-tracker.js';
import type { Embedder } from './types.js';

/** `costTracker` records embedding usage of the run (eval tokens and cost per case). */
export function createEmbedder(info: ModelInfo, opts?: { fetchImpl?: typeof fetch; costTracker?: CostTracker }): Embedder {
  throw new Error('chưa làm (B2)');
}

/** Hashes each token into one of `dim` dimensions; same text, same vector. For tests only. */
export function fakeEmbedder(dim?: number): Embedder {
  throw new Error('chưa làm (B2)');
}
