import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CommandUI } from '../src/commands/types.js';
import type { ProviderEntry } from '../src/llm/catalog/index.js';
import { loadCatalog } from '../src/llm/catalog/index.js';
import { oauthCodeLogin, oauthLoginSchema, parsePasted, type OAuthDeps } from '../src/llm/auth/engines/oauth-code.js';

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
  const ready = ['openai-codex', 'anthropic', 'devin', 'gitlab-duo', 'gitlab-duo-agent'];
  const entries = loadCatalog(undefined).providers();
  for (const id of ready) {
    const entry = entries.find((p) => p.id === id);
    const parsed = oauthLoginSchema.safeParse(entry?.login);
    assert.ok(parsed.success, `${id}: ${parsed.error?.message}`);
  }
  const fixedPort = oauthLoginSchema.parse(entries.find((p) => p.id === 'openai-codex')?.login).callback;
  assert.ok('port' in fixedPort && fixedPort.port === 1455);
});
