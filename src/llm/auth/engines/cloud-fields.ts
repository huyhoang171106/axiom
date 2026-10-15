// src/llm/auth/engines/cloud-fields.ts - `cloud-fields` login engine (several cloud credential fields in one record); stub until B4

import type { LoginEngine } from './index.js';

// TODO(B4): implement.
export const cloudFieldsEngine: LoginEngine = async (provider) => {
  throw new Error(`${provider.id}: login type cloud-fields is not supported yet (B4)`);
};
