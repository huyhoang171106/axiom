// src/llm/providers/google-generative-ai.ts - `google-generative-ai` wire (Google Gemini API)

import type { LLMProviderType } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { ProviderError } from '../provider-error.js';
import { hasHeader } from './responses-shared.js';
import { buildGeminiRequest, requestGemini, trimBase } from './google-shared.js';

export function generativeAiUrl(baseUrl: string, model: string): string {
  const cleanModel = encodeURIComponent(model.replace(/^models\//, ''));
  return `${trimBase(baseUrl)}/models/${cleanModel}:streamGenerateContent?alt=sse`;
}

export class GoogleGenerativeAIProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  async chat({ model, messages, tools, temperature, maxTokens, onToken, onThinking, signal }: ChatParams): Promise<ChatResult> {
    if (!this.credential && !hasHeader(this.info.headers, 'x-goog-api-key') && !hasHeader(this.info.headers, 'authorization')) {
      throw new ProviderError(`${this.name} is not connected. Run /login ${this.name} or set GEMINI_API_KEY.`, {
        provider: this.name,
        model,
        code: 'missing_credentials',
      });
    }
    return requestGemini({
      provider: this.name,
      info: this.info,
      model,
      url: generativeAiUrl(this.info.baseUrl, model),
      headers: {
        ...this.info.headers,
        ...(this.credential
          && !hasHeader(this.info.headers, 'x-goog-api-key')
          && !hasHeader(this.info.headers, 'authorization')
          && { 'x-goog-api-key': this.credential }),
      },
      body: buildGeminiRequest(this.info, { messages, tools, temperature, maxTokens }),
      params: { onToken, onThinking, signal },
    });
  }
}
