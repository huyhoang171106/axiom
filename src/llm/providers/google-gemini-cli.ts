// src/llm/providers/google-gemini-cli.ts - `google-gemini-cli` wire (Cloud Code Assist); stub until E6

import type { LLMProviderType } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';

export class GoogleGeminiCliProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  // TODO(E6): implement the wire.
  async chat(params: ChatParams): Promise<ChatResult> {
    throw new Error(`${this.name}: wire google-gemini-cli is not implemented yet (E6)`);
  }
}
