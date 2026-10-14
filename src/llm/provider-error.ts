// src/llm/provider-error.ts - One error shape for every provider.
//
// Every provider used to flatten its failures into `new Error("<Provider> API error (429 ...)")`, so the
// only way to tell a rate limit from a bad key was to regex the message (reliability/failure-classifier.ts
// does exactly that). These helpers keep the machine-readable parts — status, provider code, retry-after —
// on the error object, and fix the two body-handling traps the audit found:
//
//   * `response.json()` consumes the body, so a `catch { response.text() }` fallback throws
//     "body is unusable" and hides the real error. Read `text()` once, then parse it.
//   * an in-stream `error` event (HTTP 200, then `data: {"error": ...}`) was ignored, so a blocked or
//     rate-limited stream came back as a successful empty completion.

import type { TokenUsage } from '../core/types.js';

export interface ProviderErrorOptions {
  provider: string;
  model?: string;
  status?: number;
  /** Provider-specific code/type, e.g. Anthropic's `overloaded_error` or Gemini's `SAFETY`. */
  code?: string;
  retryAfterSeconds?: number;
  /** Text already streamed when the failure happened, so partial output is not lost. */
  partialContent?: string;
  /** Usage counted so far; a mid-stream failure must not report the call as free. */
  usage?: TokenUsage;
}

const RETRYABLE_CODE = /overloaded|rate[_ -]?limit|quota|unavailable|resource[_ -]?exhausted|timeout|internal|server_error/i;

export class ProviderError extends Error {
  readonly provider: string;
  readonly model?: string;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  readonly retryable: boolean;
  readonly partialContent?: string;
  readonly usage?: TokenUsage;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message);
    this.name = 'ProviderError';
    this.provider = options.provider;
    this.model = options.model;
    this.status = options.status;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.partialContent = options.partialContent;
    this.usage = options.usage;
    const byStatus = options.status === 408 || options.status === 409 || (options.status ?? 0) >= 429;
    this.retryable = byStatus || (options.code ? RETRYABLE_CODE.test(options.code) : false);
  }
}

/** `retry-after` in seconds; the HTTP-date form is not parsed, only deltas are useful here. */
export function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** Message and provider code of a non-2xx body. Reads the body once, so text() stays usable. */
export async function describeErrorResponse(response: Response): Promise<{ detail: string; code?: string }> {
  const text = await response.text().catch(() => '');
  try {
    const json = JSON.parse(text) as { error?: { message?: string; type?: string }; message?: string };
    return {
      detail: json?.error?.message || json?.message || text.slice(0, 300),
      code: json?.error?.type,
    };
  } catch {
    return { detail: text.slice(0, 300) || response.statusText };
  }
}

/** Throws a classified error for any non-2xx response. */
export async function throwHttpError(response: Response, provider: string, model?: string): Promise<never> {
  const { detail, code } = await describeErrorResponse(response);
  throw new ProviderError(
    `${provider} API error (${response.status} ${response.statusText}): ${detail}`,
    { provider, model, status: response.status, code, retryAfterSeconds: retryAfterSeconds(response) }
  );
}

/**
 * Parses a 200 body that should be JSON, with a provider-typed error when it is not (a proxy or WAF
 * answering HTML is otherwise reported as a bare `SyntaxError`, which names no provider or model).
 */
export async function readJsonBody<T>(response: Response, provider: string, model: string): Promise<T> {
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(
      `${provider} API error (200 with a non-JSON body for model ${model}): ${text.slice(0, 200) || '<empty>'}`,
      { provider, model, status: 200 }
    );
  }
}

/** SSE `error` frame (`data: {"error": {"message": ...}}`) — OpenAI-compatible and Gemini both use it. */
export function sseErrorFrame(chunk: Record<string, unknown>): { message: string; code?: string } | undefined {
  const error = chunk.error as { message?: string; type?: string; code?: string } | string | undefined;
  if (!error) return undefined;
  if (typeof error === 'string') return { message: error };
  return { message: error.message || JSON.stringify(error), code: error.type || error.code };
}

/**
 * Counts malformed SSE frames instead of dropping them silently; a stream that is mostly garbage is
 * reported rather than returning a short answer that looks complete.
 */
export class SseFrameCounter {
  private malformed = 0;

  /** Returns the parsed frame, or undefined when it is not JSON (counted). */
  parse<T = Record<string, unknown>>(raw: string): T | undefined {
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.malformed += 1;
      return undefined;
    }
  }

  /** Throws when more than `limit` frames were unparseable, so silent data loss becomes an error. */
  assertHealthy(provider: string, model: string, limit = 5): void {
    if (this.malformed > limit) {
      throw new ProviderError(
        `${provider} API error (stream): ${this.malformed} malformed SSE frames for model ${model}; the response is incomplete`,
        { provider, model }
      );
    }
  }

  get count(): number {
    return this.malformed;
  }
}
