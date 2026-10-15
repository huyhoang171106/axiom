// src/llm/providers/cursor-agent.ts - `cursor-agent` wire (Cursor); stub until D4

import type { LLMProviderType } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';

export class CursorAgentProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  // TODO(D4): implement the wire.
  async chat(params: ChatParams): Promise<ChatResult> {
    throw new Error(`${this.name}: wire cursor-agent is not implemented yet (D4)`);
  }
}
