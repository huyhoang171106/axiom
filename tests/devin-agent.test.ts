import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { DevinAgentProvider } from '../src/llm/providers/devin-agent.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { ProviderError } from '../src/llm/provider-error.js';
import {
  CONNECT_COMPRESSED,
  CONNECT_END_STREAM,
  ProtoWriter,
  connectFrame,
  decodeProto,
  protoDouble,
  protoMessage,
  protoMessages,
  protoNumber,
  protoString,
  readConnectFrames,
} from '../src/llm/protobuf.js';
import { startFakeServer, type SeenRequest } from './fake-server.js';

const info = (baseUrl: string): ModelInfo => ({
  provider: 'devin', id: 'swe-1-6', name: 'SWE-1.6', api: 'devin-agent', baseUrl, contextWindow: 200000, maxTokens: 8192,
  reasoning: true, input: ['text'], cost: { input: 1, output: 4, cacheRead: 0.1 },
});

const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' as const, properties: { path: { type: 'string' } } } }];

/** GetChatMessageResponse frame: text (3), tool call deltas (6), stop reason (5), usage (7), thinking (9). */
function chunk(opts: { text?: string; thinking?: string; call?: [id: string, name: string, args: string]; stop?: number; usage?: number[] }, flags = 0) {
  const msg = new ProtoWriter().string(1, 'msg-1').string(3, opts.text).string(9, opts.thinking).uint(5, opts.stop ?? 0);
  if (opts.call) msg.message(6, new ProtoWriter().string(1, opts.call[0]).string(2, opts.call[1]).string(3, opts.call[2]));
  if (opts.usage) msg.message(7, new ProtoWriter().uint(2, opts.usage[0]).uint(3, opts.usage[1]).uint(4, opts.usage[2]).uint(5, opts.usage[3]));
  const body = msg.finish();
  return connectFrame(flags & CONNECT_COMPRESSED ? gzipSync(body) : body, flags);
}
const end = (trailer: unknown = {}) => connectFrame(Buffer.from(JSON.stringify(trailer)), CONNECT_END_STREAM);

/** Answers GetUserJwt with `jwt-1` and GetChatMessage with `stream`. */
async function fakeDevin(stream: Uint8Array[]) {
  return startFakeServer((req: SeenRequest, res) => {
    if (req.url === '/exa.auth_pb.AuthService/GetUserJwt') {
      res.writeHead(200, { 'content-type': 'application/proto' }).end(new ProtoWriter().string(1, 'jwt-1').finish());
      return;
    }
    res.writeHead(200, { 'content-type': 'application/connect+proto' });
    const all = Buffer.concat(stream);
    for (let i = 0; i < all.length; i += 11) res.write(all.subarray(i, i + 11));
    res.end();
  });
}

test('authenticates, streams text and thinking, assembles a split tool call and reports usage', async () => {
  const srv = await fakeDevin([
    chunk({ thinking: 'plan' }),
    chunk({ text: 'Reading ' }),
    chunk({ text: 'the file.' }, CONNECT_COMPRESSED),
    chunk({ call: ['call_1', 'read_file', '{"path":'] }),
    chunk({ call: ['', '', '"a.py"}'] }),
    chunk({ stop: 10, usage: [1000, 200, 0, 3000] }),
    end(),
  ]);
  try {
    const tokens: string[] = [];
    const thoughts: string[] = [];
    const r = await new DevinAgentProvider(info(srv.url), 'sk-ws-test').chat({
      model: 'swe-1-6',
      messages: [
        { role: 'system', content: 'You are Axiom.' },
        { role: 'user', content: 'fix it' },
        { role: 'assistant', content: 'ok', toolCalls: [{ id: 't0', name: 'read_file', arguments: { path: 'b.py' } }] },
        { role: 'tool', content: 'boom', toolCallId: 't0', name: 'read_file', isError: true },
      ],
      tools,
      onToken: (t) => tokens.push(t),
      onThinking: (t) => thoughts.push(t),
    });
    assert.equal(r.content, 'Reading the file.');
    assert.deepEqual(tokens, ['Reading ', 'the file.']);
    assert.deepEqual(thoughts, ['plan']);
    assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.py' } }]);
    assert.equal(r.usage.promptTokens, 4000);
    assert.equal(r.usage.cacheReadInputTokens, 3000);
    assert.equal(r.usage.completionTokens, 200);
    assert.equal(r.usage.costEstimate, 0.0021); // (1000*1 + 3000*0.1 + 200*4) / 1e6
    assert.equal(r.usageMissing, false);

    const [auth, chat] = srv.seen;
    assert.equal(auth.headers['content-type'], 'application/proto');
    assert.equal(protoString(protoMessage(decodeProto(auth.body), 1)!, 3), 'sk-ws-test');

    assert.equal(chat.url, '/exa.api_server_pb.ApiServerService/GetChatMessage');
    assert.equal(chat.headers['content-type'], 'application/connect+proto');
    const { frames } = readConnectFrames(chat.body, 1 << 24);
    const req = decodeProto(frames[0].payload);
    const meta = protoMessage(req, 1)!;
    assert.equal(protoString(meta, 3), 'sk-ws-test');
    assert.equal(protoString(meta, 21), 'jwt-1');
    assert.equal(protoString(meta, 1), 'devin-cli');
    assert.equal(protoString(req, 2), 'You are Axiom.');
    assert.equal(protoString(req, 21), 'swe-1-6');
    assert.equal(protoNumber(req, 7), 5);
    assert.equal(protoNumber(protoMessage(req, 8)!, 2), 8192);
    assert.equal(protoDouble(protoMessage(req, 8)!, 5), 1);
    const [tool] = protoMessages(req, 10);
    assert.equal(protoString(tool, 1), 'read_file');
    assert.deepEqual(JSON.parse(protoString(tool, 3)), tools[0].parameters);

    const prompts = protoMessages(req, 3);
    assert.deepEqual(prompts.map((p) => protoNumber(p, 2)), [1, 2, 4]); // USER, SYSTEM (assistant), TOOL
    assert.equal(protoString(prompts[0], 3), 'fix it');
    const [replayed] = protoMessages(prompts[1], 6);
    assert.deepEqual([protoString(replayed, 1), protoString(replayed, 2), protoString(replayed, 3)], ['t0', 'read_file', '{"path":"b.py"}']);
    assert.equal(protoString(prompts[2], 7), 't0');
    assert.equal(protoNumber(prompts[2], 9), 1);
  } finally {
    await srv.close();
  }
});

test('replays foreign tool-call ids in the shape Cascade accepts, skips empty turns and sends the CLI user agent', async () => {
  const srv = await fakeDevin([chunk({ text: 'hi', usage: [1, 1, 0, 0] }), end()]);
  const longId = `call_${'a'.repeat(32)}|fc.1`;
  try {
    await new DevinAgentProvider(info(srv.url), 'sk-ws-test').chat({
      model: 'swe-1-6',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'y' },
        { role: 'assistant', content: '', toolCalls: [{ id: longId, name: 'read_file', arguments: {} }] },
        { role: 'tool', content: 'r', toolCallId: longId, name: 'read_file' },
      ],
    });
    const chat = srv.seen[1];
    assert.match(String(chat.headers['user-agent']), /^connect-go\//);
    const prompts = protoMessages(decodeProto(readConnectFrames(chat.body, 1 << 24).frames[0].payload), 3);
    assert.deepEqual(prompts.map((p) => protoNumber(p, 2)), [1, 1, 2, 4]); // the empty assistant turn is gone
    const sentId = protoString(protoMessages(prompts[2], 6)[0], 1);
    assert.equal(sentId, `call_${'a'.repeat(32)}_fc`); // 40 chars, '|' and '.' replaced
    assert.equal(protoString(prompts[3], 7), sentId);
  } finally {
    await srv.close();
  }
});

test('a bare session JWT is sent with its prefix', async () => {
  const srv = await fakeDevin([chunk({ text: 'hi', usage: [1, 1, 0, 0] }), end()]);
  try {
    await new DevinAgentProvider(info(srv.url), 'aaa.bbb.ccc').chat({ model: 'swe-1-6', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(protoString(protoMessage(decodeProto(srv.seen[0].body), 1)!, 3), 'devin-session-token$aaa.bbb.ccc');
  } finally {
    await srv.close();
  }
});

test('an error trailer, a missing end frame and a rejected key all become ProviderError', async () => {
  const trailer = await fakeDevin([chunk({ text: 'par' }), end({ error: { code: 'resource_exhausted', message: 'quota used up' } })]);
  const cut = await fakeDevin([chunk({ text: 'cut' })]);
  const denied = await startFakeServer((_req, res) => res.writeHead(401, { 'content-type': 'application/json' }).end('{"code":"unauthenticated","message":"invalid api key"}'));
  try {
    const call = (url: string) => new DevinAgentProvider(info(url), 'sk-ws-test').chat({ model: 'swe-1-6', messages: [{ role: 'user', content: 'x' }] });
    await assert.rejects(call(trailer.url), (e: unknown) => e instanceof ProviderError && e.code === 'resource_exhausted' && e.partialContent === 'par' && /quota used up/.test(e.message));
    await assert.rejects(call(cut.url), (e: unknown) => e instanceof ProviderError && /without its end-of-stream frame/.test(e.message));
    await assert.rejects(call(denied.url), (e: unknown) => e instanceof ProviderError && e.status === 401 && /invalid api key/.test(e.message));
    await assert.rejects(new DevinAgentProvider(info(denied.url)).chat({ model: 'swe-1-6', messages: [{ role: 'user', content: 'x' }] }), /\/login devin/);
  } finally {
    await Promise.all([trailer.close(), cut.close(), denied.close()]);
  }
});

test('protobuf codec round-trips varints above 2^32, doubles and nested messages', () => {
  const bytes = new ProtoWriter().uint(1, 2n ** 40n).double(2, 0.95).message(3, new ProtoWriter().string(1, 'tiếng Việt')).finish();
  const fields = decodeProto(bytes);
  assert.equal(protoNumber(fields, 1), 2 ** 40);
  assert.equal(protoDouble(fields, 2), 0.95);
  assert.equal(protoString(protoMessage(fields, 3)!, 1), 'tiếng Việt');
  assert.throws(() => decodeProto(Uint8Array.from([0x0a, 0x05, 0x61])), /truncated/);
  assert.throws(() => readConnectFrames(Buffer.from([0, 0xff, 0xff, 0xff, 0xff]), 1024), /exceeds/);
});
