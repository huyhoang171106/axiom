// src/llm/auth/hooks/zai-coding-plan.ts - Z.AI Coding Plan: the short-lived sign-in token mints a durable API key, as the ZCode app does

import { z } from 'zod';
import { registerSecret } from '../../../core/secrets.js';
import type { AfterExchangeHook } from '../engines/device-code.js';
import { withTimeout } from '../refresh.js';

const BIZ_URL = 'https://api.z.ai';
/** Axiom's own key, so signing in never touches the key of the ZCode app. */
const KEY_NAME = 'axiom';

/** Every Z.AI reply is `{ code, msg, success, data }`; the token endpoint says 0, the business API 200. */
const envelopeSchema = z.looseObject({
  code: z.union([z.number(), z.string()]).optional(),
  msg: z.string().optional(),
  success: z.boolean().optional(),
  data: z.unknown().optional(), // error replies have none, and their `msg` is what the user must see
});
const bizLoginSchema = z.looseObject({ access_token: z.string().min(1) });
const customerSchema = z.looseObject({
  organizations: z.array(
    z.looseObject({
      organizationId: z.coerce.string(),
      isDefault: z.boolean().optional(),
      projects: z.array(z.looseObject({ projectId: z.coerce.string(), isDefault: z.boolean().optional() })).default([]),
    }),
  ),
});
const keySchema = z.looseObject({ name: z.string().optional(), apiKey: z.string().optional() });
const secretSchema = z.looseObject({ secretKey: z.string().min(1) });

async function call<T>(step: string, schema: z.ZodType<T>, url: string, opts: { token?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, {
    method: opts.body === undefined ? 'GET' : 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(opts.token && { authorization: `Bearer ${opts.token}` }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: withTimeout(undefined, 30_000),
  });
  if (!response.ok) throw new Error(`Z.AI ${step} failed with HTTP ${response.status}. Run /login zai-coding-plan again, or use /login zai with an API key.`);
  const reply = envelopeSchema.safeParse(await response.json().catch(() => undefined));
  if (!reply.success) throw new Error(`Z.AI ${step} returned an unexpected reply; the login flow may have changed.`);
  const { code, msg, success, data } = reply.data;
  if (success === false || (code !== undefined && !['0', '200'].includes(String(code)))) throw new Error(`Z.AI ${step} failed: ${msg ?? `code ${code}`}.`);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`Z.AI ${step} returned an unexpected reply; the login flow may have changed.`);
  return parsed.data;
}

/** business login -> default organization and project -> find or create the `axiom` key -> its secret. */
export const afterExchange: AfterExchangeHook['afterExchange'] = async (credential) => {
  const { access_token: biz } = await call('business login', bizLoginSchema, `${BIZ_URL}/api/auth/z/login`, { body: { token: credential.access } });
  registerSecret(biz);
  const { organizations } = await call('account lookup', customerSchema, `${BIZ_URL}/api/biz/customer/getCustomerInfo`, { token: biz });
  const org = organizations.find((o) => o.isDefault) ?? organizations[0];
  const project = org?.projects.find((p) => p.isDefault) ?? org?.projects[0];
  if (!org || !project) throw new Error('Z.AI: this account has no organization or project to create an API key in.');

  const keysUrl = `${BIZ_URL}/api/biz/v1/organization/${encodeURIComponent(org.organizationId)}/projects/${encodeURIComponent(project.projectId)}/api_keys`;
  // The list is a bare array or wrapped in one field (`list`, `keys`, …).
  const listed = await call('key list', z.unknown(), keysUrl, { token: biz });
  const items = Array.isArray(listed) ? listed : Object.values(listed ?? {}).find(Array.isArray) ?? [];
  const existing = items.map((item) => keySchema.safeParse(item).data).find((key) => key?.name === KEY_NAME);
  const apiKey = existing?.apiKey ?? (await call('key create', keySchema, keysUrl, { token: biz, body: { name: KEY_NAME } })).apiKey;
  if (!apiKey) throw new Error('Z.AI returned no API key; the login flow may have changed.');
  // The list masks the secret, so it is always read from the copy endpoint.
  const { secretKey } = await call('key secret', secretSchema, `${keysUrl}/copy/${encodeURIComponent(apiKey)}`, { token: biz });
  const key = `${apiKey}.${secretKey}`;
  registerSecret(key);
  return { type: 'api_key', key };
};
