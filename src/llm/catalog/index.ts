// src/llm/catalog/index.ts - Provider and model catalog (providers.md section 7); loadCatalog is a stub until B1

export type WireApi =
  | 'openai-completions'
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-codex-responses'
  | 'azure-openai-responses'
  | 'google-generative-ai'
  | 'google-gemini-cli'
  | 'google-vertex'
  | 'ollama-chat'
  | 'bedrock-converse-stream'
  | 'cursor-agent'
  | 'devin-agent'
  | 'factory-droid-agent'
  | 'gitlab-duo-agent';

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  api: WireApi;
  baseUrl: string;
  contextWindow: number;
  maxTokens?: number;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  headers?: Record<string, string>;
}

export type LoginType = 'api-key' | 'oauth-code' | 'device-code' | 'cloud-fields' | 'hook';

/** Both halves of a provider: `providers/<id>.json` and `auth/<id>.json`. */
export interface ProviderEntry {
  id: string;
  name: string;
  defaultModel: string;
  env: string[];
  /** A `WireApi`, or a wire Axiom does not implement when `available` is false. */
  api: string;
  baseUrl: string;
  headers?: Record<string, string>;
  /** false = not supported (providers.md section 4.7); `reason` says why. */
  available?: boolean;
  reason?: string;
  /** Engine-specific fields stay `unknown`: each login engine validates its own. */
  login?: { type: LoginType } & Record<string, unknown>;
  refresh?: unknown;
}

export interface Catalog {
  providers(): ProviderEntry[];
  models(provider?: string): ModelInfo[];
  isAvailable(id: string, env?: NodeJS.ProcessEnv): boolean;
}

// TODO(B1): read the JSON catalog, models-cache.json and models.json under `home`.
export function loadCatalog(home?: string): Catalog {
  return { providers: () => [], models: () => [], isAvailable: () => false };
}
