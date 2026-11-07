// src/llm/providers/openai-codex-responses.ts - `openai-codex-responses` wire (ChatGPT Codex backend)

import type { LLMProviderType } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { buildResponsesBody, hasHeader, requestResponses } from './responses-shared.js';

/**
 * `chatgpt-account-id` is the `chatgpt_account_id` of the JWT's `https://api.openai.com/auth` claim. The backend
 * answers 401 without it, and a non-JWT credential (gateway token) simply omits the header.
 */
function accountIdFromCredential(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const claim = payload['https://api.openai.com/auth'] as { chatgpt_account_id?: unknown } | undefined;
    return typeof claim?.chatgpt_account_id === 'string' ? claim.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

export class OpenAICodexResponsesProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  async chat({ model, messages, tools, maxTokens, onToken, onThinking, signal }: ChatParams): Promise<ChatResult> {
    const accountId = this.credential ? accountIdFromCredential(this.credential) : undefined;
    // Backend Codex không nhận message role system trong input; giữ nguyên chỉ dẫn ở trường instructions.
    const instructions = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const inputMessages = messages.filter((message) => message.role !== 'system');
    return requestResponses({
      url: `${this.info.baseUrl.replace(/\/+$/, '')}/responses`,
      headers: {
        ...this.info.headers,
        ...(this.credential && !hasHeader(this.info.headers, 'authorization') && { authorization: `Bearer ${this.credential}` }),
        ...(accountId && !hasHeader(this.info.headers, 'chatgpt-account-id') && { 'chatgpt-account-id': accountId }),
      },
      // The Codex backend rejects sampling params, so temperature is dropped here, not forwarded.
      body: { ...buildResponsesBody(model, inputMessages, tools, { maxTokens, allowTemperature: false }),
        ...(instructions && { instructions }) },
      provider: this.name,
      model,
      info: this.info,
      onToken,
      onThinking,
      signal,
    });
  }
}
