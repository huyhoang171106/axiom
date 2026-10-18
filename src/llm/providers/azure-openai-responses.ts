// src/llm/providers/azure-openai-responses.ts - `azure-openai-responses` wire (Azure OpenAI, v1 API)

import type { LLMProviderType } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { buildResponsesBody, hasHeader, requestResponses } from './responses-shared.js';

/**
 * The catalog base URL is the v1 surface (`https://<resource>.openai.azure.com/openai/v1`), which routes
 * by the `model` field like OpenAI's own API — no deployment segment in the path. Any query string the
 * catalog carries (`?api-version=...`) is preserved after the appended route.
 */
export function azureResponsesUrl(baseUrl: string): string {
  const [path, query] = baseUrl.split('?');
  const trimmed = path!.replace(/\/+$/, '');
  return query ? `${trimmed}/responses?${query}` : `${trimmed}/responses`;
}

export class AzureOpenAIResponsesProvider extends BaseLLMProvider {
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
      url: azureResponsesUrl(this.info.baseUrl),
      headers: {
        ...this.info.headers,
        // Azure's key auth is the `api-key` header; a catalog header may still pin its own.
        ...(this.credential && !hasHeader(this.info.headers, 'api-key') && !hasHeader(this.info.headers, 'authorization') && { 'api-key': this.credential }),
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
