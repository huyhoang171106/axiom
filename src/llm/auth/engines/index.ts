// src/llm/auth/engines/index.ts - Login engine per `login.type` in the auth catalog; one file per engine

import type { CommandUI } from '../../../commands/types.js';
import type { LoginType, ProviderEntry } from '../../catalog/index.js';
import { apiKeyEngine } from './api-key.js';
import { oauthCodeEngine } from './oauth-code.js';
import { deviceCodeEngine } from './device-code.js';
import { cloudFieldsEngine } from './cloud-fields.js';
import { hookEngine } from './hook.js';

/** What a login stores in auth.json (providers.md step 3, `StoredCredential`). */
export type Credential =
  | { type: 'api_key'; key: string }
  /** `headers` and `baseUrl` are per-account request details a login found out (e.g. Factory org ID, EU host). */
  | { type: 'oauth'; access: string; refresh?: string; expires?: number; email?: string; projectId?: string; headers?: Record<string, string>; baseUrl?: string }
  | { type: 'fields'; values: Record<string, string> };

export type LoginEngine = (provider: ProviderEntry, ui: CommandUI) => Promise<Credential>;

export const LOGIN_ENGINES: Record<LoginType, LoginEngine> = {
  'api-key': apiKeyEngine,
  'oauth-code': oauthCodeEngine,
  'device-code': deviceCodeEngine,
  'cloud-fields': cloudFieldsEngine,
  hook: hookEngine,
};
