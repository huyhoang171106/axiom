// src/llm/auth/engines/device-code.ts - `device-code` login engine (device code polling); stub until B5

import type { LoginEngine } from './index.js';

// TODO(B5): implement.
export const deviceCodeEngine: LoginEngine = async (provider) => {
  throw new Error(`${provider.id}: login type device-code is not supported yet (B5)`);
};
