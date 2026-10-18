// src/llm/auth/refresh.ts - Shared OAuth refresh: a token close to expiry is renewed at the token endpoint from the auth JSON

import { z } from 'zod';
import { axiomHome } from '../../core/paths.js';
import type { ProviderEntry } from '../catalog/index.js';
import type { Credential } from './engines/index.js';
import { loadHook } from './engines/hook.js';
import { loadCatalog } from '../catalog/index.js';
import { removeCredential, saveCredential } from './store.js';

type OAuthCredential = Extract<Credential, { type: 'oauth' }>;

/** Refresh when less than this is left (providers.md section 4.3). */
export const REFRESH_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const refreshConfigSchema = z.union([
  z.object({ tokenUrl: z.url(), headers: z.record(z.string(), z.string()).optional() }),
  z.object({ discoveryUrl: z.url(), headers: z.record(z.string(), z.string()).optional() }),
]);

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.coerce.number().optional(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/** `exp` of a JWT in ms; undefined for opaque tokens. The signature is not checked: this only schedules a refresh. */
export function jwtExpiry(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const exp: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined; // Not a JWT.
  }
}

/** Token response to the stored shape; `previous` keeps fields the response omits (refresh token, email). */
export function toOAuthCredential(body: unknown, previous?: OAuthCredential): OAuthCredential {
  const token = tokenResponseSchema.parse(body);
  const expires = token.expires_in ? Date.now() + token.expires_in * 1000 : jwtExpiry(token.access_token);
  return { ...previous, type: 'oauth', access: token.access_token, refresh: token.refresh_token ?? previous?.refresh, expires };
}

/**
 * OIDC discovery for the token endpoint. The endpoint later receives every refresh token, so it must be
 * HTTPS on the issuer's domain.
 */
export async function discoverTokenUrl(discoveryUrl: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(discoveryUrl, { headers: { accept: 'application/json' }, signal: withTimeout(signal) });
  if (!response.ok) throw new Error(`OIDC discovery ${discoveryUrl} returned HTTP ${response.status}`);
  const tokenUrl = z.object({ token_endpoint: z.url() }).parse(await response.json()).token_endpoint;
  const domain = new URL(discoveryUrl).hostname.split('.').slice(-2).join('.');
  const host = new URL(tokenUrl).hostname;
  if (!tokenUrl.startsWith('https://') || (host !== domain && !host.endsWith(`.${domain}`))) throw new Error(`OIDC discovery returned an untrusted token endpoint: ${tokenUrl}`);
  return tokenUrl;
}

export function withTimeout(signal: AbortSignal | undefined, ms = REQUEST_TIMEOUT_MS): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/** POST a form to an OAuth endpoint; the body is parsed JSON, or undefined when it is not JSON. */
export async function postForm(url: string, form: Record<string, string | undefined>, opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<{ status: number; body: unknown }> {
  const params = new URLSearchParams(Object.entries(form).filter((e): e is [string, string] => e[1] !== undefined));
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', ...opts.headers },
    body: params,
    signal: withTimeout(opts.signal),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined; // Error pages are often HTML; callers only report the status.
  }
  return { status: response.status, body };
}

function relogin(provider: ProviderEntry): Error {
  return new Error(`${provider.id}: the login has expired. Run /login ${provider.id} again.`);
}

/** The credential itself when it is not close to expiry; otherwise a refreshed, saved one. */
export async function refreshIfNeeded(provider: ProviderEntry, credential: OAuthCredential, home = axiomHome()): Promise<OAuthCredential> {
  if (credential.expires === undefined || credential.expires - Date.now() > REFRESH_MARGIN_MS) return credential;
  const hookProvider = provider.login?.type === 'hook' ? provider : loadCatalog(home).providers().find(
    (entry) => entry.login?.type === 'hook' && entry.login.storeAs === provider.id,
  );
  const hookConfig = z.object({ hook: z.string().min(1) }).safeParse(hookProvider?.refresh);
  if (hookProvider && hookConfig.success && credential.refresh) {
    const hook = await loadHook(hookConfig.data.hook);
    if (!hook.refresh) throw new Error(`${hookProvider.id}: refresh hook is missing; run /login ${hookProvider.id} again.`);
    const refreshed = await hook.refresh(credential, hookProvider);
    if (refreshed.type !== 'oauth') throw new Error(`${hookProvider.id}: refresh hook returned a non-oauth credential.`);
    saveCredential(provider.id, refreshed, home);
    return refreshed;
  }
  const config = refreshConfigSchema.safeParse(provider.refresh);
  if (!config.success || !credential.refresh) {
    if (credential.expires > Date.now()) return credential; // Still valid for a few minutes and nothing to refresh with.
    removeCredential(provider.id, home);
    throw relogin(provider);
  }
  const tokenUrl = 'tokenUrl' in config.data ? config.data.tokenUrl : await discoverTokenUrl(config.data.discoveryUrl);
  const clientId = typeof provider.login?.clientId === 'string' ? provider.login.clientId : undefined;
  const { status, body } = await postForm(tokenUrl, { grant_type: 'refresh_token', refresh_token: credential.refresh, client_id: clientId }, { headers: config.data.headers });
  // 400/401 mean the refresh token itself is dead (revoked, rotated, expired): keeping it only fails again.
  if (status === 400 || status === 401) {
    removeCredential(provider.id, home);
    throw relogin(provider);
  }
  if (status < 200 || status >= 300) throw new Error(`${provider.id}: token refresh failed with HTTP ${status}; try again later.`);
  const refreshed = toOAuthCredential(body, credential);
  saveCredential(provider.id, refreshed, home);
  return refreshed;
}
