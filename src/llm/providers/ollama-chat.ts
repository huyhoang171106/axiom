// src/llm/providers/ollama-chat.ts - `ollama-chat` wire: Ollama native POST /api/chat, NDJSON stream

import crypto from 'node:crypto';
import type { LLMProviderType, Message, ToolCall } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { ProviderError, throwHttpError } from '../provider-error.js';
import { wireUsage } from '../wire-usage.js';

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

/** One NDJSON line of the stream; every field is optional on the wire. */
interface OllamaChunk {
  error?: string;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { id?: string; function?: { name?: string; arguments?: Record<string, unknown> | string } }[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaChatProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  async chat({ model, messages, tools, temperature, maxTokens, onToken, onThinking, signal }: ChatParams): Promise<ChatResult> {
    const options = { ...(temperature !== undefined && { temperature }), ...(maxTokens !== undefined && { num_predict: maxTokens }) };
    const body = {
      model,
      messages: messages.map(toOllamaMessage),
      tools: tools?.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      stream: true,
      options,
    };
    // Local Ollama needs no key; Ollama Cloud takes the key as a bearer token.
    const response = await fetch(`${this.info.baseUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.info.headers, ...(this.credential && { authorization: `Bearer ${this.credential}` }) },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) await throwHttpError(response, this.name, model);
    if (!response.body) throw new ProviderError(`${this.name}: empty response body for model ${model}`, { provider: this.name, model });

    let content = '';
    const toolCalls: ToolCall[] = [];
    let last: OllamaChunk | undefined;
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = (line: string) => {
      if (!line.trim()) return;
      let chunk: OllamaChunk;
      try {
        chunk = JSON.parse(line) as OllamaChunk;
      } catch {
        throw new ProviderError(`${this.name}: malformed stream line for model ${model}: ${line.slice(0, 200)}`, { provider: this.name, model, partialContent: content });
      }
      // Ollama reports failures after a 200 as an `error` line (model unloaded, out of memory).
      if (chunk.error) throw new ProviderError(`${this.name} API error (stream): ${chunk.error}`, { provider: this.name, model, partialContent: content });
      const message = chunk.message;
      if (message?.thinking) onThinking?.(message.thinking);
      if (message?.content) {
        content += message.content;
        onToken?.(message.content);
      }
      for (const tc of message?.tool_calls ?? []) {
        const args = tc.function?.arguments;
        toolCalls.push({
          // Ollama often omits ids; the loop needs a unique one to pair the result with its call.
          id: tc.id || `call_${crypto.randomUUID()}`,
          name: tc.function?.name ?? '',
          arguments: typeof args === 'string' ? parseArguments(args) : (args ?? {}),
        });
      }
      if (chunk.done) last = chunk;
    };

    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes as Uint8Array, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(handle);
    }
    handle(buffer + decoder.decode());

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: wireUsage(this.info, last?.prompt_eval_count ?? 0, last?.eval_count ?? 0),
      // No final `done` line means the stream was cut and the counts above are not measurements.
      usageMissing: !last,
      finishReason: last?.done_reason && last.done_reason !== 'stop' ? last.done_reason : undefined,
    };
  }
}

function toOllamaMessage(m: Message): OllamaMessage {
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return { role: 'assistant', content: m.content, tool_calls: m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments } })) };
  }
  return { role: m.role, content: m.content };
}

/** Same marker the other wires use, so the registry refuses to run a tool on unparseable arguments. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw, __invalidJson: true };
  }
}
