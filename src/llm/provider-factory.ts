// src/llm/provider-factory.ts - Wire table (WIRES) plus the legacy provider-by-name factory

import type { LLMProviderType, ProviderCredentials } from '../core/types.js';
import { BaseLLMProvider } from './base-provider.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { MockProvider } from './providers/mock.js';
import { OpenAIResponsesProvider } from './providers/openai-responses.js';
import { OpenAICodexResponsesProvider } from './providers/openai-codex-responses.js';
import { AzureOpenAIResponsesProvider } from './providers/azure-openai-responses.js';
import { FactoryDroidAgentProvider } from './providers/factory-droid-agent.js';
import { GitlabDuoAgentProvider } from './providers/gitlab-duo-agent.js';
import { GoogleGenerativeAIProvider } from './providers/google-generative-ai.js';
import { GoogleGeminiCliProvider } from './providers/google-gemini-cli.js';
import { GoogleVertexProvider } from './providers/google-vertex.js';
import { OllamaChatProvider } from './providers/ollama-chat.js';
import { BedrockConverseStreamProvider } from './providers/bedrock-converse-stream.js';
import { CursorAgentProvider } from './providers/cursor-agent.js';
import { DevinAgentProvider } from './providers/devin-agent.js';
import type { ModelInfo, WireApi } from './catalog/index.js';

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

/** `credential` is the resolved value for the model's provider (providers.md section 5), undefined when it needs none. */
export type WireFactory = (info: ModelInfo, credential: string | undefined) => BaseLLMProvider;

/** One entry per wire; code picks the wire by `ModelInfo.api`, never by provider name. */
export const WIRES: Record<WireApi, WireFactory> = {
  'openai-completions': (info, credential) =>
    new OpenAIProvider({ apiKey: credential, baseUrl: info.baseUrl, headers: info.headers }, info.provider),
  // Catalog base URLs stop before the version segment (`https://api.anthropic.com`); the class appends `/messages`.
  'anthropic-messages': (info, credential) =>
    new AnthropicProvider({ apiKey: credential, baseUrl: `${info.baseUrl.replace(/\/+$/, '')}/v1`, headers: info.headers }),
  'openai-responses': (info, credential) => new OpenAIResponsesProvider(info, credential),
  'openai-codex-responses': (info, credential) => new OpenAICodexResponsesProvider(info, credential),
  'azure-openai-responses': (info, credential) => new AzureOpenAIResponsesProvider(info, credential),
  'factory-droid-agent': (info, credential) => new FactoryDroidAgentProvider(info, credential),
  'gitlab-duo-agent': (info, credential) => new GitlabDuoAgentProvider(info, credential),
  'google-generative-ai': (info, credential) => new GoogleGenerativeAIProvider(info, credential),
  'google-gemini-cli': (info, credential) => new GoogleGeminiCliProvider(info, credential),
  'google-vertex': (info, credential) => new GoogleVertexProvider(info, credential),
  'ollama-chat': (info, credential) => new OllamaChatProvider(info, credential),
  'bedrock-converse-stream': (info, credential) => new BedrockConverseStreamProvider(info, credential),
  'cursor-agent': (info, credential) => new CursorAgentProvider(info, credential),
  'devin-agent': (info, credential) => new DevinAgentProvider(info, credential),
};

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
