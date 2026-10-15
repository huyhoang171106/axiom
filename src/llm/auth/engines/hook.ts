// src/llm/auth/engines/hook.ts - `hook` login engine (provider-specific flows in src/llm/auth/hooks/); stub until A7

import type { LoginEngine } from './index.js';

// TODO(A7): implement.
export const hookEngine: LoginEngine = async (provider) => {
  throw new Error(`${provider.id}: login type hook is not supported yet (A7)`);
};
