import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaChatProvider } from '../src/llm/providers/ollama-chat.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { ProviderError } from '../src/llm/provider-error.js';
import { startFakeServer } from './fake-server.js';

const info = (baseUrl: string): ModelInfo => ({
  provider: 'ollama-cloud', id: 'gpt-oss:120b', name: 'gpt-oss', api: 'ollama-chat', baseUrl, contextWindow: 131072,
  reasoning: true, input: ['text'], cost: { input: 1, output: 2 },
});

const ndjson = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n');

const tools = [{ name: 'read_file', description: 'Read', parameters: { type: 'object' as const, properties: { path: { type: 'string' } } } }];

test('streams text and thinking, reports usage and cost, sends the key as bearer', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    // Split mid-line to prove lines are reassembled across chunks.
    const body = ndjson(
      { message: { role: 'assistant', content: '', thinking: 'hmm' }, done: false },
      { message: { role: 'assistant', content: 'Hel' }, done: false },
      { message: { role: 'assistant', content: 'lo' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1000, eval_count: 500 },
    );
    res.write(body.slice(0, 50));
    res.end(body.slice(50));
  });
  try {
    const tokens: string[] = [];
    const thoughts: string[] = [];
    const r = await new OllamaChatProvider(info(srv.url), 'key-1').chat({
      model: 'gpt-oss:120b',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      tools,
      maxTokens: 64,
      onToken: (t) => tokens.push(t),
      onThinking: (t) => thoughts.push(t),
    });
    assert.equal(r.content, 'Hello');
    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.deepEqual(thoughts, ['hmm']);
    assert.equal(r.usage.promptTokens, 1000);
    assert.equal(r.usage.completionTokens, 500);
    assert.equal(r.usage.costEstimate, 0.002);
    assert.equal(r.usageMissing, false);

    const req = srv.seen[0];
    assert.equal(req.url, '/api/chat');
    assert.equal(req.headers.authorization, 'Bearer key-1');
    const sent = JSON.parse(req.body.toString());
    assert.equal(sent.stream, true);
    assert.equal(sent.options.num_predict, 64);
    assert.deepEqual(sent.messages[0], { role: 'system', content: 'sys' });
    assert.equal(sent.tools[0].function.name, 'read_file');
  } finally {
    await srv.close();
  }
});

test('returns tool calls with ids and replays tool results by tool name', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200);
    res.end(ndjson(
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.py' } } }] }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 },
    ));
  });
  try {
    const provider = new OllamaChatProvider(info(srv.url));
    const r = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'read a.py' }], tools });
    assert.equal(r.toolCalls?.length, 1);
    assert.equal(r.toolCalls![0].name, 'read_file');
    assert.deepEqual(r.toolCalls![0].arguments, { path: 'a.py' });
    assert.ok(r.toolCalls![0].id);
    assert.equal(srv.seen[0].headers.authorization, undefined);

    await provider.chat({
      model: 'm',
      messages: [
        { role: 'user', content: 'read a.py' },
        { role: 'assistant', content: '', toolCalls: r.toolCalls },
        { role: 'tool', content: 'print(1)', toolCallId: r.toolCalls![0].id, name: 'read_file' },
      ],
    });
    const replay = JSON.parse(srv.seen[1].body.toString()).messages;
    assert.deepEqual(replay[1].tool_calls, [{ function: { name: 'read_file', arguments: { path: 'a.py' } } }]);
    assert.deepEqual(replay[2], { role: 'tool', content: 'print(1)', tool_name: 'read_file' });
  } finally {
    await srv.close();
  }
});

test('an error line after 200 and an HTTP error both become ProviderError', async () => {
  const srv = await startFakeServer((req, res) => {
    if (JSON.parse(req.body.toString()).model === 'bad') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"model \\"bad\\" not found"}');
      return;
    }
    res.writeHead(200).end(ndjson({ message: { content: 'par' }, done: false }, { error: 'out of memory' }));
  });
  try {
    const provider = new OllamaChatProvider(info(srv.url));
    await assert.rejects(provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => {
      assert.ok(e instanceof ProviderError && /out of memory/.test(e.message) && e.partialContent === 'par');
      return true;
    });
    await assert.rejects(provider.chat({ model: 'bad', messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => {
      assert.ok(e instanceof ProviderError && e.status === 404 && /not found/.test(e.message));
      return true;
    });
  } finally {
    await srv.close();
  }
});

test('a stream cut before the done line is flagged as missing usage', async () => {
  const srv = await startFakeServer((_req, res) => res.writeHead(200).end(ndjson({ message: { content: 'cut' }, done: false })));
  try {
    const r = await new OllamaChatProvider(info(srv.url)).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.content, 'cut');
    assert.equal(r.usageMissing, true);
  } finally {
    await srv.close();
  }
});
