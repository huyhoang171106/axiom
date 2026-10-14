// src/llm/base-provider.ts - Abstract BaseLLMProvider definition

import type {
  LLMProviderType,
  Message,
  ToolDefinition,
  ToolCall,
  TokenUsage,
} from '../core/types.js';

export interface ChatParams {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  onToken?: (token: string) => void;
  onThinking?: (thought: string) => void;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  /**
   * Set when the provider never reported usage (no usage chunk before the stream ended), so the zeros in
   * `usage` are a missing measurement rather than a free call.
   */
  usageMissing?: boolean;
  /**
   * Provider stop reason when it is not a normal completion (Gemini's `SAFETY`/`MAX_TOKENS`), so a
   * truncated or blocked answer is not mistaken for a finished one.
   */
  finishReason?: string;
}

export abstract class BaseLLMProvider {
  abstract readonly name: LLMProviderType;

  abstract chat(params: {
    model: string;
    messages: Message[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    onToken?: (token: string) => void;
    onThinking?: (thought: string) => void;
    signal?: AbortSignal;
  }): Promise<ChatResult>;
}
