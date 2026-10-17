import test from 'node:test';
import assert from 'node:assert/strict';
import { apiKeyEngine, apiKeyLoginSchema } from '../src/llm/auth/engines/api-key.js';
import { loadCatalog, type ProviderEntry } from '../src/llm/catalog/index.js';
import { fakeUI } from './fake-ui.js';
import { startFakeServer } from './fake-server.js';

const provider = (baseUrl: string, validate?: object): ProviderEntry => ({
  id: 'p', name: 'P', defaultModel: 'm', env: ['P_API_KEY'], api: 'openai-completions', baseUrl,
  login: { type: 'api-key', prompt: 'Paste P key', ...(validate && { validate }) },
});

test('every api-key login in the catalog matches the engine schema', () => {
  const logins = loadCatalog().providers().filter((p) => p.login?.type === 'api-key');
  assert.ok(logins.length > 50);
  for (const p of logins) assert.ok(apiKeyLoginSchema.safeParse(p.login).success, p.id);
});

test('a key the protected endpoint accepts is returned; one it rejects with 401 is not', async () => {
  const srv = await startFakeServer((req, res) => res.writeHead(req.headers.authorization === 'Bearer good' ? 200 : 401).end('{}'));
  try {
    const p = provider(srv.url, { kind: 'url', url: `${srv.url}/auth/key` });
    assert.deepEqual(await apiKeyEngine(p, fakeUI([' Bearer good '])), { type: 'api_key', key: 'good' });
    await assert.rejects(apiKeyEngine(p, fakeUI(['bad'])), /rejected the key \(HTTP 401\); nothing was saved/);
    assert.equal(srv.seen[0].url, '/auth/key');
  } finally {
    await srv.close();
  }
});

test('chat-completions and anthropic-messages checks send a 1-token request the way each wire authenticates', async () => {
  const srv = await startFakeServer((req, res) => res.writeHead(200).end('{}'));
  try {
    await apiKeyEngine(provider(`${srv.url}/v1`, { kind: 'chat-completions', model: 'm1' }), fakeUI(['k1']));
    await apiKeyEngine(provider(`${srv.url}/anthropic`, { kind: 'anthropic-messages', model: 'm2' }), fakeUI(['k2']));
    await apiKeyEngine(provider(srv.url, { kind: 'url', url: `${srv.url}/models`, header: 'x-goog-api-key' }), fakeUI(['k3']));
    const [chat, messages, google] = srv.seen;
    assert.deepEqual([chat.url, chat.headers.authorization, JSON.parse(chat.body.toString()).max_tokens], ['/v1/chat/completions', 'Bearer k1', 1]);
    assert.deepEqual([messages.url, messages.headers['x-api-key'], JSON.parse(messages.body.toString()).model], ['/anthropic/v1/messages', 'k2', 'm2']);
    assert.deepEqual([google.headers['x-goog-api-key'], google.headers.authorization], ['k3', undefined]);
  } finally {
    await srv.close();
  }
});

test('an inconclusive check saves only when the user confirms', async () => {
  const srv = await startFakeServer((req, res) => res.writeHead(500).end());
  try {
    const p = provider(srv.url, { kind: 'url', url: `${srv.url}/x` });
    await assert.rejects(apiKeyEngine(p, fakeUI(['k'], false)), /Key not saved \(HTTP 500\)/);
    assert.deepEqual(await apiKeyEngine(p, fakeUI(['k'], true)), { type: 'api_key', key: 'k' });
  } finally {
    await srv.close();
  }
});

test('an empty key is refused and a provider without a check endpoint says so', async () => {
  await assert.rejects(apiKeyEngine(provider('http://127.0.0.1:1'), fakeUI(['  '])), /No key entered/);
  const ui = fakeUI(['k']);
  assert.deepEqual(await apiKeyEngine(provider('http://127.0.0.1:1'), ui), { type: 'api_key', key: 'k' });
  assert.match(ui.printed.join('\n'), /saved unchecked/);
});
