// src/llm/auth/hooks/github-copilot.ts - luồng device code của GitHub Copilot

import type { ProviderEntry } from '../../catalog/index.js';
import { hookSleep, type LoginContext, type StoredCredential } from '../engines/hook.js';

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_EXPIRES_SECONDS = 900;
const TEN_YEARS_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

interface CopilotLogin {
  clientId: string;
  enterpriseClientId?: string;
  scopes: string;
  deviceUrl: string;
  tokenUrl: string;
  verificationUrl: string;
  defaultOrigin: string;
  headers: Record<string, string>;
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

function readHeaders(provider: ProviderEntry): Record<string, string> {
  const raw = provider.login?.headers;
  if (!raw || typeof raw !== 'object') return {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

function config(provider: ProviderEntry): CopilotLogin {
  const enterpriseClientId = provider.login?.enterpriseClientId;
  return {
    clientId: readString(provider, 'clientId'),
    enterpriseClientId: typeof enterpriseClientId === 'string' ? enterpriseClientId : undefined,
    scopes: readString(provider, 'scopes'),
    deviceUrl: readString(provider, 'deviceUrl'),
    tokenUrl: readString(provider, 'tokenUrl'),
    verificationUrl: readString(provider, 'verificationUrl'),
    defaultOrigin: readString(provider, 'defaultOrigin'),
    headers: readHeaders(provider),
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

function normalizeOrigin(input: string, fallback: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return fallback;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('Invalid GitHub Enterprise URL/domain');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Invalid GitHub Enterprise URL/domain');
  }
  return url.origin;
}

function expand(template: string, origin: string): string {
  return template.replaceAll('{origin}', origin);
}

function clientIdFor(cfg: CopilotLogin, origin: string): string {
  return new URL(origin).hostname === 'github.com' ? cfg.clientId : (cfg.enterpriseClientId ?? cfg.clientId);
}

export async function login(ctx: LoginContext): Promise<StoredCredential> {
  const cfg = config(ctx.provider);
  const origin = normalizeOrigin(await ctx.ui.ask('GitHub Enterprise URL/domain (blank for github.com)'), cfg.defaultOrigin);
  const clientId = clientIdFor(cfg, origin);
  const headers = { ...cfg.headers, 'Content-Type': 'application/x-www-form-urlencoded' };

  const device = await requestJson<{
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    interval?: unknown;
    expires_in?: unknown;
  }>(expand(cfg.deviceUrl, origin), {
    method: 'POST',
    headers,
    body: new URLSearchParams({ client_id: clientId, scope: cfg.scopes }),
  });
  if (!device.ok) {
    throw new Error(`GitHub Copilot device authorization failed (${device.status}); run /login github-copilot again`);
  }

  const deviceCode = device.body?.device_code;
  const userCode = device.body?.user_code;
  const verificationUri = device.body?.verification_uri;
  if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
    throw new Error('GitHub Copilot device authorization response is missing device_code, user_code or verification_uri');
  }

  const intervalSeconds = device.body?.interval;
  let intervalMs =
    typeof intervalSeconds === 'number' && Number.isFinite(intervalSeconds) && intervalSeconds >= 0
      ? intervalSeconds * 1000
      : DEFAULT_INTERVAL_MS;
  const expiresIn =
    typeof device.body?.expires_in === 'number' && Number.isFinite(device.body.expires_in) && device.body.expires_in >= 0
      ? device.body.expires_in
      : DEFAULT_EXPIRES_SECONDS;
  const deadline = Date.now() + expiresIn * 1000;
  const sleep = ctx.sleep ?? hookSleep;
  let slowDowns = 0;

  ctx.ui.print(`Open ${verificationUri} and enter code ${userCode}`);

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(intervalMs, remaining));
    if (Date.now() >= deadline) break;

    const result = await requestJson<{ access_token?: unknown; error?: unknown; error_description?: unknown; interval?: unknown }>(
      expand(cfg.tokenUrl, origin),
      {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      },
    );
    if (!result.ok) {
      throw new Error(`GitHub Copilot device polling failed (${result.status}); run /login github-copilot again`);
    }

    if (typeof result.body?.access_token === 'string') {
      const token = result.body.access_token;
      return {
        type: 'oauth',
        access: token,
        refresh: token,
        expires: Date.now() + TEN_YEARS_MS,
      };
    }

    if (result.body?.error === 'authorization_pending') continue;
    if (result.body?.error === 'slow_down') {
      slowDowns++;
      const serverInterval = result.body.interval;
      intervalMs =
        typeof serverInterval === 'number' && Number.isFinite(serverInterval) && serverInterval > 0
          ? serverInterval * 1000
          : intervalMs + 5000;
      continue;
    }

    const detail = typeof result.body?.error_description === 'string' ? `: ${result.body.error_description}` : '';
    throw new Error(`GitHub Copilot device flow failed${detail}; run /login github-copilot again`);
  }

  const reason = slowDowns > 0 ? 'Device flow expired after slow_down' : 'Device flow expired';
  throw new Error(`GitHub Copilot: ${reason}; run /login github-copilot again`);
}

export async function refresh(cred: StoredCredential, _provider: ProviderEntry): Promise<StoredCredential> {
  if (cred.type !== 'oauth') throw new Error('GitHub Copilot: stored credential is not oauth');
  const token = cred.refresh ?? cred.access;
  return {
    type: 'oauth',
    access: token,
    refresh: token,
    expires: Date.now() + TEN_YEARS_MS,
    ...(cred.email ? { email: cred.email } : {}),
  };
}
