// src/llm/auth/engines/api-key.ts - `api-key` login engine (paste an API key, check it on a protected endpoint); stub until B3

import type { LoginEngine } from './index.js';

// TODO(B3): implement.
export const apiKeyEngine: LoginEngine = async (provider) => {
  throw new Error(`${provider.id}: login type api-key is not supported yet (B3)`);
};
