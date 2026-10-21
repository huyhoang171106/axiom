// src/llm/providers/anthropic.ts - Anthropic Claude LLM Provider

import type {
  LLMProviderType,
  Message,
  ToolDefinition,
  ToolCall,
  TokenUsage,
  ProviderCredentials,
} from '../../core/types.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { defaultCostTracker } from '../cost-tracker.js';
import {
  ProviderError,
  SseFrameCounter,
  readJsonBody,
  sseErrorFrame,
  throwHttpError,
} from '../provider-error.js';
import crypto from 'node:crypto';
import { hasHeader } from './responses-shared.js';
import { readAuth } from '../auth/store.js';

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  thinking?: string;
}

interface AnthropicMessagePayload {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

const CCH_SEED = 0x4d659218e32a3268n;
const CCH_PLACEHOLDER_STR = 'cch=00000';

function xxhash64(buffer: Buffer, seed = 0n): bigint {
  const b = buffer;
  const P1 = 0x9e3779b185ebca87n;
  const P2 = 0xc2b2ae3d27d4eb4fn;
  const P3 = 0x165667b19e3779f9n;
  const P4 = 0x85ebca77c2b2ae63n;
  const P5 = 0x27d4eb2f165667c5n;
  const MASK = 0xffffffffffffffffn;

  const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (64n - r))) & MASK;
  const round = (acc: bigint, input: bigint) => (rotl((acc + input * P2) & MASK, 31n) * P1) & MASK;
  const mergeRound = (acc: bigint, val: bigint) => {
    const r = round(0n, val);
    let a = acc ^ r;
    a = (a * P1 + P4) & MASK;
    return a;
  };

  const len = BigInt(b.length);
  let h64 = 0n;
  let offset = 0;

  if (b.length >= 32) {
    let v1 = (seed + P1 + P2) & MASK;
    let v2 = (seed + P2) & MASK;
    let v3 = seed & MASK;
    let v4 = (seed - P1) & MASK;

    const limit = b.length - 32;
    while (offset <= limit) {
      v1 = round(v1, b.readBigUInt64LE(offset)); offset += 8;
      v2 = round(v2, b.readBigUInt64LE(offset)); offset += 8;
      v3 = round(v3, b.readBigUInt64LE(offset)); offset += 8;
      v4 = round(v4, b.readBigUInt64LE(offset)); offset += 8;
    }

    h64 = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
    h64 = mergeRound(h64, v1);
    h64 = mergeRound(h64, v2);
    h64 = mergeRound(h64, v3);
    h64 = mergeRound(h64, v4);
  } else {
    h64 = (seed + P5) & MASK;
  }

  h64 = (h64 + len) & MASK;

  while (offset + 8 <= b.length) {
    const k1 = round(0n, b.readBigUInt64LE(offset));
    h64 ^= k1;
    h64 = (rotl(h64, 27n) * P1 + P4) & MASK;
    offset += 8;
  }

  if (offset + 4 <= b.length) {
    h64 ^= (BigInt(b.readUInt32LE(offset)) * P1) & MASK;
    h64 = (rotl(h64, 23n) * P2 + P3) & MASK;
    offset += 4;
  }

  while (offset < b.length) {
    h64 ^= (BigInt(b[offset]!) * P5) & MASK;
    h64 = (rotl(h64, 11n) * P1) & MASK;
    offset += 1;
  }

  h64 ^= h64 >> 33n;
  h64 = (h64 * P2) & MASK;
  h64 ^= h64 >> 29n;
  h64 = (h64 * P3) & MASK;
  h64 ^= h64 >> 32n;

  return h64;
}

function createClaudeBillingHeader(firstUserMessageText: string): string {
  const k = [4, 7, 20].map((i) => firstUserMessageText[i] ?? '0').join('');
  const version = '2.1.280';
  const versionSuffix = crypto.createHash('sha256').update(`59cf53e54c78${k}${version}`).digest('hex').slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${version}.${versionSuffix}; cc_entrypoint=cli; ${CCH_PLACEHOLDER_STR};`;
}

function patchCch(bodyBuffer: Buffer): 'patched' | 'no-billing-header' | 'unanchored' {
  const marker = Buffer.from('"system":[{"type":"text","text":"x-anthropic-billing-header:');
  const placeholder = Buffer.from(CCH_PLACEHOLDER_STR);
  const markerIdx = bodyBuffer.indexOf(marker);
  if (markerIdx === -1) return 'no-billing-header';
  const searchFrom = markerIdx + marker.length;
  const idx = bodyBuffer.indexOf(placeholder, searchFrom);
  if (idx === -1 || idx - searchFrom > 150) return 'unanchored';
  const h = xxhash64(bodyBuffer, CCH_SEED);
  const cch = (h & 0xfffffn).toString(16).padStart(5, '0');
  for (let i = 0; i < 5; i++) {
    bodyBuffer[idx + 4 + i] = cch.charCodeAt(i);
  }
  return 'patched';
}

function isStoredOAuth(providerName: string, apiKey: string): boolean {
  try {
    const stored = readAuth()[providerName];
    return stored?.type === 'oauth' && stored.access === apiKey;
  } catch {
    return false;
  }
}

export class AnthropicProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;
  private credentials?: ProviderCredentials;

  constructor(credentials?: ProviderCredentials, name: LLMProviderType = 'anthropic') {
    super();
    this.credentials = credentials;
    this.name = name;
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    const {
      model,
      messages,
      tools,
      temperature,
      maxTokens = 4096,
      onToken,
      onThinking,
      signal,
    } = params;

    const apiKey =
      this.credentials?.apiKey ||
      (typeof process !== 'undefined' ? (process.env?.ANTHROPIC_OAUTH_TOKEN || process.env?.ANTHROPIC_API_KEY) : '') ||
      '';

    const hasAuthHeader = hasHeader(this.credentials?.headers, 'authorization');
    if (!apiKey && !hasAuthHeader) {
      throw new Error('Anthropic API key or OAuth token is required. Set it in configuration or ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN environment variable.');
    }

    const baseUrl = (this.credentials?.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    const url = `${baseUrl}/messages`;

    // 1. Extract system messages
    const systemMessages = messages.filter((m) => m.role === 'system');
    const systemPrompt = systemMessages.map((m) => m.content).join('\n\n');

    // 2. Format conversation messages (user / assistant / tool)
    const formattedMessages = this.formatMessages(messages);

    // 3. Format tool definitions
    const formattedTools = tools?.map((t: ToolDefinition) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    // 4. Build request payload
    const isThinkingModel = model.includes('3-7') || model.includes('thinking');
    const requestBody: Record<string, unknown> = {
      model,
      messages: formattedMessages,
      max_tokens: maxTokens,
    };

    const isOAuth = Boolean(
      apiKey && (
        apiKey.includes('sk-ant-oat') ||
        apiKey.startsWith('sk-ant-oat') ||
        (typeof process !== 'undefined' && Boolean(process.env?.ANTHROPIC_OAUTH_TOKEN) && apiKey === process.env.ANTHROPIC_OAUTH_TOKEN) ||
        this.credentials?.source === 'subscription' ||
        isStoredOAuth(this.name, apiKey)
      )
    );

    const isCopilotOrGitlab = this.name === 'github-copilot' || this.name === 'gitlab-duo';
    const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

    if (isOAuth) {
      const firstUserMsg = messages.find((m) => m.role === 'user');
      const firstUserText = typeof firstUserMsg?.content === 'string' ? firstUserMsg.content : '';
      const billingHeader = createClaudeBillingHeader(firstUserText);
      const systemBlocks: Array<{ type: 'text'; text: string }> = [
        { type: 'text', text: billingHeader },
        { type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX },
      ];
      if (systemPrompt) {
        systemBlocks.push({ type: 'text', text: systemPrompt });
      }
      requestBody.system = systemBlocks;
    } else if (systemPrompt) {
      requestBody.system = systemPrompt;
    }

    if (formattedTools && formattedTools.length > 0) {
      requestBody.tools = formattedTools;
    }

    if (temperature !== undefined && !isThinkingModel) {
      requestBody.temperature = temperature;
    }

    const isStreaming = Boolean(onToken || onThinking);
    if (isStreaming) {
      requestBody.stream = true;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31,output-128k-2025-02-19',
    };

    if (isOAuth) {
      headers['authorization'] = `Bearer ${apiKey}`;
      headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      headers['user-agent'] = 'claude-cli/2.1.280 (external, cli)';
      headers['x-app'] = 'cli';
    } else if (isCopilotOrGitlab) {
      headers['authorization'] = `Bearer ${apiKey}`;
    } else if (apiKey && !hasAuthHeader) {
      headers['x-api-key'] = apiKey;
    }

    // Catalog headers (providers.md section 7.1) carry provider differences, so they go out last.
    Object.assign(headers, this.credentials?.headers);

    if (hasHeader(headers, 'authorization') && !hasHeader(this.credentials?.headers, 'x-api-key') && (isOAuth || isCopilotOrGitlab)) {
      delete headers['x-api-key'];
    }

    const jsonStr = JSON.stringify(requestBody);
    let bodyData: string | Buffer = jsonStr;
    if (isOAuth) {
      const buf = Buffer.from(jsonStr, 'utf-8');
      patchCch(buf);
      bodyData = buf;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyData,
      signal,
    });

    if (!response.ok) await throwHttpError(response, 'Anthropic', model);

    if (isStreaming) {
      return this.handleStreamResponse(response, model, onToken, onThinking);
    } else {
      return this.handleJsonResponse(response, model, onThinking);
    }
  }

  private formatMessages(messages: Message[]): AnthropicMessagePayload[] {
    const nonSystem = messages.filter((m) => m.role !== 'system');
    if (nonSystem.length === 0) {
      return [{ role: 'user', content: 'Hello' }];
    }

    const rawFormatted: AnthropicMessagePayload[] = [];

    for (const msg of nonSystem) {
      if (msg.role === 'tool') {
        rawFormatted.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId || '',
              content: msg.content,
            },
          ],
        });
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const blocks: AnthropicContentBlock[] = [];
          if (msg.content) {
            blocks.push({ type: 'text', text: msg.content });
          }
          for (const tc of msg.toolCalls) {
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
          rawFormatted.push({
            role: 'assistant',
            content: blocks,
          });
        } else {
          rawFormatted.push({
            role: 'assistant',
            content: msg.content,
          });
        }
      } else {
        // user role
        rawFormatted.push({
          role: 'user',
          content: msg.content,
        });
      }
    }

    // Merge consecutive messages with the same role
    const merged: AnthropicMessagePayload[] = [];
    for (const cur of rawFormatted) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === cur.role) {
        const prevBlocks: AnthropicContentBlock[] = Array.isArray(prev.content)
          ? prev.content
          : [{ type: 'text', text: prev.content }];
        const curBlocks: AnthropicContentBlock[] = Array.isArray(cur.content)
          ? cur.content
          : [{ type: 'text', text: cur.content }];

        prev.content = [...prevBlocks, ...curBlocks];
      } else {
        merged.push(cur);
      }
    }

    // Anthropic requires the first message to have role 'user'
    if (merged.length > 0 && merged[0].role !== 'user') {
      merged.unshift({ role: 'user', content: 'Continue' });
    }

    return merged;
  }

  private async handleJsonResponse(
    response: Response,
    model: string,
    onThinking?: (thought: string) => void
  ): Promise<ChatResult> {
    const data = await readJsonBody<Record<string, any>>(response, 'Anthropic', model);
    let textContent = '';
    const toolCalls: ToolCall[] = [];

    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textContent += block.text;
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          onThinking?.(block.thinking);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || '',
            name: block.name || '',
            arguments: (block.input as Record<string, unknown>) || {},
          });
        }
      }
    }

    const promptTokens = data.usage?.input_tokens ?? 0;
    const completionTokens = data.usage?.output_tokens ?? 0;
    const cacheCreationInputTokens = data.usage?.cache_creation_input_tokens;
    const cacheReadInputTokens = data.usage?.cache_read_input_tokens;
    const totalTokens = promptTokens + completionTokens;

    const costEstimate = defaultCostTracker.calculateCost(
      model,
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
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }

  /** Usage for an error thrown mid-stream: a failed call must not be recorded as free. */
  private usageSoFar(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cacheReadInputTokens?: number
  ): TokenUsage {
    const totalTokens = promptTokens + completionTokens;
    return {
      promptTokens,
      completionTokens,
      cacheReadInputTokens,
      totalTokens,
      costEstimate: defaultCostTracker.calculateCost(model, promptTokens, completionTokens, cacheReadInputTokens),
    };
  }

  /** Annotates a dropped connection with the provider, model and the tokens already streamed. */
  private streamFailure(
    err: unknown,
    model: string,
    partialContent: string,
    promptTokens: number,
    completionTokens: number
  ): Error {
    if (err instanceof ProviderError) return err;
    if ((err as Error)?.name === 'AbortError') return err as Error;
    const usage = this.usageSoFar(model, promptTokens, completionTokens);
    return new ProviderError(
      `Anthropic stream failed for model ${model} after ${promptTokens + completionTokens} tokens: ${
        (err as Error)?.message ?? String(err)
      }`,
      { provider: 'Anthropic', model, partialContent, usage }
    );
  }

  private async handleStreamResponse(
    response: Response,
    model: string,
    onToken?: (token: string) => void,
    onThinking?: (thought: string) => void
  ): Promise<ChatResult> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body stream is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let textContent = '';

    interface StreamToolCall {
      id: string;
      name: string;
      partialJson: string;
    }
    const toolCallsMap: Map<number, StreamToolCall> = new Map();

    let promptTokens = 0;
    let completionTokens = 0;
    let cacheCreationInputTokens: number | undefined;
    let cacheReadInputTokens: number | undefined;
    const frames = new SseFrameCounter();

    // Any exit (including a thrown provider error) must release the response body, or the socket
    // stays open until the process ends.
    try {
      while (true) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          throw this.streamFailure(err, model, textContent, promptTokens, completionTokens);
        }
        const { done, value } = chunk;
        let pending: string | null = null;
        if (done) {
          // Flush the decoder and process the last event: an SSE stream commonly ends without a
          // trailing newline, so the final frame used to be discarded.
          const residual = buffer + decoder.decode();
          if (!residual.trim()) break;
          pending = residual;
        } else {
          buffer += decoder.decode(value, { stream: true });
        }

        const lines = (pending ?? buffer).split('\n');
        buffer = pending === null ? lines.pop() ?? '' : '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data:')) {
            // `data:` is also valid without the optional space; some gateways omit it and those
            // frames used to be skipped entirely.
            const dataStr = trimmed.slice(5).trimStart();
            if (dataStr === '[DONE]') continue;

            const eventData = frames.parse(dataStr);
            if (!eventData) continue;

            const type = eventData.type as string;

            // An in-stream error arrives on a 200 response (overloaded, prompt_too_long, ...). Ignoring it
            // returned a successful empty completion with the cost understated.
            const streamError = sseErrorFrame(eventData);
            if (type === 'error' || streamError) {
              const usage = this.usageSoFar(model, promptTokens, completionTokens, cacheReadInputTokens);
              throw new ProviderError(
                `Anthropic API error (stream): ${streamError?.message ?? 'unknown error'}`,
                {
                  provider: 'Anthropic',
                  model,
                  code: streamError?.code,
                  partialContent: textContent,
                  usage,
                }
              );
            }

            if (type === 'message_start') {
              const msg = eventData.message as Record<string, unknown> | undefined;
              const usage = msg?.usage as Record<string, number> | undefined;
              if (usage) {
                promptTokens = usage.input_tokens ?? promptTokens;
                cacheCreationInputTokens = usage.cache_creation_input_tokens;
                cacheReadInputTokens = usage.cache_read_input_tokens;
              }
            } else if (type === 'content_block_start') {
              const index = eventData.index as number;
              const block = eventData.content_block as Record<string, unknown> | undefined;
              if (block?.type === 'tool_use') {
                toolCallsMap.set(index, {
                  id: (block.id as string) || '',
                  name: (block.name as string) || '',
                  partialJson: '',
                });
              }
            } else if (type === 'content_block_delta') {
              const index = eventData.index as number;
              const delta = eventData.delta as Record<string, unknown> | undefined;

              if (delta?.type === 'text_delta') {
                const text = (delta.text as string) || '';
                textContent += text;
                onToken?.(text);
              } else if (delta?.type === 'thinking_delta') {
                const thought = (delta.thinking as string) || '';
                onThinking?.(thought);
              } else if (delta?.type === 'input_json_delta') {
                const partial = (delta.partial_json as string) || '';
                const tc = toolCallsMap.get(index);
                if (tc) {
                  tc.partialJson += partial;
                }
              }
            } else if (type === 'message_delta') {
              const usage = eventData.usage as Record<string, number> | undefined;
              if (usage?.output_tokens !== undefined) {
                completionTokens = usage.output_tokens;
              }
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    frames.assertHealthy('Anthropic', model);

    // Build assembled tool calls
    const toolCalls: ToolCall[] = [];
    for (const [, tc] of toolCallsMap.entries()) {
      let args: Record<string, unknown> = {};
      try {
        args = tc.partialJson ? JSON.parse(tc.partialJson) : {};
      } catch {
        // Keep the text, but mark it: the registry turns this into a tool error instead of running a
        // tool with a nonsense `raw` argument (a truncated stream used to look like a normal call).
        args = { raw: tc.partialJson, __invalidJson: true };
      }
      toolCalls.push({
        id: tc.id,
        name: tc.name,
        arguments: args,
      });
    }

    const totalTokens = promptTokens + completionTokens;
    const costEstimate = defaultCostTracker.calculateCost(
      model,
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
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }
}
