// src/llm/auth/hooks/muse-code.ts - Muse Code: the Meta account token is exchanged once for the Model API key that calls the model

import { z } from 'zod';
import type { AfterExchangeHook } from '../engines/device-code.js';
import { withTimeout } from '../refresh.js';

const MUSE_KEY_URL = 'https://api.meta.ai/muse-code/key';

const keyResponseSchema = z.object({
  api_key: z.string().optional(),
  is_subs_active: z.boolean().optional(),
  require_payment: z.boolean().optional(),
  action_url: z.string().nullable().optional(),
  require_payment_action_url: z.string().optional(),
});

export const afterExchange: AfterExchangeHook['afterExchange'] = async (credential) => {
  const response = await fetch(MUSE_KEY_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${credential.access}`, 'x-api-version': '1.0.0' },
    // onboard: a first login sets the account up instead of failing.
    body: JSON.stringify({ onboard: true }),
    signal: withTimeout(undefined, 20_000),
  });
  if (!response.ok) throw new Error(`Muse Code key exchange failed with HTTP ${response.status}.`);
  const body = keyResponseSchema.parse(await response.json());
  if (body.is_subs_active === false) throw new Error('The Muse Code subscription of this account is not active.');
  const key = body.api_key?.trim();
  if (!key) {
    const action = body.action_url || body.require_payment_action_url;
    throw new Error(action ? `Muse Code needs a subscription: ${action}` : 'Muse Code returned no API key.');
  }
  // Model calls use this key, not the account token; Meta does not refresh it (providers.md section 4.4).
  return { type: 'api_key', key };
};
