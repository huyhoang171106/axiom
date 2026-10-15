// src/llm/providers/google-vertex.ts - `google-vertex` wire (Vertex AI); stub until E6

import type { LLMProviderType } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';

export class GoogleVertexProvider extends BaseLLMProvider {
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
    throw new Error(`${this.name}: wire google-vertex is not implemented yet (E6)`);
  }
}
