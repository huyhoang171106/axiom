// src/llm/model-resolver.ts - Selector or role to ModelInfo, ModelInfo to provider; stubs keep the pre-catalog behavior until B2

import type { AxiomConfig } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import type { BaseLLMProvider } from './base-provider.js';
import type { Catalog, ModelInfo } from './catalog/index.js';
import { createProvider } from './provider-factory.js';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// TODO(B2): resolve roles, aliases and selectors against the catalog (providers.md section 9).
export function resolveModel(selector: string, catalog: Catalog, config: AxiomConfig): ModelInfo & { thinking?: ThinkingLevel } {
  const provider = config.activeProvider;
  const id = config.defaultModel ?? '';
  return {
    provider,
    id,
    name: id,
    api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    baseUrl: config.providers[provider]?.baseUrl ?? '',
    contextWindow: 128000,
    reasoning: false,
    input: ['text'],
  };
}

// TODO(B2): resolve the credential (providers.md section 5) and build the wire from WIRES.
export async function createProviderFor(info: ModelInfo, opts?: { cliKey?: string }): Promise<BaseLLMProvider> {
  return createProvider(info.provider, loadConfig().providers[info.provider]);
}
