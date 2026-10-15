// src/llm/providers/gitlab-duo-agent.ts - `gitlab-duo-agent` wire (GitLab Duo Agent); stub until A6

import type { LLMProviderType } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';

export class GitlabDuoAgentProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  // TODO(A6): implement the wire.
  async chat(params: ChatParams): Promise<ChatResult> {
    throw new Error(`${this.name}: wire gitlab-duo-agent is not implemented yet (A6)`);
  }
}
