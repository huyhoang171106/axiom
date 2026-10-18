// src/llm/providers/responses-shared.ts - OpenAI Responses API: request body + SSE stream, shared by the
// `openai-responses`, `openai-codex-responses` and `azure-openai-responses` wires (providers.md step 8)

import crypto from 'node:crypto';
import type { Message, ToolCall } from '../../core/types.js';
import type { ChatResult } from '../base-provider.js';
import { ProviderError, SseFrameCounter, sseErrorFrame, throwHttpError } from '../provider-error.js';
import type { ModelInfo } from '../catalog/index.js';
import { wireUsage } from '../wire-usage.js';

export function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === name.toLowerCase());
}

export interface ResponsesBodyOptions {
  temperature?: number;
  maxTokens?: number;
  /** The Codex backend 400s on sampling params; the wire passes `allowTemperature: false`. */
  allowTemperature?: boolean;
}

/** One `input` item of the Responses API. */
type InputItem = Record<string, unknown>;

/**
 * Maps Axiom messages to Responses `input` items: assistant tool calls become `function_call`
 * items and tool results become `function_call_output` keyed by `call_id`, so a replayed history
 * round-trips exactly like the live call did.
 */
export function buildResponsesInput(messages: readonly Message[]): InputItem[] {
  const input: InputItem[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId ?? '', output: m.content });
      continue;
    }
    const content = m.role === 'assistant' ? 'output_text' : 'input_text';
    if (m.content || !m.toolCalls?.length) {
      input.push({ type: 'message', role: m.role, content: [{ type: content, text: m.content }] });
    }
    for (const tc of m.toolCalls ?? []) {
      input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments) });
    }
  }
  return input;
}

export function buildResponsesBody(
  model: string,
  messages: readonly Message[],
  tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[] | undefined,
  opts: ResponsesBodyOptions = {}
): Record<string, unknown> {
  return {
    model,
    input: buildResponsesInput(messages),
    tools: tools?.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
    stream: true,
    store: false,
    ...(opts.maxTokens !== undefined && { max_output_tokens: opts.maxTokens }),
    // Codex refuses temperature outright; the other routes forward it when the caller set one.
    ...(opts.temperature !== undefined && opts.allowTemperature !== false && { temperature: opts.temperature }),
  };
}

export interface ResponsesCallOptions {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  provider: string;
  model: string;
  info: ModelInfo;
  onToken?: (token: string) => void;
  onThinking?: (thought: string) => void;
  signal?: AbortSignal;
}

/** POSTs a Responses request and drives the SSE stream; the one entry point the three wires share. */
export async function requestResponses(opts: ResponsesCallOptions): Promise<ChatResult> {
  const response = await fetch(opts.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (!response.ok) await throwHttpError(response, opts.provider, opts.model);
  if (!response.body) {
    throw new ProviderError(`${opts.provider}: empty response body for model ${opts.model}`, {
      provider: opts.provider,
      model: opts.model,
    });
  }
  return streamResponses(response, opts);
}

interface UsageSoFar {
  input: number;
  output: number;
  cacheRead: number;
}

/** SSE loop for the Responses event family; event names follow `type` on each `data:` frame. */
async function streamResponses(response: Response, opts: ResponsesCallOptions): Promise<ChatResult> {
  const { provider, model, info, onToken, onThinking } = opts;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames = new SseFrameCounter();
  let buffer = '';
  let content = '';
  let usage: UsageSoFar | undefined;
  let usageSeen = false;
  let finishReason: string | undefined;
  const toolAccum = new Map<string, { id: string; name: string; args: string }>();

  const usageSoFar = () => (usage ? wireUsage(info, usage.input, usage.output, usage.cacheRead) : undefined);

  const fail = (message: string, code?: string): never => {
    throw new ProviderError(message, {
      provider,
      model,
      code,
      partialContent: content,
      usage: usageSoFar(),
    });
  };

  const handle = (raw: string): void => {
    const chunk = frames.parse<Record<string, unknown>>(raw);
    if (!chunk) return;
    const chunkError = sseErrorFrame(chunk);
    if (chunkError) fail(`${provider} API error (stream): ${chunkError.message}`, chunkError.code);

    const type = typeof chunk.type === 'string' ? chunk.type : '';
    if (type === 'response.output_text.delta' || type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      const delta = chunk.delta;
      if (typeof delta === 'string' && delta) {
        if (type === 'response.output_text.delta') {
          content += delta;
          onToken?.(delta);
        } else {
          onThinking?.(delta);
        }
      }
      return;
    }
    if (type === 'response.output_item.added') {
      const item = chunk.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call') {
        const key = (item.id as string) || (item.call_id as string) || `call_${toolAccum.size}`;
        toolAccum.set(key, {
          id: (item.call_id as string) || (item.id as string) || crypto.randomUUID(),
          name: (item.name as string) || '',
          args: '',
        });
      }
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const key = (chunk.item_id as string) || '';
      const acc = toolAccum.get(key);
      if (acc && typeof chunk.delta === 'string') acc.args += chunk.delta;
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      const key = (chunk.item_id as string) || '';
      const acc = toolAccum.get(key);
      if (acc && typeof chunk.arguments === 'string') acc.args = chunk.arguments;
      return;
    }
    if (type === 'response.output_item.done') {
      const item = chunk.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call') {
        const key = (item.id as string) || (item.call_id as string) || '';
        const acc = toolAccum.get(key);
        const args = typeof item.arguments === 'string' ? item.arguments : acc?.args;
        toolAccum.set(key, {
          id: (item.call_id as string) || acc?.id || crypto.randomUUID(),
          name: (item.name as string) || acc?.name || '',
          args: args ?? '',
        });
      }
      return;
    }
    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const res = chunk.response as Record<string, unknown> | undefined;
      const u = res?.usage as Record<string, unknown> | undefined;
      if (u) {
        usageSeen = true;
        const details = u.input_tokens_details as { cached_tokens?: number } | undefined;
        const cacheRead = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0;
        const inputTotal = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
        const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
        // OpenAI's `input_tokens` includes the cached part; wireUsage wants input excluding cache.
        usage = { input: inputTotal - cacheRead, output, cacheRead };
      }
      if (type === 'response.failed') {
        const err = res?.error as { message?: string; code?: string } | string | undefined;
        const message = typeof err === 'string' ? err : err?.message || 'response.failed';
        fail(`${provider} API error (stream): ${message}`, typeof err === 'object' ? err?.code : undefined);
      }
      if (type === 'response.incomplete') {
        const details = res?.incomplete_details as { reason?: string } | undefined;
        finishReason = details?.reason === 'max_output_tokens' ? 'MAX_TOKENS' : details?.reason?.toUpperCase();
      }
      return;
    }
    if (type === 'error') {
      const message = typeof chunk.message === 'string' ? chunk.message : JSON.stringify(chunk);
      fail(`${provider} API error (stream): ${message}`, typeof chunk.code === 'string' ? chunk.code : undefined);
    }
  };

  try {
    while (true) {
      const read = await reader
        .read()
        .catch((err: Error) => fail(`${provider} stream failed for model ${model}: ${err.message}`));
      const { done, value } = read;
      let pending: string | null = null;
      if (done) {
        const residual = buffer + decoder.decode();
        if (!residual.trim()) break;
        pending = residual;
      } else {
        buffer += decoder.decode(value, { stream: true });
      }
      const lines = (pending ?? buffer).split('\n');
      buffer = pending === null ? (lines.pop() ?? '') : '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trimStart();
        if (data === '[DONE]') continue;
        handle(data);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  frames.assertHealthy(provider, model);

  const toolCalls: ToolCall[] = [...toolAccum.values()].map((acc) => ({
    id: acc.id,
    name: acc.name,
    arguments: parseArguments(acc.args),
  }));

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: usage
      ? wireUsage(info, usage.input, usage.output, usage.cacheRead)
      : wireUsage(info, 0, 0),
    // A stream that ended without a terminal event reports no usage: zeros are not a measurement.
    usageMissing: !usageSeen,
    finishReason,
  };
}

/** Same marker the other wires use, so the registry refuses to run a tool on unparseable arguments. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw, __invalidJson: true };
  }
}
