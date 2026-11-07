import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authFileSchema, loadCatalog, providerFileSchema } from '../src/llm/catalog/index.js';
import { saveCredential } from '../src/llm/auth/store.js';

const catalogDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'llm', 'catalog');
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
const UNSUPPORTED = ['apple', 'cloudflare-workers-ai', 'local', 'typesafe'];

function tempHome(files: Record<string, string> = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-catalog-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(home, name), content);
  return home;
}

test('every catalog JSON file matches its schema and its file name', () => {
  for (const half of ['providers', 'auth'] as const) {
    const files = fs.readdirSync(path.join(catalogDir, half)).filter((f) => f.endsWith('.json') && f !== '_order.json');
    assert.equal(files.length, 91, half);
    for (const file of files) {
      const schema = half === 'providers' ? providerFileSchema : authFileSchema;
      const parsed = schema.safeParse(readJson(path.join(catalogDir, half, file)));
      assert.ok(parsed.success, `${half}/${file}: ${parsed.success ? '' : parsed.error.message}`);
      assert.equal(`${parsed.data.id}.json`, file);
    }
  }
});

test('every provider with a login is in _order.json, and the order names only real providers', () => {
  const order = readJson(path.join(catalogDir, 'auth', '_order.json')) as string[];
  const providers = loadCatalog(tempHome()).providers();
  for (const p of providers.filter((x) => x.login)) assert.ok(order.includes(p.id), p.id);
  for (const id of order) assert.ok(providers.some((p) => p.id === id), id);
  assert.equal(new Set(order).size, order.length);
});

test('the four unsupported providers say why and have no models; the other 87 have models', () => {
  const catalog = loadCatalog(tempHome());
  for (const id of UNSUPPORTED) {
    const p = catalog.providers().find((x) => x.id === id);
    assert.equal(p?.available, false, id);
    assert.ok(p?.reason, id);
    assert.deepEqual(catalog.models(id), []);
    assert.equal(catalog.isAvailable(id, { TYPESAFE_API_KEY: 'x' }), false);
  }
  const supported = catalog.providers().filter((p) => p.available !== false);
  assert.equal(supported.length, 87);
  for (const p of supported) assert.ok(catalog.models(p.id).some((m) => m.id === p.defaultModel), p.id);
});

test('a local provider is available without a key; a keyed one needs env, ~/.axiom/.env or a login', () => {
  const home = tempHome();
  const catalog = loadCatalog(home);
  assert.equal(catalog.isAvailable('ollama', {}), true);
  assert.equal(catalog.isAvailable('deepseek', {}), false);
  assert.equal(catalog.isAvailable('deepseek', { DEEPSEEK_API_KEY: 'sk-1' }), true);
  assert.equal(catalog.isAvailable('huggingface', { HF_TOKEN: 'hf-1' }), true, 'second env name counts too');
  fs.writeFileSync(path.join(home, '.env'), 'GROQ_API_KEY=gsk-1\n');
  assert.equal(catalog.isAvailable('groq', {}), true);
  saveCredential('zai', { type: 'api_key', key: 'z' }, home);
  assert.equal(catalog.isAvailable('zai', {}), true);
  assert.equal(catalog.isAvailable('no-such-provider', {}), false);
});

test('disabledProviders wins over a credential; enabledProviders limits the list', () => {
  const env = { DEEPSEEK_API_KEY: 'sk-1', GROQ_API_KEY: 'gsk-1' };
  const disabled = loadCatalog(tempHome({ 'config.json': JSON.stringify({ disabledProviders: ['deepseek', 'ollama'] }) }));
  assert.equal(disabled.isAvailable('deepseek', env), false);
  assert.equal(disabled.isAvailable('ollama', {}), false);
  assert.equal(disabled.isAvailable('groq', env), true);
  const enabled = loadCatalog(tempHome({ 'config.json': JSON.stringify({ enabledProviders: ['groq'] }) }));
  assert.equal(enabled.isAvailable('deepseek', env), false);
  assert.equal(enabled.isAvailable('groq', env), true);
});

test('a broken models.json is ignored and the built-in catalog still loads', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const catalog = loadCatalog(tempHome({ 'models.json': '{ "providers": ' }));
  assert.equal(catalog.providers().length, 91);
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes('not valid JSON')));
});

test('models.json overrides a base URL, adds a provider and skips one missing api', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const home = tempHome({
    'models.json': JSON.stringify({
      providers: {
        openrouter: { baseUrl: 'https://proxy.example/openrouter/v1', models: undefined, discovery: { type: 'openai-models' } },
        'my-gateway': { baseUrl: 'https://gw.example/v1', api: 'openai-completions', apiKey: 'MY_GW_KEY', models: [{ id: 'qwen3-coder' }] },
        'half-done': { baseUrl: 'https://x.example/v1', models: [{ id: 'm' }] },
      },
    }),
  });
  const catalog = loadCatalog(home);
  assert.ok(catalog.models('openrouter').every((m) => m.baseUrl === 'https://proxy.example/openrouter/v1'));
  const [gw] = catalog.models('my-gateway');
  assert.deepEqual([gw.id, gw.baseUrl, gw.api, gw.contextWindow], ['qwen3-coder', 'https://gw.example/v1', 'openai-completions', 128000]);
  assert.equal(catalog.isAvailable('my-gateway', {}), true, 'apiKey in models.json counts as a credential');
  assert.deepEqual(catalog.models('half-done'), []);
  const messages = warn.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(messages.some((m) => m.includes('"half-done" skipped: missing api')));
  assert.ok(messages.some((m) => m.includes('"openrouter" override ignores discovery')));
  assert.ok(messages.some((m) => m.includes('my-gateway/qwen3-coder" has no contextWindow')));
});

test('the discovery cache adds new models; seed metadata and models.json win', () => {
  const seedId = 'deepseek-v4-pro';
  const home = tempHome({
    'models-cache.json': JSON.stringify({ deepseek: { fetchedAt: Date.now(), models: [{ id: seedId, contextWindow: 1 }, { id: 'brand-new' }] } }),
    'models.json': JSON.stringify({ providers: { deepseek: { models: [{ id: 'mine', contextWindow: 9000, name: 'Mine' }] } } }),
  });
  const models = loadCatalog(home).models('deepseek');
  assert.notEqual(models.find((m) => m.id === seedId)?.contextWindow, 1);
  assert.equal(models.find((m) => m.id === 'brand-new')?.contextWindow, 128000);
  assert.equal(models.find((m) => m.id === 'mine')?.name, 'Mine');
});

test('both ChatGPT Codex logins call the codex responses endpoint with a model the backend accepts', () => {
  for (const id of ['openai-codex', 'openai-codex-device']) {
    const p = providerFileSchema.parse(readJson(path.join(catalogDir, 'providers', `${id}.json`)));
    // The wire appends `/responses`; `backend-api/responses` is a 404 on chatgpt.com.
    assert.equal(`${p.baseUrl}/responses`, 'https://chatgpt.com/backend-api/codex/responses', id);
    // `gpt-5.5` is rejected for ChatGPT-account Codex logins.
    assert.equal(p.defaultModel, 'gpt-6.1-sol', id);
    assert.ok(!p.seed.some((m) => m.id === 'gpt-5.5'), id);
  }
});
