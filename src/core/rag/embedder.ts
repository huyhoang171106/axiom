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
export const EMBED_TIMEOUT_MS = 20_000;

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

/** A vector store only works if every vector has one dimension and no NaN/Infinity (JSON can carry 1e999). */
function checkVectors(info: ModelInfo, vectors: readonly number[][]): void {
  const dims = [...new Set(vectors.map((v) => v.length))];
  if (dims.length !== 1 || dims[0] === 0) {
    throw new ProviderError(`${info.provider} embeddings for ${info.id} have dimensions ${dims.join(', ')}; expected one non-zero dimension`, { provider: info.provider, model: info.id });
  }
  if (!vectors.every((v) => v.every(Number.isFinite))) {
    throw new ProviderError(`${info.provider} embeddings for ${info.id} contain a non-finite value`, { provider: info.provider, model: info.id });
  }
}

/** Status codes a server gives for a model it cannot embed with (a chat model, a wrong tag). */
const NOT_AN_EMBED_MODEL = new Set([400, 404, 422, 501]);

/** `costTracker` records embedding usage of the run (eval tokens and cost per case). */
export function createEmbedder(info: ModelInfo, opts?: { fetchImpl?: typeof fetch; costTracker?: CostTracker; timeoutMs?: number; signal?: AbortSignal }): Embedder {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? EMBED_TIMEOUT_MS;
  const base = info.baseUrl.replace(/\/+$/, '');
  const isOllama = info.api === 'ollama-chat';
  const url = isOllama ? `${base}/api/embed` : `${base}/embeddings`;
  let credential: Promise<string | undefined> | undefined;

  const embedBatch = async (input: readonly string[]): Promise<number[][]> => {
    // Same credential chain as createProviderFor; resolved once, on first use, so creating an embedder never prompts or fails.
    credential ??= resolveCredential(info.provider, {}).then((c) => c?.value);
    const key = await credential;
    let response: Response;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...info.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: info.id, input }),
        signal,
      });
    } catch (error) {
      const isTimeout = timeoutSignal.aborted && !opts?.signal?.aborted;
      const hint = isTimeout ? `. Embedder did not respond within ${timeoutMs / 1000}s. Check that ollama/embedding service is running and responsive (modelRoles.embed)` : '';
      throw new ProviderError(redact(`${info.provider} embeddings request to ${url} failed: ${error instanceof Error ? error.message : String(error)}${hint}`), { provider: info.provider, model: info.id, code: isTimeout ? 'timeout' : undefined });
    }
    if (!response.ok) {
      const { detail, code } = await describeErrorResponse(response);
      const hint = NOT_AN_EMBED_MODEL.has(response.status) ? `. Check that ${info.provider}/${info.id} is an embedding model and the tag exists (modelRoles.embed)` : '';
      throw new ProviderError(redact(`${info.provider} embeddings error (${response.status}): ${detail}${hint}`), { provider: info.provider, model: info.id, status: response.status, code });
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
    if (vectors.length > 0) checkVectors(info, vectors);
    return vectors;
  };
}

/** Everything that decides what a vector means: provider, wire, endpoint and exact model id/tag. Indexes built under two identities never mix. */
export function embedIdentity(info: ModelInfo): string {
  return `${info.provider}|${info.api}|${info.baseUrl.replace(/\/+$/, '')}|${info.id}`;
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
export function embedModelFromConfig(config: AxiomConfig): ModelInfo {
  if (!config.modelRoles?.embed) throw new Error(MISSING_EMBED_MESSAGE);
  return resolveModel('@embed', loadCatalog(), config);
}

export function embedderFromConfig(config: AxiomConfig, opts?: { costTracker?: CostTracker }): Embedder {
  return createEmbedder(embedModelFromConfig(config), opts);
}
