// src/llm/auth/engines/oauth-code.ts - `oauth-code` login engine (authorization code + PKCE with a 127.0.0.1 callback); stub until C5

import type { LoginEngine } from './index.js';

// TODO(C5): implement.
export const oauthCodeEngine: LoginEngine = async (provider) => {
  throw new Error(`${provider.id}: login type oauth-code is not supported yet (C5)`);
};
