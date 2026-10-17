// src/llm/auth/engines/device-code.ts - `device-code` login engine: RFC 8628 device authorization with polling (providers.md section 4.3)

import { z } from 'zod';
import { registerSecret } from '../../../core/secrets.js';
import type { ProviderEntry } from '../../catalog/index.js';
import { discoverTokenUrl, postForm, toOAuthCredential, withTimeout } from '../refresh.js';
import type { CommandUI } from '../../../commands/types.js';
import type { Credential, LoginEngine } from './index.js';

type OAuthCredential = Extract<Credential, { type: 'oauth' }>;

export const deviceLoginSchema = z.object({
  type: z.literal('device-code'),
  clientId: z.string().min(1),
  scopes: z.array(z.string().min(1)).optional(),
  deviceUrl: z.url(),
  /** Exactly one of tokenUrl and discoveryUrl (OIDC discovery of the token endpoint). */
  tokenUrl: z.url().optional(),
  discoveryUrl: z.url().optional(),
  /** Sent on the device and token requests. */
  headers: z.record(z.string(), z.string()).optional(),
  /** GET with the new token; its `email` is stored with the credential. */
  userinfoUrl: z.url().optional(),
  /** `src/llm/auth/hooks/<afterExchange>.ts`, for providers that need more than the token. */
  afterExchange: z.string().regex(/^[a-z0-9-]+$/).optional(),
  source: z.string().min(1),
}).strict().refine((l) => !!l.tokenUrl !== !!l.discoveryUrl, 'set exactly one of tokenUrl and discoveryUrl');

const deviceResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  verification_uri_complete: z.url().optional(),
  interval: z.coerce.number().optional(),
  expires_in: z.coerce.number().optional(),
});

/** What an `afterExchange` hook module exports. */
export interface AfterExchangeHook {
  afterExchange(credential: OAuthCredential, raw: unknown, provider: ProviderEntry): Promise<Credential>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_MS = 5000;
// RFC 8628 makes expires_in mandatory; if a provider omits it, polling still has to end.
const DEFAULT_EXPIRES_S = 900;

function flowChanged(provider: ProviderEntry, detail: string): Error {
  return new Error(`The login flow of ${provider.id} has changed (${detail}). Use an API key, or update src/llm/catalog/auth/${provider.id}.json.`);
}

function errorCode(body: unknown): string | undefined {
  return body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : undefined;
}

/** The device flow with an injectable clock, so tests can check intervals without waiting. */
export async function deviceCodeLogin(provider: ProviderEntry, ui: CommandUI, clock: Clock = realClock): Promise<Credential> {
  const login = deviceLoginSchema.parse(provider.login);
  const scope = login.scopes?.join(' ');
  const started = await postForm(login.deviceUrl, { client_id: login.clientId, scope }, { headers: login.headers });
  const device = deviceResponseSchema.safeParse(started.body);
  if (started.status < 200 || started.status >= 300 || !device.success) throw flowChanged(provider, `device request returned HTTP ${started.status}`);
  const { device_code, user_code, verification_uri, verification_uri_complete } = device.data;
  ui.print(`Open ${verification_uri_complete ?? verification_uri} and enter the code ${user_code}`);

  const tokenUrl = login.tokenUrl ?? (await discoverTokenUrl(login.discoveryUrl!));
  let intervalMs = Math.max(1000, (device.data.interval ?? DEFAULT_INTERVAL_S) * 1000);
  const deadline = clock.now() + (device.data.expires_in ?? DEFAULT_EXPIRES_S) * 1000;
  for (;;) {
    await clock.sleep(intervalMs);
    if (clock.now() >= deadline) throw new Error(`The code expired before sign-in finished. Run /login ${provider.id} again.`);
    const { status, body } = await postForm(tokenUrl, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code, client_id: login.clientId }, { headers: login.headers });
    const error = errorCode(body);
    if (status >= 200 && status < 300 && !error) return finish(provider, login, body);
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      intervalMs += SLOW_DOWN_MS;
      continue;
    }
    if (error === 'expired_token') throw new Error(`The code expired before sign-in finished. Run /login ${provider.id} again.`);
    if (error === 'access_denied') throw new Error(`Sign-in to ${provider.id} was denied.`);
    throw flowChanged(provider, `token request returned HTTP ${status}${error ? ` ${error}` : ''}`);
  }
}

async function finish(provider: ProviderEntry, login: z.infer<typeof deviceLoginSchema>, body: unknown): Promise<Credential> {
  let credential: OAuthCredential;
  try {
    credential = toOAuthCredential(body);
  } catch {
    throw flowChanged(provider, 'token response has no access_token');
  }
  [credential.access, credential.refresh].forEach((v) => v && registerSecret(v));
  const email = login.userinfoUrl && (await fetchEmail(login.userinfoUrl, credential.access));
  if (email) credential = { ...credential, email };
  if (!login.afterExchange) return credential;
  const hook = (await import(`../hooks/${login.afterExchange}.js`)) as AfterExchangeHook;
  return hook.afterExchange(credential, body, provider);
}

/** The email is only a label for /login; a failing userinfo call must not undo a successful sign-in. */
async function fetchEmail(url: string, access: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', authorization: `Bearer ${access}` }, signal: withTimeout(undefined) });
    const body: unknown = response.ok ? await response.json() : undefined;
    return z.object({ email: z.string() }).safeParse(body).data?.email;
  } catch {
    return undefined;
  }
}

export const deviceCodeEngine: LoginEngine = (provider, ui) => deviceCodeLogin(provider, ui);
