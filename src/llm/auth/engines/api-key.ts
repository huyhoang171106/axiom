// src/llm/auth/engines/api-key.ts - `api-key` login engine: paste a key, check it on a protected endpoint (providers.md section 4.1)

import { z } from 'zod';
import { registerSecret } from '../../../core/secrets.js';
import type { ProviderEntry } from '../../catalog/index.js';
import type { LoginEngine } from './index.js';

/** Long enough for a slow gateway, short enough that a dead host does not hang /login (providers.md step 5). */
export const VALIDATE_TIMEOUT_MS = 10_000;

const validateSchema = z.discriminatedUnion('kind', [
  // `header` names the header that carries the key when it is not `Authorization: Bearer`.
  z.object({ kind: z.literal('url'), url: z.url(), header: z.string().optional() }).strict(),
  z.object({ kind: z.literal('chat-completions'), model: z.string().min(1), baseUrl: z.url().optional() }).strict(),
  z.object({ kind: z.literal('anthropic-messages'), model: z.string().min(1), baseUrl: z.url().optional() }).strict(),
]);
type Validate = z.infer<typeof validateSchema>;

export const apiKeyLoginSchema = z.object({
  type: z.literal('api-key'),
  authUrl: z.url().optional(),
  prompt: z.string().min(1),
  placeholder: z.string().optional(),
  validate: validateSchema.optional(),
}).strict();

const PING = [{ role: 'user', content: 'hi' }];

/** One cheap authenticated request; the key travels only to this provider's own host. */
function checkRequest(validate: Validate, key: string, provider: ProviderEntry): { url: string; init: RequestInit } {
  const base = ('baseUrl' in validate && validate.baseUrl ? validate.baseUrl : provider.baseUrl).replace(/\/+$/, '');
  const headers: Record<string, string> = { accept: 'application/json', ...provider.headers };
  if (validate.kind === 'url') {
    headers[validate.header ?? 'authorization'] = validate.header ? key : `Bearer ${key}`;
    return { url: validate.url, init: { headers } };
  }
  headers['content-type'] = 'application/json';
  if (validate.kind === 'chat-completions') {
    headers.authorization = `Bearer ${key}`;
    return { url: `${base}/chat/completions`, init: { method: 'POST', headers, body: JSON.stringify({ model: validate.model, messages: PING, max_tokens: 1 }) } };
  }
  Object.assign(headers, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
  return { url: `${base}/v1/messages`, init: { method: 'POST', headers, body: JSON.stringify({ model: validate.model, messages: PING, max_tokens: 1 }) } };
}

/** 'ok', 'rejected' (401/403), or why the key could not be checked. */
async function checkKey(validate: Validate, key: string, provider: ProviderEntry): Promise<{ result: 'ok' | 'rejected' | 'unknown'; detail: string }> {
  const { url, init } = checkRequest(validate, key, provider);
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) });
    await response.body?.cancel();
    if (response.ok) return { result: 'ok', detail: `HTTP ${response.status}` };
    return { result: response.status === 401 || response.status === 403 ? 'rejected' : 'unknown', detail: `HTTP ${response.status}` };
  } catch (error) {
    const timedOut = (error as Error).name === 'TimeoutError';
    return { result: 'unknown', detail: timedOut ? `no answer from ${new URL(url).host} within ${VALIDATE_TIMEOUT_MS / 1000} s` : `cannot reach ${new URL(url).host}` };
  }
}

export const apiKeyEngine: LoginEngine = async (provider, ui) => {
  const login = apiKeyLoginSchema.parse(provider.login);
  if (login.authUrl) ui.print(`Create or copy a key at ${login.authUrl}`);
  const typed = await ui.ask(`${login.prompt}${login.placeholder ? ` (${login.placeholder})` : ''}:`, { secret: true });
  const key = typed.trim().replace(/^Bearer\s+/i, '');
  if (!key) throw new Error('No key entered; nothing was saved.');
  registerSecret(key);
  if (!login.validate) {
    ui.print(`${provider.name} has no endpoint to check a key; it is saved unchecked.`);
    return { type: 'api_key', key };
  }
  const { result, detail } = await checkKey(login.validate, key, provider);
  if (result === 'ok') return { type: 'api_key', key };
  if (result === 'rejected') throw new Error(`${provider.name} rejected the key (${detail}); nothing was saved.`);
  if (await ui.confirm(`Could not confirm the key (${detail}). Save it anyway?`)) return { type: 'api_key', key };
  throw new Error(`Key not saved (${detail}).`);
};
