// src/llm/providers/openai-responses.ts - `openai-responses` wire (OpenAI Responses API)

import type { LLMProviderType } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { buildResponsesBody, hasHeader, requestResponses } from './responses-shared.js';

export class OpenAIResponsesProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  async chat({ model, messages, tools, temperature, maxTokens, onToken, onThinking, signal }: ChatParams): Promise<ChatResult> {
    return requestResponses({
      url: `${this.info.baseUrl.replace(/\/+$/, '')}/responses`,
      headers: {
        ...this.info.headers,
        // A catalog header wins over the stored credential, so gateways can pin their own auth.
        ...(this.credential && !hasHeader(this.info.headers, 'authorization') && { authorization: `Bearer ${this.credential}` }),
      },
      body: buildResponsesBody(model, messages, tools, { temperature, maxTokens }),
      provider: this.name,
      model,
      info: this.info,
      onToken,
      onThinking,
      signal,
    });
  }
}
