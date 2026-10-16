// src/llm/auth/hooks/cursor.ts - luồng poll đăng nhập của Cursor

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ProviderEntry } from '../../catalog/index.js';
import { hookSleep, type LoginContext, type StoredCredential } from '../engines/hook.js';

const REQUEST_TIMEOUT_MS = 15_000;
const POLL_BASE_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;
const POLL_MAX_ATTEMPTS = 150;
const MAX_CONSECUTIVE_ERRORS = 3;
const TOKEN_TTL_MS = 3_600_000;
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface CursorLogin {
  clientId: string;
  loginUrl: string;
  pollUrl: string;
  refreshUrl: string;
}

function readString(provider: ProviderEntry, field: string): string {
  const value = provider.login?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${provider.id}: auth file is missing login.${field}`);
  }
  return value;
}

function config(provider: ProviderEntry): CursorLogin {
  return {
    clientId: readString(provider, 'clientId'),
    loginUrl: readString(provider, 'loginUrl'),
    pollUrl: readString(provider, 'pollUrl'),
    refreshUrl: readString(provider, 'refreshUrl'),
  };
}

function tokenExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 - EXPIRY_SKEW_MS : undefined;
  } catch {
    return undefined;
  }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function login(ctx: LoginContext): Promise<StoredCredential> {
  const cfg = config(ctx.provider);
  const { verifier, challenge } = pkce();
  const uuid = randomUUID();
  const authUrl = new URL(cfg.loginUrl);
  authUrl.searchParams.set('challenge', challenge);
  authUrl.searchParams.set('uuid', uuid);
  authUrl.searchParams.set('mode', 'login');
  authUrl.searchParams.set('redirectTarget', 'cli');
  ctx.ui.print(`Open ${authUrl.toString()} to sign in to Cursor`);

  const pollUrl = new URL(cfg.pollUrl);
  pollUrl.searchParams.set('uuid', uuid);
  pollUrl.searchParams.set('verifier', verifier);
  const sleep = ctx.sleep ?? hookSleep;
  let delay = POLL_BASE_DELAY_MS;
  let consecutiveErrors = 0;
  let lastError = 'unknown error';

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(delay);
    try {
      const response = await fetch(pollUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(Math.ceil(delay * POLL_BACKOFF_MULTIPLIER), POLL_MAX_DELAY_MS);
        continue;
      }
      if (!response.ok) throw new Error(`poll failed (${response.status})`);

      const body = (await response.json()) as { accessToken?: unknown; refreshToken?: unknown };
      if (typeof body.accessToken !== 'string' || typeof body.refreshToken !== 'string') {
        throw new Error('poll response is missing accessToken or refreshToken');
      }
      return {
        type: 'oauth',
        access: body.accessToken,
        refresh: body.refreshToken,
        expires: tokenExpiry(body.accessToken) ?? Date.now() + TOKEN_TTL_MS,
      };
    } catch (error) {
      consecutiveErrors++;
      lastError = error instanceof Error ? error.message : String(error);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        throw new Error(`Cursor authentication polling failed: ${lastError}; run /login cursor again`);
      }
    }
  }

  throw new Error('Cursor authentication polling timed out; run /login cursor again');
}

export async function refresh(cred: StoredCredential, provider: ProviderEntry): Promise<StoredCredential> {
  if (cred.type !== 'oauth') throw new Error(`${provider.id}: stored credential is not oauth`);
  if (!cred.refresh) throw new Error(`${provider.id}: stored credential has no refresh token; run /login ${provider.id} again`);

  const cfg = config(provider);
  const response = await fetch(cfg.refreshUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      refresh_token: cred.refresh,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${provider.id}: token refresh failed (${response.status}); run /login ${provider.id} again`);
  }

  const body = (await response.json()) as { access_token?: unknown; refresh_token?: unknown; shouldLogout?: unknown };
  if (body.shouldLogout === true) {
    throw new Error(`${provider.id}: Cursor ended this session; run /login ${provider.id} again`);
  }
  if (typeof body.access_token !== 'string') {
    throw new Error(`${provider.id}: token refresh returned no access_token`);
  }

  return {
    type: 'oauth',
    access: body.access_token,
    refresh: typeof body.refresh_token === 'string' ? body.refresh_token : cred.refresh,
    expires: tokenExpiry(body.access_token) ?? Date.now() + TOKEN_TTL_MS,
    ...(cred.email ? { email: cred.email } : {}),
  };
}
