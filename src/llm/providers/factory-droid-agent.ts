// src/llm/providers/factory-droid-agent.ts - `factory-droid-agent` wire (Factory Droid proxy)
//
// The proxy multiplexes several upstream protocols; Axiom routes every model through the
// OpenAI-compatible Responses endpoint. Catalog base URLs are the bare host
// (`https://api.factory.ai`, providers.md section 6), so the wire appends the route itself.

import type { LLMProviderType } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { buildResponsesBody, requestResponses } from './responses-shared.js';

/** Client identity the Factory API expects on every wire (observed CLI headers). */
const CLIENT_VERSION = '0.237.0';

export class FactoryDroidAgentProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  async chat({ model, messages, tools, maxTokens, onToken, onThinking, signal }: ChatParams): Promise<ChatResult> {
    const base = this.info.baseUrl.replace(/\/+$/, '');
    return requestResponses({
      url: `${base}/api/llm/o/v1/responses`,
      headers: {
        ...this.info.headers,
        ...(this.credential && !this.info.headers?.authorization && { authorization: `Bearer ${this.credential}` }),
        'x-client-version': CLIENT_VERSION,
        'x-factory-client': 'cli',
        accept: 'application/json',
      },
      // The native Factory CLI sends no temperature on this route (reference parity), so a
      // caller-set temperature is dropped rather than forwarded.
      body: buildResponsesBody(model, messages, tools, { maxTokens, allowTemperature: false }),
      provider: this.name,
      model,
      info: this.info,
      onToken,
      onThinking,
      signal,
    });
  }
}
