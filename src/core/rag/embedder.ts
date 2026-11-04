// src/core/rag/embedder.ts - Text to vectors through the @embed model; a deterministic fake for tests

import { resolveCredential } from '../../llm/auth/resolve.js';
import { loadCatalog, type ModelInfo } from '../../llm/catalog/index.js';
import type { CostTracker } from '../../llm/cost-tracker.js';
import { resolveModel } from '../../llm/model-resolver.js';
import { describeErrorResponse, ProviderError } from '../../llm/provider-error.js';
import { redact } from '../secrets.js';
import type { AxiomConfig } from '../types.js';
import { tokenize } from './bm25.js';
import type { Embedder } from './types.js';

const BATCH_SIZE = 64;
const FAKE_DIM = 64;

interface EmbedResponse { vectors: number[][]; promptTokens: number }

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'number');
}

function parseOllama(body: unknown): EmbedResponse | null {
  const b = body as { embeddings?: unknown; prompt_eval_count?: unknown } | null;
  if (!Array.isArray(b?.embeddings) || !b.embeddings.every(isVector)) return null;
  return { vectors: b.embeddings, promptTokens: typeof b.prompt_eval_count === 'number' ? b.prompt_eval_count : 0 };
}

function parseOpenAI(body: unknown): EmbedResponse | null {
  const b = body as { data?: unknown; usage?: { prompt_tokens?: unknown } } | null;
  if (!Array.isArray(b?.data)) return null;
  // `index` is the input position; providers are allowed to return items out of order.
  const items = (b.data as { index?: unknown; embedding?: unknown }[]).map((d, i) => ({ index: typeof d?.index === 'number' ? d.index : i, embedding: d?.embedding }));
  if (!items.every((d) => isVector(d.embedding))) return null;
  const vectors = items.sort((x, y) => x.index - y.index).map((d) => d.embedding as number[]);
  return { vectors, promptTokens: typeof b.usage?.prompt_tokens === 'number' ? b.usage.prompt_tokens : 0 };
}

/** `costTracker` records embedding usage of the run (eval tokens and cost per case). */
export function createEmbedder(info: ModelInfo, opts?: { fetchImpl?: typeof fetch; costTracker?: CostTracker }): Embedder {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const base = info.baseUrl.replace(/\/+$/, '');
  const isOllama = info.api === 'ollama-chat';
  const url = isOllama ? `${base}/api/embed` : `${base}/embeddings`;
  let credential: Promise<string | undefined> | undefined;

  const embedBatch = async (input: readonly string[]): Promise<number[][]> => {
    // Same credential chain as createProviderFor; resolved once, on first use, so creating an embedder never prompts or fails.
    credential ??= resolveCredential(info.provider, {}).then((c) => c?.value);
    const key = await credential;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...info.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: info.id, input }),
      });
    } catch (error) {
      throw new ProviderError(redact(`${info.provider} embeddings request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`), { provider: info.provider, model: info.id });
    }
    if (!response.ok) {
      const { detail, code } = await describeErrorResponse(response);
      throw new ProviderError(redact(`${info.provider} embeddings error (${response.status}): ${detail}`), { provider: info.provider, model: info.id, status: response.status, code });
    }
    const body: unknown = await response.json().catch(() => null);
    const parsed = isOllama ? parseOllama(body) : parseOpenAI(body);
    if (!parsed || parsed.vectors.length !== input.length) {
      throw new ProviderError(`${info.provider} embeddings response for ${info.id} has no vector per input`, { provider: info.provider, model: info.id, status: response.status });
    }
    const tokens = parsed.promptTokens;
    opts?.costTracker?.record(info.id, { promptTokens: tokens, completionTokens: 0, totalTokens: tokens, costEstimate: (tokens * (info.cost?.input ?? 0)) / 1_000_000 });
    return parsed.vectors;
  };

  return async (texts) => {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) vectors.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE))));
    return vectors;
  };
}

/** FNV-1a: stable across runs and platforms, unlike anything seeded. */
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Hashes each token into one of `dim` dimensions; same text, same vector. For tests only. */
export function fakeEmbedder(dim = FAKE_DIM): Embedder {
  return async (texts) =>
    texts.map((text) => {
      const v = new Array<number>(dim).fill(0);
      for (const token of tokenize(text)) v[hashToken(token) % dim] += 1;
      const norm = Math.hypot(...v);
      return norm > 0 ? v.map((x) => x / norm) : v;
    });
}

export const MISSING_EMBED_MESSAGE = 'Set modelRoles.embed in ~/.axiom/config.json (see docs/guides/providers.md section 9)';

/** The @embed model has no fallback: a chat model posted to /embeddings fails late and confusingly. */
export function embedderFromConfig(config: AxiomConfig, opts?: { costTracker?: CostTracker }): Embedder {
  if (!config.modelRoles?.embed) throw new Error(MISSING_EMBED_MESSAGE);
  return createEmbedder(resolveModel('@embed', loadCatalog(), config), opts);
}
