import test from 'node:test';
import assert from 'node:assert/strict';
import { AzureOpenAIResponsesProvider, azureResponsesUrl } from '../src/llm/providers/azure-openai-responses.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { ProviderError } from '../src/llm/provider-error.js';
import { startFakeServer } from './fake-server.js';

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const completed = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } };

test('keeps the v1 route and the api-version query, and authenticates with api-key', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'ok' }, completed));
  });
  try {
    const info: ModelInfo = {
      provider: 'azure', id: 'gpt-5.5', name: 'GPT-5.5', api: 'azure-openai-responses',
      baseUrl: `${srv.url}/openai/v1?api-version=2025-04-01-preview`, contextWindow: 400000, reasoning: true,
      input: ['text'], cost: { input: 1, output: 8 },
    };
    const r = await new AzureOpenAIResponsesProvider(info, 'azure-key').chat({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.content, 'ok');
    assert.equal(srv.seen[0].url, '/openai/v1/responses?api-version=2025-04-01-preview');
    assert.equal(srv.seen[0].headers['api-key'], 'azure-key');
    assert.equal(srv.seen[0].headers.authorization, undefined);
    assert.equal(JSON.parse(srv.seen[0].body.toString()).model, 'gpt-5.5');
  } finally {
    await srv.close();
  }
});

test('a catalog api-key header wins over the stored credential', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'ok' }, completed));
  });
  try {
    const info: ModelInfo = {
      provider: 'azure', id: 'gpt-5.5', name: 'GPT-5.5', api: 'azure-openai-responses', baseUrl: `${srv.url}/openai/v1`,
      contextWindow: 400000, reasoning: true, input: ['text'], headers: { 'api-key': 'pinned-key' },
    };
    await new AzureOpenAIResponsesProvider(info, 'azure-key').chat({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(srv.seen[0].headers['api-key'], 'pinned-key');
  } finally {
    await srv.close();
  }
});

test('azureResponsesUrl appends the route before the query string', () => {
  assert.equal(azureResponsesUrl('https://res.openai.azure.com/openai/v1'), 'https://res.openai.azure.com/openai/v1/responses');
  assert.equal(azureResponsesUrl('https://res.openai.azure.com/openai/v1/'), 'https://res.openai.azure.com/openai/v1/responses');
  assert.equal(azureResponsesUrl('https://res.openai.azure.com/openai/v1?api-version=v1'), 'https://res.openai.azure.com/openai/v1/responses?api-version=v1');
});

test('a rejected key and an in-stream error both become ProviderError', async () => {
  const denied = await startFakeServer((_req, res) => res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":{"message":"quota exhausted","type":"insufficient_quota"}}'));
  const broken = await startFakeServer((_req, res) => res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'par' }, { type: 'error', message: 'deployment missing' })));
  const make = (url: string): ModelInfo => ({ provider: 'azure', id: 'm', name: 'm', api: 'azure-openai-responses', baseUrl: `${url}/openai/v1`, contextWindow: 1, reasoning: false, input: ['text'] });
  try {
    await assert.rejects(
      new AzureOpenAIResponsesProvider(make(denied.url), 'k').chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      (e: unknown) => e instanceof ProviderError && e.status === 403 && e.code === 'insufficient_quota',
    );
    await assert.rejects(
      new AzureOpenAIResponsesProvider(make(broken.url), 'k').chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      (e: unknown) => e instanceof ProviderError && /deployment missing/.test(e.message) && e.partialContent === 'par',
    );
  } finally {
    await Promise.all([denied.close(), broken.close()]);
  }
});
