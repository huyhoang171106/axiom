import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryDroidAgentProvider } from '../src/llm/providers/factory-droid-agent.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { ProviderError } from '../src/llm/provider-error.js';
import { startFakeServer } from './fake-server.js';

const info = (baseUrl: string, headers?: Record<string, string>): ModelInfo => ({
  provider: 'factory-droid', id: 'kimi-k3', name: 'Kimi K3', api: 'factory-droid-agent', baseUrl,
  contextWindow: 256000, maxTokens: 8192, reasoning: false, input: ['text'], cost: { input: 1, output: 4 }, headers,
});

const tools = [{ name: 'read_file', description: 'Read', parameters: { type: 'object' as const, properties: { path: { type: 'string' } } } }];

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const completed = { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 4 } } };

test('routes through the Factory Responses proxy with the CLI identity headers', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'ok' }, completed));
  });
  try {
    const r = await new FactoryDroidAgentProvider(info(srv.url, { 'x-api-provider': 'fireworks' }), 'workos-token').chat({
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.9,
      maxTokens: 128,
    });
    assert.equal(r.content, 'ok');
    const req = srv.seen[0];
    assert.equal(req.url, '/api/llm/o/v1/responses');
    assert.equal(req.headers.authorization, 'Bearer workos-token');
    assert.equal(req.headers['x-api-provider'], 'fireworks');
    assert.equal(req.headers['x-client-version'], '0.237.0');
    assert.equal(req.headers['x-factory-client'], 'cli');
    const sent = JSON.parse(req.body.toString());
    assert.equal(sent.max_output_tokens, 128);
    // The native CLI sends no temperature on this route; Axiom mirrors that.
    assert.equal('temperature' in sent, false);
  } finally {
    await srv.close();
  }
});

test('returns tool calls and replays them as function_call items', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200).end(sse(
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'read_file' } },
      { type: 'response.function_call_arguments.done', item_id: 'fc_9', arguments: '{"path":"a.py"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 5 } } },
    ));
  });
  try {
    const provider = new FactoryDroidAgentProvider(info(srv.url), 'workos-token');
    const first = await provider.chat({ model: 'kimi-k3', messages: [{ role: 'user', content: 'read a.py' }], tools });
    assert.deepEqual(first.toolCalls, [{ id: 'call_9', name: 'read_file', arguments: { path: 'a.py' } }]);

    await provider.chat({
      model: 'kimi-k3',
      messages: [
        { role: 'user', content: 'read a.py' },
        { role: 'assistant', content: '', toolCalls: first.toolCalls },
        { role: 'tool', content: 'print(1)', toolCallId: 'call_9', name: 'read_file' },
      ],
    });
    const replay = JSON.parse(srv.seen[1].body.toString()).input;
    assert.deepEqual(replay[1], { type: 'function_call', call_id: 'call_9', name: 'read_file', arguments: '{"path":"a.py"}' });
    assert.deepEqual(replay[2], { type: 'function_call_output', call_id: 'call_9', output: 'print(1)' });
  } finally {
    await srv.close();
  }
});

test('a revoked token and a broken stream both become ProviderError', async () => {
  const denied = await startFakeServer((_req, res) => res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"token expired"}}'));
  const broken = await startFakeServer((_req, res) => res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'par' }, { type: 'error', message: 'route unavailable' })));
  try {
    await assert.rejects(
      new FactoryDroidAgentProvider(info(denied.url), 't').chat({ model: 'kimi-k3', messages: [{ role: 'user', content: 'x' }] }),
      (e: unknown) => e instanceof ProviderError && e.status === 401 && /token expired/.test(e.message),
    );
    await assert.rejects(
      new FactoryDroidAgentProvider(info(broken.url), 't').chat({ model: 'kimi-k3', messages: [{ role: 'user', content: 'x' }] }),
      (e: unknown) => e instanceof ProviderError && /route unavailable/.test(e.message) && e.partialContent === 'par',
    );
  } finally {
    await Promise.all([denied.close(), broken.close()]);
  }
});
