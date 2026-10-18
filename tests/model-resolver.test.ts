import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { AxiomConfig } from '../src/core/types.js';
import { loadCatalog, type Catalog } from '../src/llm/catalog/index.js';
import { createProviderFor, NO_PROVIDER_MESSAGE, resolveModel } from '../src/llm/model-resolver.js';
import { ProviderError } from '../src/llm/provider-error.js';
import { startFakeServer } from './fake-server.js';

const base = loadCatalog(fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-resolver-')));
/** The real catalog, with availability fixed so the developer's own env vars cannot change the result. */
const catalogWith = (...available: string[]): Catalog => ({ ...base, isAvailable: (id) => available.includes(id) });
const config = (extra: Partial<AxiomConfig> = {}): AxiomConfig => ({ ...DEFAULT_CONFIG, ...extra });
const defaultOf = (provider: string) => base.providers().find((p) => p.id === provider)!.defaultModel;

test('an unset role falls back along the table: @smol -> @default, @plan -> @slow -> @default', () => {
  const cfg = config({ modelRoles: { default: 'deepseek/deepseek-v4-pro' } });
  for (const role of ['@smol', '@plan', '@review', '@task']) assert.equal(resolveModel(role, catalogWith('deepseek'), cfg).id, 'deepseek-v4-pro', role);
  const withSlow = config({ modelRoles: { default: 'deepseek/deepseek-v4-pro', slow: `groq/${defaultOf('groq')}` } });
  assert.equal(resolveModel('@plan', catalogWith('deepseek', 'groq'), withSlow).provider, 'groq');
});

test('a role alias loop is an error, not a hang', () => {
  const cfg = config({ modelRoles: { default: '@smol', smol: '@slow', slow: '@default' } });
  assert.throws(() => resolveModel('@default', catalogWith('deepseek'), cfg), /alias cycle: @default -> @smol -> @slow -> @default/);
  assert.throws(() => resolveModel('@nope', catalogWith(), cfg), /Unknown model role @nope/);
});

test('a comma list picks the first available selector', () => {
  const cfg = config({ modelRoles: { smol: `deepseek/deepseek-v4-pro, groq/${defaultOf('groq')}` } });
  assert.equal(resolveModel('@smol', catalogWith('groq'), cfg).provider, 'groq');
  assert.equal(resolveModel('@smol', catalogWith('groq', 'deepseek'), cfg).provider, 'deepseek');
  assert.throws(() => resolveModel('@smol', catalogWith(), cfg), /None of/);
});

test('disabledProviders wins over a credential', () => {
  const cfg = config({ disabledProviders: ['deepseek'], modelRoles: { default: `deepseek/deepseek-v4-pro, groq/${defaultOf('groq')}` } });
  assert.equal(resolveModel('@default', catalogWith('deepseek', 'groq'), cfg).provider, 'groq');
  assert.throws(() => resolveModel('deepseek/deepseek-v4-pro', catalogWith('deepseek'), cfg), /turned off/);
});

test('a thinking suffix is split off only when it is a level', () => {
  const glm = resolveModel('zai/glm-5.3:high', catalogWith('zai'), config());
  assert.deepEqual([glm.provider, glm.id, glm.thinking], ['zai', 'glm-5.3', 'high']);
  const oss = resolveModel('ollama/gpt-oss:20b', catalogWith('ollama'), config());
  assert.deepEqual([oss.id, oss.thinking], ['gpt-oss:20b', undefined]);
});

test('a bare id matches exactly, ignoring case, preferring the last used provider', () => {
  assert.equal(resolveModel('DEEPSEEK-V4-PRO', catalogWith('deepseek'), config()).provider, 'deepseek');
  const shared = 'glm-5.3';
  const owners = base.models().filter((m) => m.id === shared).map((m) => m.provider);
  assert.ok(owners.length > 1, 'fixture: glm-5.3 is served by several providers');
  assert.equal(resolveModel(shared, catalogWith(), config({ defaultModel: `${owners[1]}/${shared}` })).provider, owners[1]);
});

test('an unknown selector is an error with near suggestions, never a guess', () => {
  assert.throws(() => resolveModel('deepseek/deepseek-v4-por', catalogWith('deepseek'), config()), (e: Error) => e.message.includes('Unknown model') && e.message.includes('deepseek/deepseek-v4-pro'));
});

test('with nothing set, @default is the last used model, else the first available provider in /login order', () => {
  assert.equal(resolveModel('@default', catalogWith('groq', 'deepseek'), config()).provider, 'deepseek', 'deepseek comes before groq in /login order');
  assert.equal(resolveModel('@default', catalogWith('groq', 'deepseek'), config({ defaultModel: `groq/${defaultOf('groq')}` })).provider, 'groq');
  assert.equal(resolveModel('@default', catalogWith('groq'), config({ defaultModel: 'deepseek/deepseek-v4-pro' })).provider, 'groq', 'last used but no longer available');
  assert.throws(() => resolveModel('@default', catalogWith(), config()), { message: NO_PROVIDER_MESSAGE });
});

test('createProviderFor refuses a provider with no credential and sends the resolved key to the wire', async (t) => {
  const saved = { home: process.env.AXIOM_HOME, key: process.env.DEEPSEEK_API_KEY };
  t.after(() => {
    for (const [name, value] of [['AXIOM_HOME', saved.home], ['DEEPSEEK_API_KEY', saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.AXIOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-resolver-home-'));
  delete process.env.DEEPSEEK_API_KEY;
  const srv = await startFakeServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })));
  try {
    const info = { ...base.models('deepseek')[0], baseUrl: srv.url };
    await assert.rejects(createProviderFor(info), (e: unknown) => e instanceof ProviderError && e.code === 'missing_credentials' && /\/login deepseek or set DEEPSEEK_API_KEY/.test(e.message));
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    const r = await (await createProviderFor(info)).chat({ model: info.id, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.content, 'ok');
    assert.equal(srv.seen[0].headers.authorization, 'Bearer sk-test');
    assert.ok(await createProviderFor(base.models('ollama')[0]), 'a local provider needs no key');
  } finally {
    await srv.close();
  }
});
