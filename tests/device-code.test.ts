import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deviceCodeLogin, deviceLoginSchema, type Clock } from '../src/llm/auth/engines/device-code.js';
import { afterExchange as museExchange } from '../src/llm/auth/hooks/muse-code.js';
import { afterExchange as factoryExchange } from '../src/llm/auth/hooks/factory-droid.js';
import { saveCredential } from '../src/llm/auth/store.js';
import { loadCatalog, type ProviderEntry } from '../src/llm/catalog/index.js';
import { createProviderFor } from '../src/llm/model-resolver.js';
import { fakeUI } from './fake-ui.js';
import { startFakeServer } from './fake-server.js';

const DEVICE_PROVIDERS = ['xai-oauth', 'muse-code', 'factory-droid', 'kimi-code'];

/** Time moves only when the engine sleeps; every sleep is recorded. */
function fakeClock(): Clock & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return { slept, now: () => now, sleep: async (ms) => void (slept.push(ms), (now += ms)) };
}

/** A device endpoint plus a token endpoint that answers `tokenReplies` in order (the last one repeats). */
async function deviceServer(device: object, tokenReplies: [number, object][]) {
  return startFakeServer((req, res) => {
    const [status, body] = req.url === '/device' ? [200, device] : tokenReplies.length > 1 ? tokenReplies.shift()! : tokenReplies[0];
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
}

const provider = (url: string, extra: object = {}): ProviderEntry => ({
  id: 'dev', name: 'Dev', defaultModel: 'm', env: [], api: 'openai-completions', baseUrl: url,
  login: { type: 'device-code', clientId: 'cid', scopes: ['a', 'b'], deviceUrl: `${url}/device`, tokenUrl: `${url}/token`, source: 'test', ...extra },
});

const DEVICE = { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://example.test/device', interval: 2, expires_in: 600 };

test('the four device-code providers have a valid login with a source for their client ID', () => {
  const catalog = loadCatalog(fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-device-')));
  for (const id of DEVICE_PROVIDERS) {
    const p = catalog.providers().find((x) => x.id === id)!;
    assert.ok(deviceLoginSchema.safeParse(p.login).success, id);
    assert.match(String(p.login?.source), /^https:\/\//, id);
  }
});

test('polling honours interval, waits through authorization_pending and adds 5 s on slow_down', async () => {
  const srv = await deviceServer(DEVICE, [
    [400, { error: 'authorization_pending' }],
    [400, { error: 'slow_down' }],
    [400, { error: 'authorization_pending' }],
    [200, { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 }],
  ]);
  try {
    const clock = fakeClock();
    const ui = fakeUI();
    const credential = await deviceCodeLogin(provider(srv.url), ui, clock);
    assert.deepEqual(clock.slept, [2000, 2000, 7000, 7000]);
    assert.deepEqual([credential.type, (credential as { access: string }).access, (credential as { refresh: string }).refresh], ['oauth', 'acc', 'ref']);
    assert.match(ui.printed[0], /Open https:\/\/example\.test\/device and enter the code ABCD-1234/);
    const deviceForm = new URLSearchParams(srv.seen[0].body.toString());
    assert.deepEqual([deviceForm.get('client_id'), deviceForm.get('scope')], ['cid', 'a b']);
    const tokenForm = new URLSearchParams(srv.seen[1].body.toString());
    assert.deepEqual([tokenForm.get('grant_type'), tokenForm.get('device_code')], ['urn:ietf:params:oauth:grant-type:device_code', 'dc']);
  } finally {
    await srv.close();
  }
});

test('polling stops when expires_in runs out', async () => {
  const srv = await deviceServer({ ...DEVICE, interval: 5, expires_in: 12 }, [[400, { error: 'authorization_pending' }]]);
  try {
    const clock = fakeClock();
    await assert.rejects(deviceCodeLogin(provider(srv.url), fakeUI(), clock), /code expired before sign-in finished\. Run \/login dev again/);
    assert.deepEqual(clock.slept, [5000, 5000, 5000]);
    assert.equal(srv.seen.length, 3, 'device request + 2 polls; the third wake-up is past the deadline');
  } finally {
    await srv.close();
  }
});

test('a denied sign-in and a changed flow are reported, not retried', async () => {
  const denied = await deviceServer(DEVICE, [[400, { error: 'access_denied' }]]);
  try {
    await assert.rejects(deviceCodeLogin(provider(denied.url), fakeUI(), fakeClock()), /was denied/);
  } finally {
    await denied.close();
  }
  const gone = await startFakeServer((req, res) => res.writeHead(404).end());
  try {
    await assert.rejects(deviceCodeLogin(provider(gone.url), fakeUI(), fakeClock()), /login flow of dev has changed \(device request returned HTTP 404\)/);
  } finally {
    await gone.close();
  }
});

test('userinfo adds the email to the stored credential', async () => {
  const srv = await startFakeServer((req, res) => {
    const body = req.url === '/device' ? DEVICE : req.url === '/me' ? { email: 'me@example.test' } : { access_token: 'acc' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  try {
    const credential = await deviceCodeLogin(provider(srv.url, { userinfoUrl: `${srv.url}/me` }), fakeUI(), fakeClock());
    assert.equal((credential as { email?: string }).email, 'me@example.test');
    assert.equal(srv.seen.at(-1)!.headers.authorization, 'Bearer acc');
  } finally {
    await srv.close();
  }
});

/** Answers requests to `host` from `replies`; everything else goes to the real fetch (the fake servers). */
function mockHost(t: { mock: { method: typeof test.mock.method } }, host: string, reply: (init?: RequestInit) => Response) {
  const real = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith(host) ? reply(init) : real(input, init));
}

const oauth = { type: 'oauth' as const, access: 'meta-token' };
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('muse-code exchanges the account token for the Model API key the wire uses', async (t) => {
  let seen: RequestInit | undefined;
  mockHost(t, 'https://api.meta.ai/', (init) => ((seen = init), json({ api_key: 'muse-key', is_subs_active: true })));
  assert.deepEqual(await museExchange(oauth, {}, {} as ProviderEntry), { type: 'api_key', key: 'muse-key' });
  assert.equal((seen!.headers as Record<string, string>).authorization, 'Bearer meta-token');
});

test('muse-code without an active subscription fails with the reason', async (t) => {
  mockHost(t, 'https://api.meta.ai/', () => json({ is_subs_active: false }));
  await assert.rejects(museExchange(oauth, {}, {} as ProviderEntry), /not active/);
  t.mock.restoreAll();
  mockHost(t, 'https://api.meta.ai/', () => json({ require_payment: true, action_url: 'https://pay.example' }));
  await assert.rejects(museExchange(oauth, {}, {} as ProviderEntry), /needs a subscription: https:\/\/pay\.example/);
});

test('factory-droid stores the org ID header and the EU host from whoami', async (t) => {
  mockHost(t, 'https://api.factory.ai/', () => json({ orgId: 'org_1', region: 'eu' }));
  const credential = await factoryExchange({ ...oauth, refresh: 'r' }, {}, {} as ProviderEntry);
  assert.deepEqual(credential, { type: 'oauth', access: 'meta-token', refresh: 'r', headers: { 'X-Factory-Org-Id': 'org_1' }, baseUrl: 'https://api.eu.factory.ai' });
  t.mock.restoreAll();
  mockHost(t, 'https://api.factory.ai/', () => json({}));
  await assert.rejects(factoryExchange(oauth, {}, {} as ProviderEntry), /did not resolve an organization/);
});

test('createProviderFor sends the headers and base URL a login stored with the token', async (t) => {
  const saved = process.env.AXIOM_HOME;
  t.after(() => (saved === undefined ? delete process.env.AXIOM_HOME : (process.env.AXIOM_HOME = saved)));
  process.env.AXIOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-device-home-'));
  const srv = await startFakeServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })));
  try {
    saveCredential('kimi-code', { type: 'oauth', access: 'kimi-token', expires: Date.now() + 3_600_000, headers: { 'x-account': 'a1' }, baseUrl: `${srv.url}/coding/v1` });
    const info = loadCatalog().models('kimi-code')[0];
    await (await createProviderFor(info)).chat({ model: info.id, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(srv.seen[0].url, '/coding/v1/chat/completions');
    assert.deepEqual([srv.seen[0].headers.authorization, srv.seen[0].headers['x-account']], ['Bearer kimi-token', 'a1']);
  } finally {
    await srv.close();
  }
});
