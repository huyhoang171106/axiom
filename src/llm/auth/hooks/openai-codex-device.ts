// src/llm/auth/hooks/openai-codex-device.ts - luồng device code của OpenAI Codex (ChatGPT Plus/Pro)

import type { ProviderEntry } from '../../catalog/index.js';
import { hookSleep, type LoginContext, type StoredCredential } from '../engines/hook.js';

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const JWT_PROFILE_CLAIM = 'https://api.openai.com/profile';

interface CodexLogin {
  clientId: string;
  deviceUrl: string;
  tokenUrl: string;
  exchangeUrl: string;
  redirectUri: string;
  verificationUrl: string;
}

interface JsonResponse<T> {
  status: number;
  ok: boolean;
  body?: T;
}

function readString(provider: ProviderEntry, field: string): string {
  const value = provider.login?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${provider.id}: auth file is missing login.${field}`);
  }
  return value;
}

function config(provider: ProviderEntry): CodexLogin {
  return {
    clientId: readString(provider, 'clientId'),
    deviceUrl: readString(provider, 'deviceUrl'),
    tokenUrl: readString(provider, 'tokenUrl'),
    exchangeUrl: readString(provider, 'exchangeUrl'),
    redirectUri: readString(provider, 'redirectUri'),
    verificationUrl: readString(provider, 'verificationUrl'),
  };
}

async function requestJson<T>(url: string, init: RequestInit): Promise<JsonResponse<T>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  let body: T | undefined;
  try {
    body = text.length > 0 ? (JSON.parse(text) as T) : undefined;
  } catch {
    // Endpoint lỗi có thể trả HTML; phần còn lại chỉ cần status.
    body = undefined;
  }
  return { status: response.status, ok: response.ok, body };
}

function emailFromToken(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const profile = payload[JWT_PROFILE_CLAIM] as { email?: unknown } | undefined;
    if (typeof profile?.email !== 'string') return undefined;
    return profile.email.trim().toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function intervalMs(value: unknown): number {
  const seconds = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_INTERVAL_MS;
}

async function exchange(cfg: CodexLogin, code: string, verifier: string): Promise<StoredCredential> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: cfg.redirectUri,
  });
  const result = await requestJson<{ access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }>(
    cfg.exchangeUrl,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
  );
  if (!result.ok) throw new Error(`OpenAI Codex token exchange failed (${result.status}); run /login openai-codex again`);
  const access = result.body?.access_token;
  const refresh = result.body?.refresh_token;
  const expiresIn = result.body?.expires_in;
  if (typeof access !== 'string' || typeof refresh !== 'string' || typeof expiresIn !== 'number') {
    throw new Error('OpenAI Codex token response is missing access_token, refresh_token or expires_in');
  }
  const email = emailFromToken(access);
  return {
    type: 'oauth',
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
    ...(email ? { email } : {}),
  };
}

export async function login(ctx: LoginContext): Promise<StoredCredential> {
  const cfg = config(ctx.provider);
  const sleep = ctx.sleep ?? hookSleep;

  const init = await requestJson<{ device_auth_id?: unknown; user_code?: unknown; interval?: unknown }>(cfg.deviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId }),
  });
  if (!init.ok) {
    throw new Error(`OpenAI Codex device authorization failed (${init.status}); run /login openai-codex again`);
  }
  const deviceAuthId = init.body?.device_auth_id;
  const userCode = init.body?.user_code;
  if (typeof deviceAuthId !== 'string' || typeof userCode !== 'string') {
    throw new Error('OpenAI Codex device authorization response is missing device_auth_id or user_code');
  }

  const pollMs = intervalMs(init.body?.interval);
  ctx.ui.print(`Open ${cfg.verificationUrl} and enter code ${userCode}`);

  const deadline = Date.now() + DEVICE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await requestJson<{ authorization_code?: unknown; code_verifier?: unknown }>(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });
    if (result.status === 403 || result.status === 404) {
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleep(Math.min(pollMs, remaining));
      continue;
    }
    if (!result.ok) {
      throw new Error(`OpenAI Codex device polling failed (${result.status}); run /login openai-codex again`);
    }

    const code = result.body?.authorization_code;
    const verifier = result.body?.code_verifier;
    if (typeof code !== 'string' || typeof verifier !== 'string') {
      throw new Error('OpenAI Codex device response is missing authorization_code or code_verifier');
    }
    return exchange(cfg, code, verifier);
  }

  throw new Error('OpenAI Codex device authorization timed out; run /login openai-codex again');
}

export async function refresh(cred: StoredCredential, provider: ProviderEntry): Promise<StoredCredential> {
  if (cred.type !== 'oauth') throw new Error(`${provider.id}: stored credential is not oauth`);
  if (!cred.refresh) throw new Error(`${provider.id}: stored credential has no refresh token; run /login ${provider.id} again`);

  const cfg = config(provider);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    refresh_token: cred.refresh,
  });
  const result = await requestJson<{ access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }>(
    cfg.exchangeUrl,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
  );
  if (!result.ok) {
    throw new Error(`${provider.id}: token refresh failed (${result.status}); run /login ${provider.id} again`);
  }
  const access = result.body?.access_token;
  if (typeof access !== 'string') throw new Error(`${provider.id}: token refresh returned no access_token`);
  const expiresIn = result.body?.expires_in;
  const nextRefresh = result.body?.refresh_token;
  const email = emailFromToken(access) ?? cred.email;
  return {
    type: 'oauth',
    access,
    refresh: typeof nextRefresh === 'string' ? nextRefresh : cred.refresh,
    expires: Date.now() + (typeof expiresIn === 'number' ? expiresIn * 1000 : 3_600_000),
    ...(email ? { email } : {}),
  };
}
