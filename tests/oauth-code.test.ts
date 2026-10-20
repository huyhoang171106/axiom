import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CommandUI } from '../src/commands/types.js';
import type { ProviderEntry } from '../src/llm/catalog/index.js';
import { loadCatalog } from '../src/llm/catalog/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandContext } from '../src/commands/types.js';
import { loginCommand } from '../src/commands/login.js';
import { resolveCredential } from '../src/llm/auth/resolve.js';
import { readAuth } from '../src/llm/auth/store.js';
import { defaultOAuthDeps, oauthCodeLogin, oauthLoginSchema, parsePasted, type OAuthDeps } from '../src/llm/auth/engines/oauth-code.js';

interface TokenRequest {
  contentType: string;
  body: Record<string, string>;
}

/** A fake token endpoint on 127.0.0.1 that records requests and answers with `reply`. */
async function tokenServer(reply: { status?: number; body: unknown }): Promise<{ url: string; requests: TokenRequest[]; close(): void }> {
  const requests: TokenRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const contentType = req.headers['content-type'] ?? '';
      const body = contentType.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      requests.push({ contentType, body });
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`, requests, close: () => server.close() };
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function provider(login: Record<string, unknown>): ProviderEntry {
  return { id: 'fake', name: 'Fake', defaultModel: 'm', env: [], api: 'openai-completions', baseUrl: 'http://127.0.0.1', login: { type: 'oauth-code', ...login } as ProviderEntry['login'] };
}

function standardLogin(tokenUrl: string, callback: Record<string, unknown>) {
  return {
    clientId: 'client-1',
    authorizeUrl: 'https://auth.example.test/authorize',
    tokenUrl,
    scopes: ['a', 'b'],
    authorizeParams: {
      response_type: 'code',
      client_id: '{client_id}',
      redirect_uri: '{redirect_uri}',
      scope: '{scope}',
      state: '{state}',
      code_challenge: '{code_challenge}',
      code_challenge_method: 'S256',
    },
    callback,
    tokenBody: 'form',
    tokenParams: { grant_type: 'authorization_code', client_id: '{client_id}', code: '{code}', code_verifier: '{code_verifier}', redirect_uri: '{redirect_uri}' },
    credential: { access: 'access_token', refresh: 'refresh_token', expires: 'expires_in' },
    source: 'test',
  };
}

const ui = (answer: string | (() => Promise<string>), printed: string[] = []): CommandUI => ({
  print: (line) => printed.push(line),
  ask: async () => (typeof answer === 'function' ? answer() : answer),
  confirm: async () => false,
});

/** The "browser": reads the authorize URL and hits the redirect with a code and the given (or real) state. */
function browser(opts: { state?: (real: string) => string } = {}): OAuthDeps & { authorize?: URL } {
  const deps: OAuthDeps & { authorize?: URL } = {
    callbackTimeoutMs: 5_000,
    openBrowser(url) {
      const authorize = new URL(url);
      deps.authorize = authorize;
      const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('code', 'the-code');
      redirect.searchParams.set('state', opts.state ? opts.state(authorize.searchParams.get('state')!) : authorize.searchParams.get('state')!);
      void fetch(redirect).catch(() => {});
    },
  };
  return deps;
}

test('loopback login: PKCE S256, matching state, form token exchange', async (t) => {
  const token = await tokenServer({ body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } });
  t.after(token.close);
  const port = await freePort();
  const deps = browser();
  const credential = await oauthCodeLogin(provider(standardLogin(token.url, { port, path: '/cb' })), ui(''), deps);

  assert.equal(credential.type, 'oauth');
  assert.ok(credential.type === 'oauth' && credential.access === 'at-1' && credential.refresh === 'rt-1' && credential.expires! > Date.now());
  const authorize = deps.authorize!;
  assert.equal(authorize.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/cb`);
  assert.equal(authorize.searchParams.get('scope'), 'a b');
  const [request] = token.requests;
  assert.match(request.contentType, /x-www-form-urlencoded/);
  assert.equal(request.body.code, 'the-code');
  const challenge = crypto.createHash('sha256').update(request.body.code_verifier).digest('base64url');
  assert.equal(challenge, authorize.searchParams.get('code_challenge'), 'the verifier matches the challenge');
});

test('a callback with the wrong state is refused and never exchanged', async (t) => {
  const token = await tokenServer({ body: { access_token: 'at' } });
  t.after(token.close);
  const login = standardLogin(token.url, { port: await freePort(), path: '/cb' });
  await assert.rejects(oauthCodeLogin(provider(login), ui(''), browser({ state: () => 'forged' })), /state does not match/);
  assert.equal(token.requests.length, 0);
});

test('a callback without state is refused; only a pasted bare code may omit it', async (t) => {
  const token = await tokenServer({ body: { access_token: 'at' } });
  t.after(token.close);
  const login = standardLogin(token.url, { port: await freePort(), path: '/cb' });
  const noState: OAuthDeps = {
    callbackTimeoutMs: 5_000,
    openBrowser(url) {
      const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!);
      redirect.searchParams.set('code', 'c');
      void fetch(redirect).catch(() => {});
    },
  };
  await assert.rejects(oauthCodeLogin(provider(login), ui(''), noState), /state does not match/);
  assert.equal(token.requests.length, 0);
  const pasted = await oauthCodeLogin(provider({ ...login, callback: { port: await freePort(), path: '/cb' } }), ui('bare-code'), { callbackTimeoutMs: 1_000, openBrowser: () => {} });
  assert.ok(pasted.type === 'oauth' && token.requests[0].body.code === 'bare-code');
});

test('a pasted redirect URL finishes the login when the callback never arrives', async (t) => {
  const token = await tokenServer({ body: { access_token: 'at-paste' } });
  t.after(token.close);
  let authorize!: URL;
  const deps: OAuthDeps = { callbackTimeoutMs: 5_000, openBrowser: (url) => (authorize = new URL(url)) };
  const paste = async () => `http://localhost:1455/cb?code=pasted-code&state=${authorize.searchParams.get('state')}`;
  const credential = await oauthCodeLogin(provider(standardLogin(token.url, { port: await freePort(), path: '/cb' })), ui(paste), deps);
  assert.ok(credential.type === 'oauth' && credential.access === 'at-paste');
  assert.equal(token.requests[0].body.code, 'pasted-code');
});

test('a busy fixed port is an error before the browser opens, not a different port', async (t) => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const { port } = blocker.address() as AddressInfo;
  let opened = false;
  const deps: OAuthDeps = { callbackTimeoutMs: 1_000, openBrowser: () => (opened = true) };
  await assert.rejects(oauthCodeLogin(provider(standardLogin('http://127.0.0.1:9/token', { port, path: '/cb' })), ui(''), deps), new RegExp(`Port ${port} is already in use`));
  assert.equal(opened, false);
});

test('manual-only redirect, JSON token body with custom params and a nested credential path', async (t) => {
  const token = await tokenServer({ body: { data: { token: 'nested-at' } } });
  t.after(token.close);
  const login = {
    ...standardLogin(token.url, { manualOnly: true, redirectUri: 'app://callback' }),
    tokenBody: 'json',
    tokenParams: { code: '{code}', code_verifier: '{code_verifier}' },
    credential: { access: 'data.token' },
  };
  const credential = await oauthCodeLogin(provider(login), ui('app://callback?code=c1'), { callbackTimeoutMs: 1_000, openBrowser: () => {} });
  assert.ok(credential.type === 'oauth' && credential.access === 'nested-at');
  assert.match(token.requests[0].contentType, /json/);
  assert.deepEqual(Object.keys(token.requests[0].body).sort(), ['code', 'code_verifier']);
});

test('manual-only login without a paste fails with how to retry', async () => {
  const login = standardLogin('http://127.0.0.1:9/token', { manualOnly: true, redirectUri: 'app://callback' });
  await assert.rejects(oauthCodeLogin(provider(login), ui(''), { callbackTimeoutMs: 1_000, openBrowser: () => {} }), /paste the redirect URL/);
});

test('a token error says the login flow changed; a provider error in the redirect is reported', async (t) => {
  const token = await tokenServer({ status: 400, body: { error: 'invalid_grant' } });
  t.after(token.close);
  await assert.rejects(oauthCodeLogin(provider(standardLogin(token.url, { port: await freePort(), path: '/cb' })), ui(''), browser()), /login flow of fake has changed/);
  const manual = standardLogin(token.url, { manualOnly: true, redirectUri: 'app://cb' });
  await assert.rejects(oauthCodeLogin(provider(manual), ui('app://cb?error=access_denied'), browser()), /failed: access_denied/);
});

test('parsePasted reads a URL, code#state and a bare code', () => {
  assert.deepEqual(parsePasted('http://localhost/cb?code=x&state=s'), { code: 'x', state: 's' });
  assert.deepEqual(parsePasted('abc#st'), { code: 'abc', state: 'st' });
  assert.deepEqual(parsePasted(' abc '), { code: 'abc', state: undefined });
});

test('the oauth-code providers set up so far have a valid login and a source', () => {
  const ready = ['openai-codex', 'anthropic', 'devin', 'gitlab-duo', 'gitlab-duo-agent', 'openrouter', 'zai-coding-plan', 'google-gemini-cli', 'google-antigravity'];
  const entries = loadCatalog(undefined).providers();
  for (const id of ready) {
    const entry = entries.find((p) => p.id === id);
    const parsed = oauthLoginSchema.safeParse(entry?.login);
    assert.ok(parsed.success, `${id}: ${parsed.error?.message}`);
  }
  const fixedPort = oauthLoginSchema.parse(entries.find((p) => p.id === 'openai-codex')?.login).callback;
  assert.ok('port' in fixedPort && fixedPort.port === 1455);
});

/** Runs `/login <id>` with the real auth JSON: temp AXIOM_HOME, no browser, `fetch` answered locally. */
async function loginThroughCommand(
  t: { after(fn: () => void): void },
  id: string,
  paste: (authorize: URL) => string,
  reply: unknown,
  files: Record<string, string> = {},
): Promise<{ home: string; authorize: URL; token: { url: string; init: RequestInit }; calls: { url: string; init: RequestInit }[] }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-oauth-'));
  const previous = { home: process.env.AXIOM_HOME, fetch: globalThis.fetch, open: defaultOAuthDeps.openBrowser };
  process.env.AXIOM_HOME = home;
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(home, name), text);
  let authorize!: URL;
  const calls: { url: string; init: RequestInit }[] = [];
  defaultOAuthDeps.openBrowser = (url) => (authorize = new URL(url));
  // `reply` is the token response, or per URL when the login makes more calls than the token exchange.
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const body = typeof reply === 'function' ? (reply as (url: string, init: RequestInit) => unknown)(String(input), init ?? {}) : reply;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => {
    globalThis.fetch = previous.fetch;
    defaultOAuthDeps.openBrowser = previous.open;
    if (previous.home === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = previous.home;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const ctxUi: CommandUI = { print: () => {}, ask: async () => paste(authorize), confirm: async () => false };
  const result = await loginCommand.run(id, { ui: ctxUi } as CommandContext);
  assert.match(result?.text ?? '', /^Connected /);
  return { home, authorize, token: calls[0], calls };
}

test('/login gitlab-duo-agent: paste-only redirect, form exchange with the real client, stored and resolvable', async (t) => {
  const { home, authorize, token } = await loginThroughCommand(
    t,
    'gitlab-duo-agent',
    (a) => `vscode://gitlab.gitlab-workflow/authentication?code=gl-code&state=${a.searchParams.get('state')}`,
    { access_token: 'gl-access', refresh_token: 'gl-refresh', expires_in: 7200 },
  );
  assert.equal(authorize.origin + authorize.pathname, 'https://gitlab.com/oauth/authorize');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'vscode://gitlab.gitlab-workflow/authentication');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(token.url, 'https://gitlab.com/oauth/token');
  const form = new URLSearchParams(String(token.init.body));
  assert.equal(form.get('client_id'), '36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5');
  assert.equal(form.get('code'), 'gl-code');
  assert.equal(form.get('redirect_uri'), 'vscode://gitlab.gitlab-workflow/authentication');
  const stored = readAuth(home)['gitlab-duo-agent'];
  assert.ok(stored?.type === 'oauth' && stored.access === 'gl-access' && stored.refresh === 'gl-refresh');
  assert.equal((await resolveCredential('gitlab-duo-agent', { home, env: {} }))?.value, 'gl-access');
});

test('/login anthropic: pasted code#state, JSON exchange that carries the state, email from the account', async (t) => {
  let state = '';
  const { home, token } = await loginThroughCommand(
    t,
    'anthropic',
    (a) => `an-code#${(state = a.searchParams.get('state')!)}`,
    { access_token: 'an-access', refresh_token: 'an-refresh', expires_in: 3600, account: { email_address: 'me@example.test' } },
  );
  assert.equal(token.url, 'https://api.anthropic.com/v1/oauth/token');
  assert.match(String((token.init.headers as Record<string, string>)['content-type']), /json/);
  const body = JSON.parse(String(token.init.body)) as Record<string, string>;
  assert.deepEqual([body.code, body.state, body.grant_type], ['an-code', state, 'authorization_code']);
  const stored = readAuth(home).anthropic;
  assert.ok(stored?.type === 'oauth' && stored.access === 'an-access' && stored.email === 'me@example.test');
});

test('a browser Codex login is refreshed by the device hook, so both must use the same client and endpoint', () => {
  const entries = loadCatalog(undefined).providers();
  const browserLogin = oauthLoginSchema.parse(entries.find((p) => p.id === 'openai-codex')?.login);
  const device = entries.find((p) => p.id === 'openai-codex-device')?.login as Record<string, unknown>;
  assert.equal(device.storeAs, 'openai-codex');
  assert.equal(browserLogin.clientId, device.clientId);
  assert.equal(browserLogin.tokenUrl, device.exchangeUrl);
});

test('/login openrouter: no client and no state, PKCE bound to the JSON exchange, the key is stored as an API key', async (t) => {
  const { home, authorize, token } = await loginThroughCommand(t, 'openrouter', () => 'http://localhost:54549/callback?code=or-code', { key: 'sk-or-v1-test' });
  assert.equal(authorize.origin + authorize.pathname, 'https://openrouter.ai/auth');
  assert.equal(authorize.searchParams.get('callback_url'), 'http://localhost:54549/callback');
  assert.ok(!authorize.searchParams.has('state') && !authorize.searchParams.has('client_id'));
  assert.equal(token.url, 'https://openrouter.ai/api/v1/auth/keys');
  const body = JSON.parse(String(token.init.body)) as Record<string, string>;
  assert.equal(body.code, 'or-code');
  assert.equal(crypto.createHash('sha256').update(body.code_verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
  assert.deepEqual(readAuth(home).openrouter, { type: 'api_key', key: 'sk-or-v1-test' });
  assert.equal((await resolveCredential('openrouter', { home, env: {} }))?.value, 'sk-or-v1-test');
});

/** Z.AI token endpoint and business API; `keys` is what the key list returns. */
function zaiServer(keys: unknown) {
  return (url: string, init: RequestInit): unknown => {
    const path = new URL(url).pathname;
    if (url === 'https://zcode.z.ai/api/v1/oauth/token') return { code: 0, msg: 'ok', data: { zai: { access_token: 'zai-oauth' }, user: { email: 'me@example.test' } } };
    if (path === '/api/auth/z/login') return { code: 200, success: true, data: { access_token: 'zai-biz' } };
    if (path === '/api/biz/customer/getCustomerInfo') {
      return { code: 200, success: true, data: { organizations: [{ organizationId: 'org-0', projects: [] }, { organizationId: 'org-1', isDefault: true, projects: [{ projectId: 'proj-1', isDefault: true }] }] } };
    }
    if (path.endsWith('/api_keys')) return { code: 200, success: true, data: init.method === 'POST' ? { name: 'axiom', apiKey: 'new-id' } : keys };
    if (path.includes('/api_keys/copy/')) return { code: 200, success: true, data: { secretKey: `secret-of-${path.split('/').pop()}` } };
    return { code: 404, success: false, msg: `unexpected ${url}` };
  };
}

test('/login zai-coding-plan: pasted zcode:// redirect, state checked, an `axiom` key is created and stored under zai-coding-plan', async (t) => {
  let state = '';
  const { home, authorize, token, calls } = await loginThroughCommand(
    t,
    'zai-coding-plan',
    (a) => `zcode://zai-auth/callback?code=zai-code&state=${(state = a.searchParams.get('state')!)}`,
    zaiServer({ list: [{ name: 'zcode-api-key', apiKey: 'zcode-id' }] }),
  );
  assert.equal(authorize.origin + authorize.pathname, 'https://chat.z.ai/api/oauth/authorize');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'zcode://zai-auth/callback');
  assert.ok(!authorize.searchParams.has('code_challenge'), 'Z.AI uses no PKCE');
  assert.deepEqual(JSON.parse(String(token.init.body)), { provider: 'zai', code: 'zai-code', redirect_uri: 'zcode://zai-auth/callback', state });
  const biz = calls.slice(2);
  assert.ok(biz.every((c) => (c.init.headers as Record<string, string>).authorization === 'Bearer zai-biz'), 'business calls use the business token');
  const create = calls.find((c) => c.init.method === 'POST' && c.url.endsWith('/api_keys'));
  assert.ok(create?.url.includes('/organization/org-1/projects/proj-1/'), 'the default organization and project');
  assert.deepEqual(JSON.parse(String(create?.init.body)), { name: 'axiom' });
  assert.deepEqual(readAuth(home)['zai-coding-plan'], { type: 'api_key', key: 'new-id.secret-of-new-id' });
  assert.equal(readAuth(home).zai, undefined, 'the zai API-key login is left alone');
});

test('/login zai-coding-plan reuses an existing `axiom` key instead of creating another', async (t) => {
  const { home, calls } = await loginThroughCommand(t, 'zai-coding-plan', (a) => `zai-code#${a.searchParams.get('state')}`, zaiServer([{ name: 'axiom', apiKey: 'old-id' }]));
  assert.ok(!calls.some((c) => c.init.method === 'POST' && c.url.endsWith('/api_keys')));
  assert.deepEqual(readAuth(home)['zai-coding-plan'], { type: 'api_key', key: 'old-id.secret-of-old-id' });
});

test('/login zai-coding-plan: a wrong state is refused before any call, a business API error is reported', async (t) => {
  const entry = loadCatalog(undefined).providers().find((p) => p.id === 'zai-coding-plan')!;
  const deps = { callbackTimeoutMs: 1_000, openBrowser: () => {} };
  await assert.rejects(oauthCodeLogin(entry, ui('zcode://zai-auth/callback?code=c&state=forged'), deps), /state does not match/);

  const previous = globalThis.fetch;
  t.after(() => (globalThis.fetch = previous));
  let authorize!: URL;
  globalThis.fetch = async (input) => {
    const reply = String(input).startsWith('https://zcode.z.ai/')
      ? { code: 0, data: { zai: { access_token: 'zai-oauth' } } }
      : { code: 401, success: false, msg: 'Coding Plan not active' };
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const pasteRealState = ui(async () => `c#${authorize.searchParams.get('state')}`);
  await assert.rejects(oauthCodeLogin(entry, pasteRealState, { ...deps, openBrowser: (url) => (authorize = new URL(url)) }), /business login failed: Coding Plan not active/);
});

/** Sets env names for one test (undefined deletes) and puts them back afterwards. */
function withEnv(t: { after(fn: () => void): void }, values: Record<string, string | undefined>): void {
  const previous = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => Object.entries(v).forEach(([k, x]) => (x === undefined ? delete process.env[k] : (process.env[k] = x)));
  apply(values);
  t.after(() => apply(previous));
}

const googleToken = { access_token: 'ya29.test', refresh_token: '1//refresh', expires_in: 3599 };

test('/login google-gemini-cli: the client secret comes from the env, never the URL; an onboarded account is accepted', async (t) => {
  withEnv(t, { GEMINI_CLI_OAUTH_CLIENT_SECRET: 'test-secret', GOOGLE_CLOUD_PROJECT: undefined, GOOGLE_CLOUD_PROJECT_ID: undefined });
  const { home, authorize, token, calls } = await loginThroughCommand(
    t,
    'google-gemini-cli',
    (a) => `http://127.0.0.1:8085/oauth2callback?code=g-code&state=${a.searchParams.get('state')}`,
    (url: string) => (url.endsWith(':loadCodeAssist') ? { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'proj-free' } : googleToken),
  );
  assert.equal(authorize.searchParams.get('access_type'), 'offline');
  assert.ok(!authorize.toString().includes('test-secret'), 'the secret is not in the authorize URL');
  const form = new URLSearchParams(String(token.init.body));
  assert.deepEqual([form.get('client_secret'), form.get('code'), form.get('redirect_uri')], ['test-secret', 'g-code', 'http://127.0.0.1:8085/oauth2callback']);
  assert.equal(calls[1].url, 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
  assert.equal((calls[1].init.headers as Record<string, string>).authorization, 'Bearer ya29.test');
  assert.equal(calls.length, 2, 'an onboarded account is not onboarded again');
  const stored = readAuth(home)['google-gemini-cli'];
  assert.ok(stored?.type === 'oauth' && stored.access === 'ya29.test' && stored.refresh === '1//refresh');
  assert.equal(stored.headers?.['x-goog-user-project'], 'proj-free', 'the project the google-gemini-cli wire reads');
});

test('google login without the client secret says which variable to set, before the browser opens', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-oauth-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  withEnv(t, { AXIOM_HOME: home, GEMINI_CLI_OAUTH_CLIENT_SECRET: undefined });
  const entry = loadCatalog(undefined).providers().find((p) => p.id === 'google-gemini-cli')!;
  let opened = false;
  await assert.rejects(oauthCodeLogin(entry, ui(''), { callbackTimeoutMs: 1_000, openBrowser: () => (opened = true) }), /set GEMINI_CLI_OAUTH_CLIENT_SECRET/);
  assert.equal(opened, false);
});

test('/login google-antigravity: secret from ~/.axiom/.env, PKCE, a new account is onboarded on the Antigravity endpoint', async (t) => {
  withEnv(t, { ANTIGRAVITY_OAUTH_CLIENT_SECRET: undefined, GOOGLE_CLOUD_PROJECT: undefined, GOOGLE_CLOUD_PROJECT_ID: undefined });
  let polls = 0;
  const { home, authorize, token, calls } = await loginThroughCommand(
    t,
    'google-antigravity',
    (a) => `http://127.0.0.1:51121/oauth-callback?code=ag-code&state=${a.searchParams.get('state')}`,
    (url: string) => {
      if (url.endsWith(':loadCodeAssist')) return { allowedTiers: [{ id: 'free-tier', isDefault: true }] };
      if (url.endsWith(':onboardUser')) return { name: 'operations/op-1', done: false };
      if (url.endsWith('/operations/op-1')) return ++polls < 2 ? { name: 'operations/op-1', done: false } : { done: true, response: { cloudaicompanionProject: 'proj-ag' } };
      return googleToken;
    },
    { '.env': 'ANTIGRAVITY_OAUTH_CLIENT_SECRET="ag-secret"\n' },
  );
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  const form = new URLSearchParams(String(token.init.body));
  assert.equal(form.get('client_secret'), 'ag-secret');
  assert.equal(crypto.createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), authorize.searchParams.get('code_challenge'));
  const onboard = calls.find((c) => c.url.endsWith(':onboardUser'))!;
  assert.ok(onboard.url.startsWith('https://daily-cloudcode-pa.googleapis.com/'));
  assert.deepEqual(JSON.parse(String(onboard.init.body)), { tierId: 'free-tier', metadata: { ideType: 'ANTIGRAVITY' } });
  assert.equal(polls, 2, 'the operation is polled until done');
  const stored = readAuth(home)['google-antigravity'];
  assert.ok(stored?.type === 'oauth' && stored.headers?.['x-goog-user-project'] === 'proj-ag', 'the project made by onboarding');
});

test("google login: a refusal is reported with Google's reason; a Workspace account without a project is told to set one", async (t) => {
  withEnv(t, { GEMINI_CLI_OAUTH_CLIENT_SECRET: 's', GOOGLE_CLOUD_PROJECT: undefined, GOOGLE_CLOUD_PROJECT_ID: undefined });
  const entry = loadCatalog(undefined).providers().find((p) => p.id === 'google-gemini-cli')!;
  const previous = globalThis.fetch;
  t.after(() => (globalThis.fetch = previous));
  let load: { status: number; body: unknown } = { status: 403, body: { error: { code: 403, message: 'Gemini Code Assist is not available in your country' } } };
  globalThis.fetch = async (input) => {
    const reply = String(input).endsWith(':loadCodeAssist') ? load : { status: 200, body: googleToken };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  let authorize!: URL;
  const paste = ui(async () => `http://127.0.0.1:8085/oauth2callback?code=c&state=${authorize.searchParams.get('state')}`);
  const deps = { callbackTimeoutMs: 1_000, openBrowser: (url: string) => (authorize = new URL(url)) };
  await assert.rejects(oauthCodeLogin(entry, paste, deps), /lookup failed with HTTP 403: Gemini Code Assist is not available in your country/);
  load = { status: 200, body: { currentTier: { id: 'standard-tier' } } };
  await assert.rejects(oauthCodeLogin(entry, paste, deps), /needs a Cloud project: set GOOGLE_CLOUD_PROJECT/);
  const reason = { reasonMessage: 'Verify your account to continue.', validationUrl: 'https://accounts.google.com/verify' };
  load = { status: 200, body: { currentTier: { id: 'standard-tier' }, ineligibleTiers: [reason] } };
  await assert.rejects(oauthCodeLogin(entry, paste, deps), /refused this account: Verify your account to continue\. https:\/\/accounts\.google\.com\/verify/);
});
