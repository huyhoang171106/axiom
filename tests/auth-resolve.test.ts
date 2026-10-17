import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCredential } from '../src/llm/auth/resolve.js';
import { jwtExpiry, refreshIfNeeded } from '../src/llm/auth/refresh.js';
import { readAuth, saveCredential } from '../src/llm/auth/store.js';
import type { ProviderEntry } from '../src/llm/catalog/index.js';
import { startFakeServer } from './fake-server.js';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-resolve-'));
const gateway = (apiKey: string) => ({ baseUrl: 'https://gw.example/v1', api: 'openai-completions', apiKey, models: [{ id: 'm', contextWindow: 1000 }] });
const writeModelsJson = (home: string, providers: object) => fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers }));

test('the six credential sources apply in order: cli, models.json, oauth, login, env, ~/.axiom/.env', async () => {
  const home = tempHome();
  writeModelsJson(home, { deepseek: { apiKey: 'from-models-json' } });
  saveCredential('deepseek', { type: 'oauth', access: 'from-oauth', expires: Date.now() + 3_600_000 }, home);
  fs.writeFileSync(path.join(home, '.env'), 'DEEPSEEK_API_KEY=from-axiom-env\n');
  const env = { DEEPSEEK_API_KEY: 'from-env' };
  const resolve = (cliKey?: string) => resolveCredential('deepseek', { cliKey, env, home });

  assert.deepEqual(await resolve('from-cli'), { value: 'from-cli', source: 'cli' });
  assert.deepEqual(await resolve(), { value: 'from-models-json', source: 'models.json' });
  fs.rmSync(path.join(home, 'models.json'));
  assert.deepEqual(await resolve(), { value: 'from-oauth', source: 'oauth' });
  saveCredential('deepseek', { type: 'api_key', key: 'from-login' }, home);
  assert.deepEqual(await resolve(), { value: 'from-login', source: 'login' });
  fs.rmSync(path.join(home, 'auth.json'));
  assert.deepEqual(await resolve(), { value: 'from-env', source: 'env' });
  assert.deepEqual(await resolveCredential('deepseek', { env: {}, home }), { value: 'from-axiom-env', source: 'axiom-env' });
  fs.rmSync(path.join(home, '.env'));
  assert.equal(await resolveCredential('deepseek', { env: {}, home }), null);
});

test('env names are tried in the order the catalog lists them', async () => {
  const home = tempHome();
  assert.equal((await resolveCredential('huggingface', { env: { HF_TOKEN: 'second' }, home }))?.value, 'second');
  assert.equal((await resolveCredential('huggingface', { env: { HF_TOKEN: 'second', HUGGINGFACE_HUB_TOKEN: 'first' }, home }))?.value, 'first');
});

test('models.json apiKey: !command output, a set env name, or the literal string', async () => {
  const home = tempHome();
  writeModelsJson(home, { a: gateway('!echo abc'), b: gateway('MY_GATEWAY_KEY'), c: gateway('NOT_SET_ANYWHERE') });
  const env = { MY_GATEWAY_KEY: 'gw-value' };
  assert.deepEqual(await resolveCredential('a', { env, home }), { value: 'abc', source: 'models.json' });
  assert.equal((await resolveCredential('b', { env, home }))?.value, 'gw-value');
  assert.equal((await resolveCredential('c', { env, home }))?.value, 'NOT_SET_ANYWHERE');
});

test('a failing apiKey command reports the provider, not its output', async () => {
  const home = tempHome();
  writeModelsJson(home, { a: gateway('!node -e "console.log(\'leak\');process.exit(3)"') });
  await assert.rejects(resolveCredential('a', { env: {}, home }), (e: Error) => e.message.includes('apiKey command for a failed') && !e.message.includes('leak'));
});

function oauthProvider(tokenUrl: string, refresh: unknown = { tokenUrl }): ProviderEntry {
  return { id: 'p', name: 'P', defaultModel: 'm', env: [], api: 'openai-completions', baseUrl: tokenUrl, login: { type: 'device-code', clientId: 'cid' }, refresh };
}

test('a token expiring within 5 minutes is refreshed and saved; a fresh one is used as is', async () => {
  const srv = await startFakeServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'new-access', expires_in: 3600 })));
  try {
    const home = tempHome();
    const provider = oauthProvider(`${srv.url}/token`);
    const fresh = { type: 'oauth' as const, access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 };
    assert.equal(await refreshIfNeeded(provider, fresh, home), fresh);
    assert.equal(srv.seen.length, 0);

    const refreshed = await refreshIfNeeded(provider, { type: 'oauth', access: 'old', refresh: 'r-1', expires: Date.now() + 60_000, email: 'e@x' }, home);
    assert.equal(refreshed.access, 'new-access');
    assert.equal(refreshed.refresh, 'r-1', 'a response without refresh_token keeps the old one');
    assert.equal(refreshed.email, 'e@x');
    assert.ok(refreshed.expires! > Date.now() + 3_500_000);
    assert.deepEqual(readAuth(home).p, refreshed);
    const form = new URLSearchParams(srv.seen[0].body.toString());
    assert.deepEqual([form.get('grant_type'), form.get('refresh_token'), form.get('client_id')], ['refresh_token', 'r-1', 'cid']);
  } finally {
    await srv.close();
  }
});

test('a refresh rejected with 400 or 401 deletes the credential and asks for /login', async () => {
  for (const status of [400, 401]) {
    const srv = await startFakeServer((req, res) => res.writeHead(status).end('{"error":"invalid_grant"}'));
    try {
      const home = tempHome();
      const stale = { type: 'oauth' as const, access: 'old', refresh: 'dead', expires: Date.now() - 1000 };
      saveCredential('p', stale, home);
      await assert.rejects(refreshIfNeeded(oauthProvider(`${srv.url}/token`), stale, home), /Run \/login p again/);
      assert.equal(readAuth(home).p, undefined);
    } finally {
      await srv.close();
    }
  }
});

test('a server error during refresh keeps the credential', async () => {
  const srv = await startFakeServer((req, res) => res.writeHead(503).end());
  try {
    const home = tempHome();
    const stale = { type: 'oauth' as const, access: 'old', refresh: 'r', expires: Date.now() - 1000 };
    saveCredential('p', stale, home);
    await assert.rejects(refreshIfNeeded(oauthProvider(`${srv.url}/token`), stale, home), /HTTP 503/);
    assert.deepEqual(readAuth(home).p, stale);
  } finally {
    await srv.close();
  }
});

test('an expired token with no way to refresh is deleted', async () => {
  const home = tempHome();
  const stale = { type: 'oauth' as const, access: 'old', expires: Date.now() - 1000 };
  saveCredential('p', stale, home);
  await assert.rejects(refreshIfNeeded(oauthProvider('http://127.0.0.1:1', 'none'), stale, home), /\/login p/);
  assert.equal(readAuth(home).p, undefined);
});

test('jwtExpiry reads exp from a JWT and ignores opaque tokens', () => {
  const jwt = `x.${Buffer.from(JSON.stringify({ exp: 1700000000 })).toString('base64url')}.y`;
  assert.equal(jwtExpiry(jwt), 1700000000_000);
  assert.equal(jwtExpiry('opaque-token'), undefined);
});
