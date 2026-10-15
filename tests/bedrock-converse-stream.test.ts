import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { BedrockConverseStreamProvider, signV4 } from '../src/llm/providers/bedrock-converse-stream.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { ProviderError } from '../src/llm/provider-error.js';
import { startFakeServer } from './fake-server.js';

for (const name of Object.keys(process.env)) if (name.startsWith('AWS_')) delete process.env[name];
process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/axiom-test-credentials';

const MODEL = 'us.anthropic.claude-x-v1:0';
const info = (baseUrl: string): ModelInfo => ({
  provider: 'amazon-bedrock', id: MODEL, name: 'Claude', api: 'bedrock-converse-stream', baseUrl, contextWindow: 200000,
  reasoning: true, input: ['text'], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
});
// Public example credentials from the AWS SigV4 documentation, not a real key.
const KEYS = { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }; // gitleaks:allow

/** Encodes one application/vnd.amazon.eventstream message with string headers and real CRCs. */
function frame(headers: Record<string, string>, payload: unknown): Buffer {
  const head = Buffer.concat(
    Object.entries(headers).map(([k, v]) => {
      const name = Buffer.from(k);
      const value = Buffer.from(v);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(value.length);
      return Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), length, value]);
    }),
  );
  const body = Buffer.from(JSON.stringify(payload));
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(12 + head.length + body.length + 4, 0);
  prelude.writeUInt32BE(head.length, 4);
  const crc = (b: Buffer) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(zlib.crc32(b));
    return out;
  };
  const message = Buffer.concat([prelude, crc(prelude), head, body]);
  return Buffer.concat([message, crc(message)]);
}
const event = (type: string, payload: unknown) => frame({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }, payload);

const tools = [{ name: 'read_file', description: 'Read', parameters: { type: 'object' as const, properties: { path: { type: 'string' } } } }];

test('signV4 matches botocore for a Bedrock POST, with and without a session token', () => {
  const opts = {
    method: 'POST',
    url: 'https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-x-v1%3A0/converse-stream',
    headers: { 'content-type': 'application/json' },
    body: '{"messages":[]}',
    keys: { accessKeyId: KEYS.AWS_ACCESS_KEY_ID, secretAccessKey: KEYS.AWS_SECRET_ACCESS_KEY },
    region: 'us-west-2',
    service: 'bedrock',
    now: new Date('2026-10-28T13:26:48Z'),
  };
  // Reference values from botocore.auth.SigV4Auth for the same request and time.
  assert.equal(
    signV4(opts).authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261028/us-west-2/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=2aeb9e6e5b5076ee38a07c64d07f3dd2453bb87715d14094bb28cfe00d9c90e0', // gitleaks:allow
  );
  const withToken = signV4({ ...opts, keys: { ...opts.keys, sessionToken: 'SESSIONTOKEN' } });
  assert.equal(withToken['x-amz-security-token'], 'SESSIONTOKEN');
  assert.equal(withToken['x-amz-date'], '20261028T132648Z');
  assert.match(withToken.authorization, /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=493241399defb0ca309a864d04f57565b05f4e23b2dd497959acf44da12a708d$/); // gitleaks:allow
});

test('streams text, reasoning and a tool call; reports usage with cache and signs with SigV4', async () => {
  const stream = Buffer.concat([
    event('messageStart', { role: 'assistant' }),
    event('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { text: 'think' } } }),
    event('contentBlockDelta', { contentBlockIndex: 1, delta: { text: 'Let me ' }, p: 'abc' }),
    event('contentBlockDelta', { contentBlockIndex: 1, delta: { text: 'read it.' } }),
    event('contentBlockStop', { contentBlockIndex: 1 }),
    event('contentBlockStart', { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'tooluse_1', name: 'read_file' } } }),
    event('contentBlockDelta', { contentBlockIndex: 2, delta: { toolUse: { input: '{"path":' } } }),
    event('contentBlockDelta', { contentBlockIndex: 2, delta: { toolUse: { input: '"a.py"}' } } }),
    event('contentBlockStop', { contentBlockIndex: 2 }),
    event('messageStop', { stopReason: 'tool_use' }),
    event('metadata', { usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 2000, cacheWriteInputTokens: 0 }, metrics: { latencyMs: 5 } }),
  ]);
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    // Odd-sized chunks split frames, headers and payloads across reads.
    for (let i = 0; i < stream.length; i += 7) res.write(stream.subarray(i, i + 7));
    res.end();
  });
  try {
    const tokens: string[] = [];
    const thoughts: string[] = [];
    const r = await new BedrockConverseStreamProvider(info(srv.url), JSON.stringify(KEYS)).chat({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are Axiom.' },
        { role: 'user', content: 'fix it' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't0', name: 'read_file', arguments: { path: 'b.py' } }, { id: 't1', name: 'read_file', arguments: { path: 'c.py' } }] },
        { role: 'tool', content: 'B', toolCallId: 't0', name: 'read_file' },
        { role: 'tool', content: 'nope', toolCallId: 't1', name: 'read_file', isError: true },
      ],
      tools,
      maxTokens: 256,
      onToken: (t) => tokens.push(t),
      onThinking: (t) => thoughts.push(t),
    });
    assert.equal(r.content, 'Let me read it.');
    assert.deepEqual(tokens, ['Let me ', 'read it.']);
    assert.deepEqual(thoughts, ['think']);
    assert.deepEqual(r.toolCalls, [{ id: 'tooluse_1', name: 'read_file', arguments: { path: 'a.py' } }]);
    assert.equal(r.finishReason, undefined);
    assert.equal(r.usage.promptTokens, 3000);
    assert.equal(r.usage.cacheReadInputTokens, 2000);
    assert.equal(r.usage.completionTokens, 100);
    assert.equal(r.usage.costEstimate, 0.0051); // (1000*3 + 2000*0.3 + 100*15) / 1e6

    const req = srv.seen[0];
    assert.equal(req.url, '/model/us.anthropic.claude-x-v1%3A0/converse-stream');
    assert.match(String(req.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    const sent = JSON.parse(req.body.toString());
    assert.deepEqual(sent.system, [{ text: 'You are Axiom.' }]);
    assert.deepEqual(sent.inferenceConfig, { maxTokens: 256 });
    assert.equal(sent.toolConfig.tools[0].toolSpec.inputSchema.json.type, 'object');
    assert.deepEqual(sent.messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(sent.messages[1].content, [
      { toolUse: { toolUseId: 't0', name: 'read_file', input: { path: 'b.py' } } },
      { toolUse: { toolUseId: 't1', name: 'read_file', input: { path: 'c.py' } } },
    ]);
    assert.deepEqual(sent.messages[2].content, [
      { toolResult: { toolUseId: 't0', content: [{ text: 'B' }], status: 'success' } },
      { toolResult: { toolUseId: 't1', content: [{ text: 'nope' }], status: 'error' } },
    ]);
  } finally {
    await srv.close();
  }
});

test('a plain credential is sent as a bearer token; a stream exception becomes ProviderError', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200);
    res.end(Buffer.concat([
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'par' } }),
      frame({ ':message-type': 'exception', ':exception-type': 'throttlingException', ':content-type': 'application/json' }, { message: 'Too many requests' }),
    ]));
  });
  try {
    await assert.rejects(new BedrockConverseStreamProvider(info(srv.url), 'bedrock-api-key').chat({ model: MODEL, messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.code, 'throttlingException');
      assert.equal(e.partialContent, 'par');
      assert.match(e.message, /Too many requests/);
      return true;
    });
    assert.equal(srv.seen[0].headers.authorization, 'Bearer bedrock-api-key');
  } finally {
    await srv.close();
  }
});

test('HTTP errors keep the status; no credential anywhere tells the user how to connect', async () => {
  const srv = await startFakeServer((_req, res) => res.writeHead(403, { 'content-type': 'application/json' }).end('{"message":"The security token included in the request is invalid."}'));
  try {
    const provider = new BedrockConverseStreamProvider(info(srv.url), JSON.stringify(KEYS));
    await assert.rejects(provider.chat({ model: MODEL, messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof ProviderError && e.status === 403 && /security token/.test(e.message));
    await assert.rejects(new BedrockConverseStreamProvider(info(srv.url)).chat({ model: MODEL, messages: [{ role: 'user', content: 'x' }] }), /\/login amazon-bedrock/);
    assert.equal(srv.seen.length, 1);
  } finally {
    await srv.close();
  }
});

test('AWS_REGION moves the standard runtime host and the signing region', async () => {
  const realFetch = globalThis.fetch;
  let seenUrl = '';
  let seenAuth = '';
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenAuth = (init.headers as Record<string, string>).authorization;
    return new Response('{"message":"stop"}', { status: 400 });
  }) as typeof fetch;
  try {
    const provider = new BedrockConverseStreamProvider(info('https://bedrock-runtime.us-east-1.amazonaws.com'), JSON.stringify({ ...KEYS, AWS_REGION: 'eu-west-1' }));
    await assert.rejects(provider.chat({ model: MODEL, messages: [{ role: 'user', content: 'x' }] }), /400/);
    assert.equal(seenUrl, 'https://bedrock-runtime.eu-west-1.amazonaws.com/model/us.anthropic.claude-x-v1%3A0/converse-stream');
    assert.match(seenAuth, /\/eu-west-1\/bedrock\/aws4_request/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
