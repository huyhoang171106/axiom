import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { CommandUI } from '../src/commands/types.js';
import type { ProviderEntry } from '../src/llm/catalog/index.js';
import { hookEngine, loadHook } from '../src/llm/auth/engines/hook.js';
import * as codex from '../src/llm/auth/hooks/openai-codex-device.js';
import * as copilot from '../src/llm/auth/hooks/github-copilot.js';
import * as cursor from '../src/llm/auth/hooks/cursor.js';
import { startFakeServer, type SeenRequest } from './fake-server.js';

function fakeUi(answers: string[] = []) {
  const printed: string[] = [];
  const asked: string[] = [];
  const sleeps: number[] = [];
  const ui: CommandUI = {
    print(text) {
      printed.push(text);
    },
    async ask(question) {
      asked.push(question);
      return answers.shift() ?? '';
    },
    async confirm() {
      return false;
    },
  };
  return {
    ui,
    printed,
    asked,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

function provider(id: string, login: Record<string, unknown>): ProviderEntry {
  return {
    id,
    name: id,
    defaultModel: 'test-model',
    env: [],
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1',
    login: { type: 'hook', ...login },
  };
}

function codexProvider(baseUrl: string): ProviderEntry {
  return provider('openai-codex-device', {
    clientId: 'codex-client',
    deviceUrl: `${baseUrl}/device`,
    tokenUrl: `${baseUrl}/token`,
    exchangeUrl: `${baseUrl}/exchange`,
    redirectUri: 'https://auth.openai.com/deviceauth/callback',
    verificationUrl: 'https://auth.openai.com/codex/device',
  });
}

function copilotProvider(baseUrl: string): ProviderEntry {
  return provider('github-copilot', {
    clientId: 'public-client',
    enterpriseClientId: 'enterprise-client',
    scopes: 'read:user',
    defaultOrigin: 'https://github.com',
    deviceUrl: '{origin}/login/device/code',
    tokenUrl: '{origin}/login/oauth/access_token',
    verificationUrl: '{origin}/login/device',
    headers: { Accept: 'application/json' },
  });
}

function cursorProvider(baseUrl: string): ProviderEntry {
  return provider('cursor', {
    clientId: 'cursor-client',
    loginUrl: `${baseUrl}/loginDeepControl`,
    pollUrl: `${baseUrl}/auth/poll`,
    refreshUrl: `${baseUrl}/oauth/token`,
  });
}

function jwt(claims: Record<string, unknown>): string {
  return ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
}

function jsonBody(req: SeenRequest): Record<string, unknown> {
  return JSON.parse(req.body.toString('utf8')) as Record<string, unknown>;
}

function formBody(req: SeenRequest): URLSearchParams {
  return new URLSearchParams(req.body.toString('utf8'));
}

test('openai-codex-device polls pending then exchanges the authorization code', async () => {
  let tokenPolls = 0;
  const access = jwt({
    'https://api.openai.com/profile': { email: 'User@Example.com' },
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
  });
  const srv = await startFakeServer((req, res) => {
    if (req.url === '/device') {
      res.writeHead(200).end(JSON.stringify({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 0 }));
      return;
    }
    if (req.url === '/token') {
      tokenPolls++;
      if (tokenPolls === 1) {
        res.writeHead(403).end('{}');
        return;
      }
      res.writeHead(200).end(JSON.stringify({ authorization_code: 'code-1', code_verifier: 'verifier-1' }));
      return;
    }
    if (req.url === '/exchange') {
      res.writeHead(200).end(JSON.stringify({ access_token: access, refresh_token: 'refresh-1', expires_in: 3600 }));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const fake = fakeUi();
    const cred = await codex.login({ provider: codexProvider(srv.url), ui: fake.ui, sleep: fake.sleep });
    if (cred.type !== 'oauth') assert.fail('expected an oauth credential');
    assert.equal(cred.access, access);
    assert.equal(cred.refresh, 'refresh-1');
    assert.equal(cred.email, 'user@example.com');
    assert.ok(cred.expires && cred.expires > Date.now() + 3_000_000);
    assert.equal(tokenPolls, 2);
    assert.equal(fake.printed.some((line) => line.includes('ABCD-EFGH') && line.includes('codex/device')), true);

    const exchange = srv.seen.find((req) => req.url === '/exchange');
    assert.ok(exchange);
    const sent = formBody(exchange);
    assert.equal(sent.get('grant_type'), 'authorization_code');
    assert.equal(sent.get('client_id'), 'codex-client');
    assert.equal(sent.get('code'), 'code-1');
    assert.equal(sent.get('code_verifier'), 'verifier-1');
    assert.equal(sent.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
  } finally {
    await srv.close();
  }
});

test('openai-codex-device refresh rotates tokens and keeps the old refresh token', async () => {
  const access = jwt({ 'https://api.openai.com/profile': { email: 'new@example.com' } });
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200).end(JSON.stringify({ access_token: access, expires_in: 7200 }));
  });
  try {
    const cred = { type: 'oauth' as const, access: 'old', refresh: 'old-refresh', expires: 1, email: 'old@example.com' };
    const next = await codex.refresh(cred, codexProvider(srv.url));
    if (next.type !== 'oauth') assert.fail('expected an oauth credential');
    assert.equal(next.access, access);
    assert.equal(next.refresh, 'old-refresh');
    assert.equal(next.email, 'new@example.com');
    assert.ok(next.expires && next.expires > Date.now() + 7_000_000);

    const sent = formBody(srv.seen[0]);
    assert.equal(sent.get('grant_type'), 'refresh_token');
    assert.equal(sent.get('client_id'), 'codex-client');
    assert.equal(sent.get('refresh_token'), 'old-refresh');
  } finally {
    await srv.close();
  }
});

test('openai-codex-device respects the polling interval and stops at the deadline', async () => {
  const srv = await startFakeServer((req, res) => {
    if (req.url === '/device') res.writeHead(200).end(JSON.stringify({ device_auth_id: 'device', user_code: 'code', interval: 900 }));
    else res.writeHead(403).end('{}');
  });
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const delays: number[] = [];
  try {
    const fake = fakeUi();
    await assert.rejects(codex.login({ provider: codexProvider(srv.url), ui: fake.ui, sleep: async (ms) => { delays.push(ms); now += ms; } }), /timed out/);
    assert.deepEqual(delays, [900_000]);
    assert.equal(srv.seen.filter((request) => request.url === '/token').length, 1);
  } finally {
    Date.now = originalNow;
    await srv.close();
  }
});

test('github-copilot slow_down increases the poll wait and uses the enterprise client', async () => {
  let polls = 0;
  const srv = await startFakeServer((req, res) => {
    if (req.url === '/login/device/code') {
      res.writeHead(200).end(JSON.stringify({
        device_code: 'device-1',
        user_code: 'CODE-1',
        verification_uri: 'https://github.com/login/device',
        interval: 0,
        expires_in: 30,
      }));
      return;
    }
    if (req.url === '/login/oauth/access_token') {
      polls++;
      res.writeHead(200).end(JSON.stringify(polls === 1 ? { error: 'slow_down' } : { access_token: 'gho_token' }));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const fake = fakeUi([srv.url]);
    const cred = await copilot.login({ provider: copilotProvider(srv.url), ui: fake.ui, sleep: fake.sleep });
    if (cred.type !== 'oauth') assert.fail('expected an oauth credential');
    assert.equal(cred.access, 'gho_token');
    assert.equal(cred.refresh, 'gho_token');
    assert.ok(cred.expires && cred.expires > Date.now() + 9 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(polls, 2);
    assert.equal(fake.asked.length, 1);
    assert.deepEqual(fake.sleeps, [0, 5000]);
    assert.equal(fake.printed.some((line) => line.includes('CODE-1')), true);

    const tokenRequest = srv.seen.find((req) => req.url === '/login/oauth/access_token');
    assert.ok(tokenRequest);
    const sent = formBody(tokenRequest);
    assert.equal(sent.get('client_id'), 'enterprise-client');
    assert.equal(sent.get('device_code'), 'device-1');
    assert.equal(sent.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  } finally {
    await srv.close();
  }
});

test('github-copilot stops with a clear error when the device code expires', async () => {
  const srv = await startFakeServer((req, res) => {
    if (req.url === '/login/device/code') {
      res.writeHead(200).end(JSON.stringify({
        device_code: 'device-1',
        user_code: 'CODE-2',
        verification_uri: 'https://github.com/login/device',
        interval: 0,
        expires_in: 0,
      }));
      return;
    }
    res.writeHead(200).end(JSON.stringify({ access_token: 'unexpected' }));
  });
  try {
    const fake = fakeUi([srv.url]);
    await assert.rejects(
      copilot.login({ provider: copilotProvider(srv.url), ui: fake.ui, sleep: fake.sleep }),
      /expired/i,
    );
    assert.equal(srv.seen.length, 1);
  } finally {
    await srv.close();
  }
});

test('cursor polls 404 then completes with a matching PKCE challenge', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const access = jwt({ exp, sub: 'github|1' });
  let polls = 0;
  const srv = await startFakeServer((req, res) => {
    if (req.url?.startsWith('/auth/poll')) {
      polls++;
      if (polls === 1) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200).end(JSON.stringify({ accessToken: access, refreshToken: 'refresh-cursor' }));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const fake = fakeUi();
    const cred = await cursor.login({ provider: cursorProvider(srv.url), ui: fake.ui, sleep: fake.sleep });
    if (cred.type !== 'oauth') assert.fail('expected an oauth credential');
    assert.equal(cred.access, access);
    assert.equal(cred.refresh, 'refresh-cursor');
    assert.equal(cred.expires, exp * 1000 - 5 * 60 * 1000);
    assert.equal(polls, 2);
    assert.deepEqual(fake.sleeps, [1000, 1200]);

    const printed = fake.printed.find((line) => line.includes('loginDeepControl'));
    assert.ok(printed);
    const match = /Open (\S+) to sign in/.exec(printed);
    assert.ok(match);
    const authUrl = new URL(match[1]);
    assert.equal(authUrl.searchParams.get('mode'), 'login');
    assert.equal(authUrl.searchParams.get('redirectTarget'), 'cli');
    assert.ok(authUrl.searchParams.get('uuid'));

    const pollRequest = srv.seen.find((req) => req.url?.startsWith('/auth/poll'));
    assert.ok(pollRequest);
    const verifier = new URL(pollRequest.url ?? '', 'http://localhost').searchParams.get('verifier');
    assert.ok(verifier);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    assert.equal(authUrl.searchParams.get('challenge'), challenge);
  } finally {
    await srv.close();
  }
});

test('cursor refresh reports an ended session with a login hint', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200).end(JSON.stringify({ shouldLogout: true }));
  });
  try {
    await assert.rejects(
      cursor.refresh({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 }, cursorProvider(srv.url)),
      /run \/login cursor again/,
    );
    const sent = jsonBody(srv.seen[0]);
    assert.equal(sent.grant_type, 'refresh_token');
    assert.equal(sent.client_id, 'cursor-client');
    assert.equal(sent.refresh_token, 'r');
  } finally {
    await srv.close();
  }
});

test('hook engine validates names and loads hooks lazily', async () => {
  const fake = fakeUi();
  await assert.rejects(hookEngine(provider('missing-hook', {}), fake.ui), /no hook name/);
  await assert.rejects(
    hookEngine(provider('bad-hook', { hook: '../evil' }), fake.ui),
    /Invalid login hook name/,
  );

  const hook = await loadHook('cursor');
  assert.equal(typeof hook.login, 'function');
  assert.equal(typeof hook.refresh, 'function');
});
