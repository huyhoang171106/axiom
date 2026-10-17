// src/llm/auth/hooks/factory-droid.ts - Factory: find the organization (X-Factory-Org-Id) and the API host of the account's region

import { z } from 'zod';
import type { AfterExchangeHook } from '../engines/device-code.js';
import { withTimeout } from '../refresh.js';

/** Residency picks the API host; EU accounts are served from the EU host. */
const FACTORY_HOSTS = { global: 'https://api.factory.ai', eu: 'https://api.eu.factory.ai' };

const whoamiSchema = z.object({ orgId: z.string().optional(), region: z.string().optional() });

/** Factory's own org ID claim; WorkOS `organization_id` is internal and is not accepted as X-Factory-Org-Id. */
function orgClaim(access: string): string | undefined {
  try {
    const claims: unknown = JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return z.object({ external_org_id: z.string().min(1) }).safeParse(claims).data?.external_org_id;
  } catch {
    return undefined; // Opaque token: whoami decides.
  }
}

export const afterExchange: AfterExchangeHook['afterExchange'] = async (credential) => {
  const claimed = orgClaim(credential.access);
  const response = await fetch(`${FACTORY_HOSTS.global}/api/cli/whoami`, {
    headers: { accept: 'application/json', authorization: `Bearer ${credential.access}`, ...(claimed && { 'X-Factory-Org-Id': claimed }) },
    signal: withTimeout(undefined),
  });
  if (!response.ok) throw new Error(`Factory identity check failed with HTTP ${response.status}.`);
  const whoami = whoamiSchema.parse(await response.json());
  const orgId = whoami.orgId || claimed;
  if (!orgId) throw new Error('Factory login did not resolve an organization. Join or create one at factory.ai, then run /login factory-droid again.');
  return { ...credential, headers: { 'X-Factory-Org-Id': orgId }, ...(whoami.region === 'eu' && { baseUrl: FACTORY_HOSTS.eu }) };
};
