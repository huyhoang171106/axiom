import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIResponsesProvider } from '../src/llm/providers/openai-responses.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { ProviderError } from '../src/llm/provider-error.js';
import { startFakeServer } from './fake-server.js';

const info = (baseUrl: string, headers?: Record<string, string>): ModelInfo => ({
  provider: 'openai', id: 'gpt-5.5', name: 'GPT-5.5', api: 'openai-responses', baseUrl, contextWindow: 400000,
  maxTokens: 8192, reasoning: true, input: ['text'], cost: { input: 1, output: 8, cacheRead: 0.1 }, headers,
});

const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' as const, properties: { path: { type: 'string' } } } }];

/** `data:`-only SSE, one event per line — the shape both OpenAI and the Codex backend emit. */
const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

test('streams text, reasoning and usage, assembles the tool call and sends the Responses request', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(
      sse(
        { type: 'response.reasoning_summary_text.delta', delta: 'plan' },
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"path":"a.py"}' },
        { type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 300 } } } },
      ),
    );
  });
  try {
    const tokens: string[] = [];
    const thoughts: string[] = [];
    const r = await new OpenAIResponsesProvider(info(srv.url), 'key-1').chat({
      model: 'gpt-5.5',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'read a.py' }],
      tools,
      temperature: 0.3,
      maxTokens: 64,
      onToken: (t) => tokens.push(t),
      onThinking: (t) => thoughts.push(t),
    });
    assert.equal(r.content, 'Hello');
    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.deepEqual(thoughts, ['plan']);
    assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.py' } }]);
    assert.equal(r.usage.promptTokens, 1000);
    assert.equal(r.usage.cacheReadInputTokens, 300);
    assert.equal(r.usage.completionTokens, 200);
    assert.equal(r.usage.costEstimate, 0.00233); // (700*1 + 300*0.1 + 200*8) / 1e6
    assert.equal(r.usageMissing, false);

    const req = srv.seen[0];
    assert.equal(req.url, '/responses');
    assert.equal(req.headers.authorization, 'Bearer key-1');
    const sent = JSON.parse(req.body.toString());
    assert.equal(sent.model, 'gpt-5.5');
    assert.equal(sent.stream, true);
    assert.equal(sent.store, false);
    assert.equal(sent.max_output_tokens, 64);
    assert.equal(sent.temperature, 0.3);
    assert.equal(sent.tools[0].name, 'read_file');
    assert.deepEqual(sent.tools[0].parameters, tools[0].parameters);
    assert.deepEqual(sent.input[0], { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'sys' }] });
    assert.deepEqual(sent.input[1], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read a.py' }] });
  } finally {
    await srv.close();
  }
});

test('replays assistant tool calls and tool results as function_call items keyed by call_id', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 1 } } }));
  });
  try {
    await new OpenAIResponsesProvider(info(srv.url)).chat({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'read b.py' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't0', name: 'read_file', arguments: { path: 'b.py' } }] },
        { role: 'tool', content: 'print(1)', toolCallId: 't0', name: 'read_file' },
      ],
    });
    const sent = JSON.parse(srv.seen[0].body.toString());
    assert.deepEqual(sent.input[1], { type: 'function_call', call_id: 't0', name: 'read_file', arguments: '{"path":"b.py"}' });
    assert.deepEqual(sent.input[2], { type: 'function_call_output', call_id: 't0', output: 'print(1)' });
    // The empty assistant text produces no message item; only its function_call rides through.
    assert.equal(sent.input.length, 3);
  } finally {
    await srv.close();
  }
});

test('an HTTP error, an in-stream error and response.failed all become ProviderError', async () => {
  const srv = await startFakeServer((req, res) => {
    const model = JSON.parse(req.body.toString()).model;
    if (model === 'missing') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"model not found","type":"invalid_request_error"}}');
      return;
    }
    if (model === 'failed') {
      res.writeHead(200).end(sse(
        { type: 'response.output_text.delta', delta: 'par' },
        { type: 'response.failed', response: { error: { message: 'blocked by policy', code: 'content_filter' } } },
      ));
      return;
    }
    res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'par' }, { type: 'error', message: 'rate limited', code: 'rate_limit' }));
  });
  try {
    const call = (model: string) => new OpenAIResponsesProvider(info(srv.url)).chat({ model, messages: [{ role: 'user', content: 'x' }] });
    await assert.rejects(call('missing'), (e: unknown) => e instanceof ProviderError && e.status === 404 && /model not found/.test(e.message));
    await assert.rejects(call('stream'), (e: unknown) => e instanceof ProviderError && e.code === 'rate_limit' && e.partialContent === 'par');
    await assert.rejects(call('failed'), (e: unknown) => e instanceof ProviderError && e.code === 'content_filter' && /blocked by policy/.test(e.message) && e.partialContent === 'par');
  } finally {
    await srv.close();
  }
});

test('a stream cut before the terminal event is flagged as missing usage', async () => {
  const srv = await startFakeServer((_req, res) => res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'cut' })));
  try {
    const r = await new OpenAIResponsesProvider(info(srv.url)).chat({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.content, 'cut');
    assert.equal(r.usageMissing, true);
  } finally {
    await srv.close();
  }
});

test('a catalog authorization header wins over the stored credential', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }));
  });
  try {
    await new OpenAIResponsesProvider(info(srv.url, { authorization: 'Bearer gateway-token' }), 'key-1').chat({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(srv.seen[0].headers.authorization, 'Bearer gateway-token');
    await new OpenAIResponsesProvider(info(srv.url, { Authorization: 'Bearer gateway-token' }), 'key-1').chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(srv.seen[1].headers.authorization, 'Bearer gateway-token');
  } finally {
    await srv.close();
  }
});
