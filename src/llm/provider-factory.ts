// src/llm/provider-factory.ts - Core providers: Anthropic, OpenAI (+ OpenAI-compatible endpoints), Mock

import type { LLMProviderType, ProviderCredentials } from '../core/types.js';
import { BaseLLMProvider } from './base-provider.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { MockProvider } from './providers/mock.js';

const OPENAI_COMPATIBLE: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
  deepseek: 'https://api.deepseek.com/v1',
  groq: 'https://api.groq.com/openai/v1',
};

export function createProvider(type: LLMProviderType, credentials?: ProviderCredentials): BaseLLMProvider {
  if (type === 'anthropic') return new AnthropicProvider(credentials);
  if (type === 'mock') return new MockProvider('mock');
  const baseUrl = credentials?.baseUrl || OPENAI_COMPATIBLE[type];
  return new OpenAIProvider(baseUrl ? { ...credentials, baseUrl } : credentials, type);
}

export class ProviderRegistry {
  private instances: Partial<Record<LLMProviderType, BaseLLMProvider>> = {};

  getOrCreate(type: LLMProviderType, credentials?: ProviderCredentials): BaseLLMProvider {
    return (this.instances[type] ??= createProvider(type, credentials));
  }

  register(type: LLMProviderType, instance: BaseLLMProvider): void {
    this.instances[type] = instance;
  }
}

export const defaultProviderRegistry = new ProviderRegistry();
