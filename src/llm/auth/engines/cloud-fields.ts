// src/llm/auth/engines/cloud-fields.ts - `cloud-fields` login engine: several cloud credential fields in one record (providers.md sections 4.5, 7.4)

import { z } from 'zod';
import { registerSecret } from '../../../core/secrets.js';
import type { ModelInfo, ProviderEntry } from '../../catalog/index.js';
import { loginFieldSchema } from '../resolve.js';
import type { LoginEngine } from './index.js';

export const cloudLoginSchema = z.object({
  type: z.literal('cloud-fields'),
  /** `src/llm/auth/hooks/<hook>.ts`: turns the fields into what the wire needs. Without one the wire gets the JSON. */
  hook: z.string().regex(/^[a-z0-9-]+$/).optional(),
  fields: z.array(loginFieldSchema).min(1),
}).strict();

/** What a cloud hook module exports: base URL, headers and credential for the wire, from the field values. */
export interface CloudHook {
  prepare(values: Record<string, string>, info: ModelInfo): { info: ModelInfo; credential?: string };
}

// Lazy, so hooks are never loaded at startup (providers.md section 7.4).
async function loadHook(name: string): Promise<CloudHook> {
  return (await import(`../hooks/${name}.js`)) as CloudHook;
}

/** Field values from a credential string: the JSON a login or env produces, or a bare key from --api-key. */
function parseValues(provider: ProviderEntry, credential: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(credential);
    if (value && typeof value === 'object' && !Array.isArray(value)) return z.record(z.string(), z.string()).parse(value);
  } catch {
    // Not JSON: a bare key for the provider's first env name.
  }
  return { [provider.env[0]]: credential };
}

/** ModelInfo and credential for the wire; providers without a hook pass the JSON through (the Bedrock wire parses it). */
export async function prepareCloud(provider: ProviderEntry, info: ModelInfo, credential: string | undefined): Promise<{ info: ModelInfo; credential?: string }> {
  const login = cloudLoginSchema.parse(provider.login);
  if (!login.hook || !credential) return { info, credential };
  return (await loadHook(login.hook)).prepare(parseValues(provider, credential), info);
}

export const cloudFieldsEngine: LoginEngine = async (provider, ui) => {
  const login = cloudLoginSchema.parse(provider.login);
  const values: Record<string, string> = {};
  for (const field of login.fields) {
    const value = (await ui.ask(`${field.prompt}${field.optional ? ' (Enter to skip)' : ''}:`, { secret: field.secret })).trim();
    if (!value) {
      if (!field.optional) throw new Error(`${field.name} is required; nothing was saved.`);
      continue;
    }
    if (field.secret) registerSecret(value);
    values[field.name] = value;
  }
  if (Object.keys(values).length === 0) throw new Error('No field entered; nothing was saved.');
  // A hook rejects incomplete or unsafe values now rather than on the first chat.
  if (login.hook) (await loadHook(login.hook)).prepare(values, { provider: provider.id, id: provider.defaultModel, name: provider.defaultModel, api: provider.api as ModelInfo['api'], baseUrl: provider.baseUrl, contextWindow: 0, reasoning: false, input: ['text'] });
  return { type: 'fields', values };
};
