// src/llm/providers/google-shared.ts - Gemini request body and SSE stream shared by the three Google wires
//
// `google-generative-ai`, `google-gemini-cli` and `google-vertex` speak the same `generateContent`
// format; they differ only in URL, authentication and (for Cloud Code Assist) an outer envelope.

import crypto from 'node:crypto';
import type { Message, ToolCall, ToolDefinition } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import type { ChatParams, ChatResult } from '../base-provider.js';
import { ProviderError, SseFrameCounter, throwHttpError } from '../provider-error.js';
import { wireUsage } from '../wire-usage.js';

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

export interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  tools?: { functionDeclarations: { name: string; description: string; parameters: unknown }[] }[];
  generationConfig?: { temperature?: number; maxOutputTokens?: number; thinkingConfig?: { includeThoughts: boolean } };
}

/** One SSE frame; Cloud Code Assist wraps the same object in `response`. */
export interface GeminiChunk {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

// JSON Schema keywords the Gemini `Schema` object rejects.
const UNSUPPORTED_SCHEMA_KEYS = new Set(['$schema', '$id', '$defs', 'definitions', 'additionalProperties', 'patternProperties', 'examples', 'const']);

export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema as Record<string, unknown>)
    .filter(([key]) => !UNSUPPORTED_SCHEMA_KEYS.has(key))
    // `properties` maps names to schemas; a property named like a keyword must survive.
    .map(([key, value]) => [key, key === 'properties' && value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toGeminiSchema(v)]))
      : toGeminiSchema(value)]));
}

/** Appends to the previous content when the role repeats; Gemini expects alternating turns. */
function push(contents: GeminiContent[], role: GeminiContent['role'], parts: GeminiPart[]): void {
  if (parts.length === 0) return;
  const last = contents.at(-1);
  if (last && last.role === role) last.parts.push(...parts);
  else contents.push({ role, parts });
}

export function buildGeminiRequest(
  info: ModelInfo,
  params: Pick<ChatParams, 'messages' | 'tools' | 'temperature' | 'maxTokens'>,
): GeminiRequest {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of params.messages) {
    if (m.role === 'system') {
      if (m.content) system.push(m.content);
    } else if (m.role === 'user') {
      push(contents, 'user', [{ text: m.content }]);
    } else if (m.role === 'assistant') {
      push(contents, 'model', assistantParts(m));
    } else {
      // Tool results go back as `functionResponse` parts in a user turn, matched by name (and id when present).
      const response = m.isError ? { error: m.content } : { output: m.content };
      push(contents, 'user', [{ functionResponse: { ...(m.toolCallId && { id: m.toolCallId }), name: m.name ?? 'tool', response } }]);
    }
  }
  const request: GeminiRequest = { contents };
  if (system.length) request.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  if (params.tools?.length) request.tools = [{ functionDeclarations: params.tools.map(toDeclaration) }];
  const generationConfig: NonNullable<GeminiRequest['generationConfig']> = {};
  if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
  if (params.maxTokens !== undefined) generationConfig.maxOutputTokens = params.maxTokens;
  // Without includeThoughts a reasoning model thinks silently and the TUI has no thinking peek.
  if (info.reasoning) generationConfig.thinkingConfig = { includeThoughts: true };
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
  return request;
}

function assistantParts(m: Message): GeminiPart[] {
  const parts: GeminiPart[] = m.content ? [{ text: m.content }] : [];
  for (const tc of m.toolCalls ?? []) {
    // Gemini 3 rejects a replayed function call without the signature it issued.
    parts.push({ functionCall: { ...(!tc.id.startsWith('call_') && { id: tc.id }), name: tc.name, args: tc.arguments }, ...(tc.thoughtSignature && { thoughtSignature: tc.thoughtSignature }) });
  }
  return parts;
}

function toDeclaration(t: ToolDefinition) {
  return { name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) };
}

export interface GeminiCallOptions {
  provider: string;
  info: ModelInfo;
  model: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  params: Pick<ChatParams, 'onToken' | 'onThinking' | 'signal'>;
}

/** POSTs the request and reads the `alt=sse` stream into a ChatResult. */
export async function requestGemini(opts: GeminiCallOptions): Promise<ChatResult> {
  const { provider, model, params } = opts;
  const response = await fetch(opts.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...opts.headers },
    body: JSON.stringify(opts.body),
    signal: params.signal,
  });
  if (!response.ok) await throwHttpError(response, provider, model);
  if (!response.body) throw new ProviderError(`${provider}: empty response body for model ${model}`, { provider, model });

  let content = '';
  const toolCalls: ToolCall[] = [];
  let usage: GeminiChunk['usageMetadata'];
  let finishReason: string | undefined;
  const frames = new SseFrameCounter();

  const handle = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const parsed = frames.parse<GeminiChunk & { response?: GeminiChunk }>(data);
    if (!parsed) return;
    if (parsed.error) {
      throw new ProviderError(`${provider} API error (stream): ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
        { provider, model, status: parsed.error.code, code: parsed.error.status, partialContent: content });
    }
    const chunk = parsed.response ?? parsed;
    if (chunk.promptFeedback?.blockReason) {
      throw new ProviderError(`${provider}: prompt blocked (${chunk.promptFeedback.blockReason}) for model ${model}`,
        { provider, model, code: chunk.promptFeedback.blockReason, partialContent: content });
    }
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        toolCalls.push({
          // The loop pairs results by id; Gemini often omits it.
          id: part.functionCall.id || `call_${crypto.randomUUID()}`,
          name: part.functionCall.name ?? '',
          arguments: part.functionCall.args ?? {},
          ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
        });
      } else if (part.text) {
        if (part.thought) params.onThinking?.(part.text);
        else {
          content += part.text;
          params.onToken?.(part.text);
        }
      }
    }
  };

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes as Uint8Array, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(handle);
  }
  handle(buffer + decoder.decode());
  frames.assertHealthy(provider, model);

  // promptTokenCount includes cached tokens; thinking tokens are billed as output.
  const cached = usage?.cachedContentTokenCount ?? 0;
  const output = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
  return {
    content,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    usage: wireUsage(opts.info, Math.max(0, (usage?.promptTokenCount ?? 0) - cached), output, cached),
    usageMissing: !usage,
    finishReason: finishReason && finishReason !== 'STOP' ? finishReason : undefined,
  };
}

/** Base URL without trailing slashes. */
export function trimBase(url: string): string { return url.replace(/\/+$/, ''); }
