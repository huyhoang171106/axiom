// src/llm/providers/openai.ts - OpenAI-compatible LLM Provider (OpenAI, OpenRouter, DeepSeek, Ollama)

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

/** Env var that holds the key for each alias this provider serves. */
const API_KEY_ENV: Partial<Record<string, string>> = {
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  tokenharbor: 'TOKENHARBOR_API_KEY',
  tokenhabour: 'TOKENHARBOR_API_KEY',
};

interface OpenAIToolCallPayload {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIMessagePayload {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCallPayload[];
}

export class OpenAIProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;
  private credentials?: ProviderCredentials;

  constructor(credentials?: ProviderCredentials, providerName: LLMProviderType = 'openai') {
    super();
    this.name = providerName;
    this.credentials = credentials;
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    const {
      model,
      messages,
      tools,
      temperature,
      maxTokens,
      onToken,
      onThinking,
      signal,
    } = params;

    const { key: apiKey, required: keyRequired, envName } = this.resolveApiKey();
    if (!apiKey && keyRequired) {
      throw new ProviderError(
        `${this.name}: no API key for this provider. Set ${envName} or store a credential for it; the request was not sent.`,
        { provider: this.name, model, code: 'missing_api_key' }
      );
    }
    const endpointUrl = this.resolveEndpointUrl();

    const formattedMessages: OpenAIMessagePayload[] = messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.toolCallId || '',
          content: m.content,
        };
      }
      if (m.role === 'assistant') {
        if (m.toolCalls && m.toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
              },
            })),
          };
        }
        return {
          role: 'assistant',
          content: m.content,
        };
      }
      return {
        role: m.role,
        content: m.content,
      };
    });

    const isReasoningModel = model.startsWith('o1') || model.startsWith('o3') || model.includes('reasoner');
    const requestBody: Record<string, unknown> = {
      model,
      messages: formattedMessages,
    };

    if (tools && tools.length > 0) {
      requestBody.tools = tools.map((t: ToolDefinition) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      requestBody.tool_choice = 'auto';
    }

    if (maxTokens !== undefined) {
      if (isReasoningModel) {
        requestBody.max_completion_tokens = maxTokens;
      } else {
        requestBody.max_tokens = maxTokens;
      }
    }

    if (temperature !== undefined && !isReasoningModel) {
      requestBody.temperature = temperature;
    }

    const isStreaming = Boolean(onToken || onThinking);
    if (isStreaming) {
      requestBody.stream = true;
      requestBody.stream_options = { include_usage: true };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    if (this.credentials?.organizationId) {
      headers['OpenAI-Organization'] = this.credentials.organizationId;
    }

    if (this.name === 'openrouter') {
      headers['HTTP-Referer'] = 'https://axiom.dev';
      headers['X-Title'] = 'Axiom Agent';
    }

    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) await throwHttpError(response, this.name, model);

    if (isStreaming) {
      return this.handleStreamResponse(response, model, onToken, onThinking);
    } else {
      return this.handleJsonResponse(response, model, onThinking);
    }
  }

  /**
   * Key for this provider and whether the request needs one at all.
   *
   * The old version fell through to `OPENAI_API_KEY` for every alias, so selecting `deepseek` (or groq,
   * fireworks, tokenharbor) with an OpenAI key in the environment sent that key to the other vendor, and
   * with no key at all it sent the request unauthenticated instead of saying the key was missing. A local
   * endpoint (ollama, a self-hosted OpenAI-compatible server) still works without a key.
   */
  private resolveApiKey(): { key: string; required: boolean; envName?: string } {
    const env = typeof process !== 'undefined' ? process.env : undefined;
    if (this.name === 'ollama') return { key: this.credentials?.apiKey || 'ollama', required: false };
    const envName = API_KEY_ENV[this.name] ?? 'OPENAI_API_KEY';
    const key = this.credentials?.apiKey || env?.[envName] || '';
    if (key) return { key, required: false, envName };
    // A self-hosted endpoint (vLLM, LiteLLM, a proxy on localhost) commonly has no key at all.
    const localEndpoint = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/.test(this.resolveEndpointUrl());
    return { key: '', required: !localEndpoint, envName };
  }

  private resolveEndpointUrl(): string {
    const rawBase = this.credentials?.baseUrl?.replace(/\/+$/, '');
    if (rawBase) {
      return rawBase.endsWith('/chat/completions') ? rawBase : `${rawBase}/chat/completions`;
    }
    if (this.name === 'openrouter') {
      return 'https://openrouter.ai/api/v1/chat/completions';
    }
    if (this.name === 'ollama') {
      return 'http://localhost:11434/v1/chat/completions';
    }
    return 'https://api.openai.com/v1/chat/completions';
  }

  private async handleJsonResponse(
    response: Response,
    model: string,
    onThinking?: (thought: string) => void
  ): Promise<ChatResult> {
    const data = await readJsonBody<Record<string, any>>(response, this.name, model);
    const choice = data?.choices?.[0];
    const message = choice?.message;

    const textContent = message?.content || '';
    const reasoning = message?.reasoning_content || message?.reasoning;
    if (reasoning && typeof reasoning === 'string') {
      onThinking?.(reasoning);
    }

    const toolCalls: ToolCall[] = [];
    if (Array.isArray(message?.tool_calls)) {
      for (const tc of message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {};
        } catch {
          args = { raw: tc.function?.arguments, __invalidJson: true };
        }
        toolCalls.push({
          id: tc.id || '',
          name: tc.function?.name || '',
          arguments: args,
        });
      }
    }

    const usageData = data?.usage;
    const promptTokens = usageData?.prompt_tokens ?? 0;
    const completionTokens = usageData?.completion_tokens ?? 0;
    const cacheReadInputTokens = usageData?.prompt_tokens_details?.cached_tokens;
    const totalTokens = usageData?.total_tokens ?? (promptTokens + completionTokens);

    const costEstimate = defaultCostTracker.calculateCost(
      model,
      promptTokens,
      completionTokens,
      cacheReadInputTokens
    );

    const usage: TokenUsage = {
      promptTokens,
      completionTokens,
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

    interface StreamToolAccumulator {
      id: string;
      name: string;
      arguments: string;
    }
    const toolCallsByIndex: Record<number, StreamToolAccumulator> = {};

    let promptTokens = 0;
    let completionTokens = 0;
    let cacheReadInputTokens: number | undefined;
    // `stream_options.include_usage` asks for a final usage chunk; if it never arrives the zeros below are
    // not measurements, and the caller is told so instead of recording a free call.
    let usageSeen = false;
    const frames = new SseFrameCounter();

    // Any exit (including a thrown provider error) must release the response body, or the socket
    // stays open until the process ends.
    try {
      while (true) {
        let read: Awaited<ReturnType<typeof reader.read>>;
        try {
          read = await reader.read();
        } catch (err) {
          throw this.streamFailure(err, model, textContent, promptTokens, completionTokens, cacheReadInputTokens);
        }
        const { done, value } = read;
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

            const chunk = frames.parse(dataStr);
            if (!chunk) continue;

            // OpenAI-compatible endpoints report in-stream failures as `data: {"error": ...}` on a 200
            // response (401 after headers, 429, quota). Those used to end the stream as a success.
            const chunkError = sseErrorFrame(chunk);
            if (chunkError) {
              throw new ProviderError(`API error (stream): ${chunkError.message}`, {
                provider: this.name,
                model,
                code: chunkError.code,
                partialContent: textContent,
                usage: this.usageSoFar(model, promptTokens, completionTokens, cacheReadInputTokens),
              });
            }

            const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
            const delta = choice?.delta as Record<string, unknown> | undefined;

            if (delta) {
              if (typeof delta.content === 'string') {
                textContent += delta.content;
                onToken?.(delta.content);
              }

              const reasoning = delta.reasoning_content || delta.reasoning;
              if (typeof reasoning === 'string') {
                onThinking?.(reasoning);
              }

              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
                  const idx = (tc.index as number) ?? 0;
                  if (!toolCallsByIndex[idx]) {
                    toolCallsByIndex[idx] = {
                      id: (tc.id as string) || `call_${idx}`,
                      name: (tc.function as Record<string, string> | undefined)?.name || '',
                      arguments: '',
                    };
                  }
                  const acc = toolCallsByIndex[idx];
                  if (tc.id) {
                    acc.id = tc.id as string;
                  }
                  const fn = tc.function as Record<string, string> | undefined;
                  if (fn?.name) {
                    acc.name = fn.name;
                  }
                  if (fn?.arguments) {
                    acc.arguments += fn.arguments;
                  }
                }
              }
            }

            const chunkUsage = chunk.usage as Record<string, unknown> | undefined;
            if (chunkUsage) {
              usageSeen = true;
              if (typeof chunkUsage.prompt_tokens === 'number') {
                promptTokens = chunkUsage.prompt_tokens;
              }
              if (typeof chunkUsage.completion_tokens === 'number') {
                completionTokens = chunkUsage.completion_tokens;
              }
              const details = chunkUsage.prompt_tokens_details as Record<string, number> | undefined;
              if (details?.cached_tokens !== undefined) {
                cacheReadInputTokens = details.cached_tokens;
              }
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    frames.assertHealthy(this.name, model);

    const toolCalls: ToolCall[] = Object.values(toolCallsByIndex).map((acc) => {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = acc.arguments ? JSON.parse(acc.arguments) : {};
      } catch {
        parsedArgs = { raw: acc.arguments, __invalidJson: true };
      }
      return {
        id: acc.id,
        name: acc.name,
        arguments: parsedArgs,
      };
    });

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
      cacheReadInputTokens,
      totalTokens,
      costEstimate,
    };

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      usageMissing: !usageSeen,
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
    completionTokens: number,
    cacheReadInputTokens?: number
  ): Error {
    if (err instanceof ProviderError) return err;
    if ((err as Error)?.name === 'AbortError') return err as Error;
    return new ProviderError(
      `${this.name} stream failed for model ${model} after ${promptTokens + completionTokens} tokens: ${
        (err as Error)?.message ?? String(err)
      }`,
      {
        provider: this.name,
        model,
        partialContent,
        usage: this.usageSoFar(model, promptTokens, completionTokens, cacheReadInputTokens),
      }
    );
  }
}
