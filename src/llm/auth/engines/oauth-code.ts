// src/llm/auth/engines/oauth-code.ts - `oauth-code` login engine: authorization code + PKCE with a 127.0.0.1 callback (providers.md section 4.3)
//
// Every provider difference lives in the auth JSON: `authorizeParams` and `tokenParams` list the exact
// parameters with `{placeholders}`, and `credential` names where the token response keeps each field.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';
import { registerSecret } from '../../../core/secrets.js';
import type { CommandUI } from '../../../commands/types.js';
import type { ProviderEntry } from '../../catalog/index.js';
import { jwtExpiry, withTimeout } from '../refresh.js';
import type { AfterExchangeHook } from './device-code.js';
import type { Credential, LoginEngine } from './index.js';

type OAuthCredential = Extract<Credential, { type: 'oauth' }>;

const params = z.record(z.string(), z.string());

export const oauthLoginSchema = z.object({
  type: z.literal('oauth-code'),
  clientId: z.string().min(1).optional(),
  authorizeUrl: z.url(),
  tokenUrl: z.url(),
  scopes: z.array(z.string().min(1)).optional(),
  /** Query of the authorize URL. Uses `{code_challenge}` for PKCE; `{state}` makes the returned state mandatory. */
  authorizeParams: params,
  /** Fixed port on 127.0.0.1 (busy = error, never another port), or `manualOnly` when the redirect is an app scheme. */
  callback: z.union([
    z.object({ port: z.number().int().min(1).max(65535), path: z.string().startsWith('/'), redirectUri: z.url().optional() }).strict(),
    z.object({ manualOnly: z.literal(true), redirectUri: z.string().min(1) }).strict(),
  ]),
  tokenBody: z.enum(['form', 'json']),
  tokenParams: params,
  headers: params.optional(),
  /** Dotted paths into the token response; `expires` is seconds from now, otherwise a JWT `exp` is used. */
  credential: z.object({ access: z.string().min(1), refresh: z.string().optional(), expires: z.string().optional(), email: z.string().optional() }).strict(),
  /** `api_key`: `access` is a durable key (OpenRouter), stored and sent as an API key. */
  result: z.literal('api_key').optional(),
  /** `src/llm/auth/hooks/<afterExchange>.ts`, for providers that need more than the token (same hook as device-code). */
  afterExchange: z.string().regex(/^[a-z0-9-]+$/).optional(),
  instructions: z.string().optional(),
  source: z.string().min(1),
}).strict();
type OAuthLogin = z.infer<typeof oauthLoginSchema>;

/** Injectable side effects, so tests drive the flow without a browser or real waiting. */
export interface OAuthDeps {
  openBrowser(url: string): void;
  callbackTimeoutMs: number;
}

const CALLBACK_TIMEOUT_MS = 5 * 60_000;

function openBrowser(url: string): void {
  // rundll32 avoids cmd.exe, which would split the URL at every `&`.
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // No browser (SSH, container): the URL is printed and the user can paste the redirect back.
  }
}
/** What /login uses; tests that go through the command swap `openBrowser` so no real browser opens. */
export const defaultOAuthDeps: OAuthDeps = { openBrowser, callbackTimeoutMs: CALLBACK_TIMEOUT_MS };

function flowChanged(provider: ProviderEntry, detail: string): Error {
  return new Error(`The login flow of ${provider.id} has changed (${detail}). Use an API key, or update src/llm/catalog/auth/${provider.id}.json.`);
}

function fill(template: Record<string, string>, values: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(template)) {
    let missing = false;
    const value = raw.replace(/\{(\w+)\}/g, (_, name: string) => {
      if (!(name in values)) throw new Error(`unknown placeholder {${name}}`);
      if (values[name] === undefined) missing = true;
      return values[name] ?? '';
    });
    if (!missing) out[key] = value; // `{scope}` without scopes drops the parameter instead of sending it empty.
  }
  return out;
}

function pick(body: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), body);
}

interface Returned {
  code: string;
  state?: string;
}

/** A pasted redirect URL (`?code=…&state=…`), `code#state` (Anthropic's manual page), or a bare code. */
export function parsePasted(text: string): Returned | { error: string } {
  const trimmed = text.trim();
  if (trimmed.includes('://')) {
    const url = new URL(trimmed);
    const query = new URLSearchParams(url.search || url.hash.replace(/^#/, ''));
    const error = query.get('error');
    if (error) return { error };
    const code = query.get('code');
    if (!code) return { error: 'the pasted URL has no code' };
    return { code, state: query.get('state') ?? undefined };
  }
  const [code, state] = trimmed.split('#');
  return { code, state: state || undefined };
}

/** Listens on 127.0.0.1 only; resolves with the first request to `path` that carries a code or an error. */
async function listen(port: number, path: string): Promise<{ result: Promise<Returned | { error: string }>; close(): void }> {
  let settle!: (value: Returned | { error: string }) => void;
  const result = new Promise<Returned | { error: string }>((resolve) => (settle = resolve));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    res.writeHead(code && !error ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(code && !error ? 'Signed in. You can close this tab and go back to Axiom.' : 'Sign-in failed. Go back to Axiom for details.');
    settle(error || !code ? { error: error ?? 'the callback has no code' } : { code, state: url.searchParams.get('state') ?? undefined });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use; close the program using it and run /login again.`) : err),
    );
    server.listen(port, '127.0.0.1', resolve);
  });
  // closeAllConnections: the browser's keep-alive socket would otherwise hold the process open for seconds.
  return { result, close: () => (server.close(), server.closeAllConnections()) };
}

async function waitOrTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function exchange(provider: ProviderEntry, login: OAuthLogin, form: Record<string, string>): Promise<unknown> {
  const response = await fetch(login.tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': login.tokenBody === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
      ...login.headers,
    },
    body: login.tokenBody === 'json' ? JSON.stringify(form) : new URLSearchParams(form),
    signal: withTimeout(undefined),
  });
  const text = await response.text();
  if (!response.ok) throw flowChanged(provider, `token request returned HTTP ${response.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw flowChanged(provider, 'token response is not JSON');
  }
}

function toCredential(provider: ProviderEntry, login: OAuthLogin, body: unknown): OAuthCredential {
  const access = pick(body, login.credential.access);
  if (typeof access !== 'string' || !access) throw flowChanged(provider, `token response has no ${login.credential.access}`);
  const refresh = login.credential.refresh ? pick(body, login.credential.refresh) : undefined;
  const seconds = login.credential.expires ? Number(pick(body, login.credential.expires)) : NaN;
  const email = login.credential.email ? pick(body, login.credential.email) : undefined;
  [access, refresh].forEach((v) => typeof v === 'string' && v && registerSecret(v));
  return {
    type: 'oauth',
    access,
    ...(typeof refresh === 'string' && refresh && { refresh }),
    expires: Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : jwtExpiry(access),
    ...(typeof email === 'string' && email && { email }),
  };
}

export async function oauthCodeLogin(provider: ProviderEntry, ui: CommandUI, deps: OAuthDeps = defaultOAuthDeps): Promise<Credential> {
  const parsed = oauthLoginSchema.safeParse(provider.login);
  if (!parsed.success) throw new Error(`${provider.id}: browser sign-in is not set up in src/llm/catalog/auth/${provider.id}.json yet.`);
  const login = parsed.data;

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = login.callback.redirectUri ?? ('port' in login.callback ? `http://127.0.0.1:${login.callback.port}${login.callback.path}` : '');
  const values = {
    client_id: login.clientId,
    redirect_uri: redirectUri,
    scope: login.scopes?.join(' '),
    state,
    code_challenge: challenge,
    code_verifier: verifier,
  };
  const authorize = new URL(login.authorizeUrl);
  for (const [key, value] of Object.entries(fill(login.authorizeParams, values))) authorize.searchParams.set(key, value);
  const checksState = Object.values(login.authorizeParams).some((v) => v.includes('{state}'));

  // Bind before showing the URL, so a busy port fails before the user signs in for nothing.
  const server = 'port' in login.callback ? await listen(login.callback.port, login.callback.path) : undefined;
  let returned: Returned | { error: string };
  let fromCallback = false;
  try {
    ui.print(login.instructions ?? `Sign in to ${provider.name} in your browser.`);
    ui.print(authorize.toString());
    deps.openBrowser(authorize.toString());
    const prompt = server
      ? 'Press Enter once the browser says you are signed in, or paste the redirect URL or code if it could not reach Axiom:'
      : 'Paste the redirect URL (or the code) the browser ends on:';
    // ask() cannot be cancelled, so it is asked once and the callback is awaited only after it returns.
    const pasted = await ui.ask(prompt).catch(() => ''); // headless: no terminal, wait for the callback alone
    if (pasted.trim()) returned = parsePasted(pasted);
    else if (server) {
      returned = await waitOrTimeout(server.result, deps.callbackTimeoutMs, `No sign-in arrived for ${provider.id}. Run /login ${provider.id} again.`);
      fromCallback = true;
    } else throw new Error(`${provider.id}: paste the redirect URL to finish signing in. Run /login ${provider.id} again.`);
  } finally {
    server?.close();
  }

  if ('error' in returned) throw new Error(`Sign-in to ${provider.id} failed: ${returned.error}`);
  // Only a pasted bare code may come without state; a state that is present must match.
  const stateOk = returned.state === undefined ? !fromCallback : returned.state === state;
  if (checksState && !stateOk) throw new Error(`Sign-in to ${provider.id} was refused: the state does not match (possible forged redirect).`);
  const body = await exchange(provider, login, fill(login.tokenParams, { ...values, code: returned.code }));
  const credential = toCredential(provider, login, body);
  if (login.afterExchange) {
    const hook = (await import(`../hooks/${login.afterExchange}.js`)) as AfterExchangeHook;
    return hook.afterExchange(credential, body, provider);
  }
  return login.result === 'api_key' ? { type: 'api_key', key: credential.access } : credential;
}

export const oauthCodeEngine: LoginEngine = (provider, ui) => oauthCodeLogin(provider, ui);
