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

export class AnthropicProvider extends BaseLLMProvider {
  readonly name: LLMProviderType = 'anthropic';
  private credentials?: ProviderCredentials;

  constructor(credentials?: ProviderCredentials) {
    super();
    this.credentials = credentials;
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
      (typeof process !== 'undefined' ? process.env?.ANTHROPIC_API_KEY : '') ||
      '';

    if (!apiKey) {
      throw new Error('Anthropic API key is required. Set it in configuration or ANTHROPIC_API_KEY environment variable.');
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

    if (systemPrompt) {
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
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31,output-128k-2025-02-19',
      // Catalog headers (providers.md section 7.1) carry provider differences, so they go out last.
      ...this.credentials?.headers,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
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
