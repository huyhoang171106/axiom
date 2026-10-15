import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { AgentLoop } from '../src/core/agent-loop.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { EventBus } from '../src/core/event-bus.js';
import { SessionManager } from '../src/core/session.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { CursorAgentProvider } from '../src/llm/providers/cursor-agent.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { ProviderError } from '../src/llm/provider-error.js';
import {
  CONNECT_END_STREAM,
  ProtoWriter,
  connectFrame,
  decodeJsonValue,
  decodeProto,
  encodeJsonValue,
  protoMap,
  protoMessage,
  protoMessages,
  protoNumber,
  protoString,
  readConnectFrames,
  type ProtoFields,
} from '../src/llm/protobuf.js';

const info = (baseUrl: string): ModelInfo => ({
  provider: 'cursor', id: 'claude-x-high', name: 'Claude X', api: 'cursor-agent', baseUrl, contextWindow: 200000,
  reasoning: true, input: ['text'], cost: { input: 5, output: 25, cacheRead: 0.5 },
});
const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] } }];

/** Server side of one Run stream: read the client's AgentClientMessages, write AgentServerMessages. */
interface Io {
  headers: http2.IncomingHttpHeaders;
  next(): Promise<ProtoFields>;
  send(field: number, body: ProtoWriter): void;
  end(trailer?: unknown): void;
  /** Requests a blob over KV and returns its bytes. */
  blob(id: Uint8Array): Promise<Uint8Array | undefined>;
}

async function fakeCursor(script: (io: Io) => Promise<void>) {
  const errors: unknown[] = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    const queue: ProtoFields[] = [];
    const waiters: ((m: ProtoFields) => void)[] = [];
    let buffer = Buffer.alloc(0);
    stream.on('data', (chunk: Buffer) => {
      const { frames, rest } = readConnectFrames(Buffer.concat([buffer, chunk]), 1 << 24);
      buffer = rest;
      for (const f of frames) {
        const msg = decodeProto(f.payload);
        if (msg.has(7)) continue; // client heartbeat
        const waiter = waiters.shift();
        if (waiter) waiter(msg);
        else queue.push(msg);
      }
    });
    stream.on('error', () => {});
    let kvId = 100;
    const io: Io = {
      headers,
      next: () => new Promise((resolve) => (queue.length ? resolve(queue.shift()!) : waiters.push(resolve))),
      send: (field, body) => stream.write(connectFrame(new ProtoWriter().message(field, body).finish())),
      end: (trailer = {}) => {
        stream.write(connectFrame(Buffer.from(JSON.stringify(trailer)), CONNECT_END_STREAM));
        stream.end();
      },
      async blob(id) {
        const kv = kvId++;
        io.send(4, new ProtoWriter().uint(1, kv).message(2, new ProtoWriter().bytes(1, id)));
        const reply = protoMessage(await io.next(), 3)!;
        assert.equal(protoNumber(reply, 1), kv);
        const data = protoMessage(reply, 2)!.get(1)?.at(-1);
        return data instanceof Uint8Array ? Uint8Array.from(data) : undefined;
      },
    };
    script(io).catch((err) => {
      errors.push(err);
      stream.close();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    errors,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const update = (field: number, body: ProtoWriter) => new ProtoWriter().message(field, body);
const textDelta = (text: string) => update(1, new ProtoWriter().string(1, text));
const turnEnded = (input: number, output: number, cacheRead: number) => update(14, new ProtoWriter().uint(1, input).uint(2, output).uint(3, cacheRead));
const exec = (id: number, field: number, body: ProtoWriter) => new ProtoWriter().uint(1, id).string(15, `exec-${id}`).message(field, body);
const json = (bytes: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(bytes));

test('a turn streams text, hands an MCP call back to the loop, refuses native tools and queries, reports usage', async () => {
  const seen: Record<string, unknown> = {};
  const srv = await fakeCursor(async (io) => {
    seen.headers = io.headers;
    const run = protoMessage(await io.next(), 1)!;
    seen.model = [protoString(protoMessage(run, 3)!, 1), protoString(protoMessage(run, 9)!, 1)];
    seen.userText = protoString(protoMessage(protoMessage(protoMessage(run, 2)!, 1)!, 1)!, 1);
    const state = protoMessage(run, 1)!;
    seen.root = await Promise.all((state.get(1) ?? []).map(async (id) => json(await io.blob(id as Uint8Array))));
    seen.turns = (state.get(8) ?? []).length;

    io.send(2, exec(1, 10, new ProtoWriter())); // request context
    const context = protoMessage(protoMessage(protoMessage(protoMessage(await io.next(), 2)!, 10)!, 1)!, 1)!;
    const [tool] = protoMessages(context, 7);
    seen.tool = { name: protoString(tool, 1), provider: protoString(tool, 4), schema: decodeJsonValue(tool.get(3)!.at(-1) as Uint8Array) };
    seen.webSearch = context.has(17) && protoNumber(context, 17) === 0;

    io.send(1, textDelta('Let me '));
    io.send(1, textDelta('read it.'));
    io.send(1, update(4, new ProtoWriter().string(1, 'thinking...')));
    const mcpArgs = new ProtoWriter().string(1, 'read_file').string(3, 'call_1').string(4, 'axiom').string(5, 'read_file')
      .message(2, new ProtoWriter().string(1, 'path').message(2, encodeJsonValue('a.py')));
    io.send(2, exec(2, 11, mcpArgs));
    const mcpReply = protoMessage(await io.next(), 2)!;
    seen.mcpReply = [protoNumber(mcpReply, 1), protoString(mcpReply, 15), protoString(protoMessage(protoMessage(protoMessage(protoMessage(mcpReply, 11)!, 1)!, 1)!, 1)!, 1)];

    io.send(2, exec(3, 7, new ProtoWriter().string(1, '.env'))); // native read
    const thrown = protoMessage(protoMessage(await io.next(), 5)!, 2)!;
    const closed = protoMessage(protoMessage(await io.next(), 5)!, 1)!;
    seen.native = [protoNumber(thrown, 1), protoString(thrown, 2), protoNumber(closed, 1)];

    io.send(7, new ProtoWriter().uint(1, 9).message(2, new ProtoWriter().string(1, 'axiom docs'))); // web search query
    const answer = protoMessage(await io.next(), 6)!;
    seen.query = [protoNumber(answer, 1), protoString(protoMessage(protoMessage(answer, 2)!, 2)!, 1)];

    io.send(1, turnEnded(5000, 300, 4000));
    io.end();
  });
  try {
    const tokens: string[] = [];
    const thoughts: string[] = [];
    const r = await new CursorAgentProvider(info(srv.url), 'cursor-token').chat({
      model: 'claude-x-high',
      messages: [{ role: 'system', content: 'You are Axiom.' }, { role: 'user', content: 'read a.py' }],
      tools,
      onToken: (t) => tokens.push(t),
      onThinking: (t) => thoughts.push(t),
    });
    assert.deepEqual(srv.errors, []);
    assert.equal(r.content, 'Let me read it.');
    assert.deepEqual(tokens, ['Let me ', 'read it.']);
    assert.deepEqual(thoughts, ['thinking...']);
    assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.py' } }]);
    assert.equal(r.usage.promptTokens, 5000);
    assert.equal(r.usage.cacheReadInputTokens, 4000);
    assert.equal(r.usage.costEstimate, 0.0145); // (1000*5 + 4000*0.5 + 300*25) / 1e6

    const headers = seen.headers as http2.IncomingHttpHeaders;
    assert.equal(headers[':path'], '/agent.v1.AgentService/Run');
    assert.equal(headers.authorization, 'Bearer cursor-token');
    assert.equal(headers['x-cursor-client-type'], 'cli');
    assert.deepEqual(seen.model, ['claude-x-high', 'claude-x-high']);
    assert.equal(seen.userText, 'read a.py');
    assert.deepEqual(seen.root, [{ role: 'system', content: 'You are Axiom.' }]);
    assert.equal(seen.turns, 0);
    assert.deepEqual(seen.tool, { name: 'read_file', provider: 'axiom', schema: tools[0].parameters });
    assert.equal(seen.webSearch, true);
    assert.deepEqual((seen.mcpReply as unknown[]).slice(0, 2), [2, 'exec-2']);
    assert.match((seen.mcpReply as string[])[2], /end your turn/);
    assert.deepEqual([(seen.native as unknown[])[0], (seen.native as unknown[])[2]], [3, 3]);
    assert.match((seen.native as string[])[1], /disabled in Axiom/);
    assert.equal((seen.query as unknown[])[0], 9);
    assert.match((seen.query as string[])[1], /Not available in Axiom/);
  } finally {
    await srv.close();
  }
});

test('after a tool result the next call resumes with the call and its result in the replayed history', async () => {
  const seen: Record<string, unknown> = {};
  const srv = await fakeCursor(async (io) => {
    const run = protoMessage(await io.next(), 1)!;
    seen.resume = protoMessage(run, 2)!.has(2);
    const state = protoMessage(run, 1)!;
    seen.root = await Promise.all((state.get(1) ?? []).map(async (id) => json(await io.blob(id as Uint8Array))));
    const [turnId] = state.get(8) ?? [];
    const turn = protoMessage(decodeProto((await io.blob(turnId as Uint8Array))!), 1)!;
    seen.turnUser = protoString(decodeProto((await io.blob(turn.get(1)!.at(-1) as Uint8Array))!), 1);
    const steps = await Promise.all((turn.get(2) ?? []).map(async (id) => decodeProto((await io.blob(id as Uint8Array))!)));
    const call = protoMessage(protoMessage(steps[1], 2)!, 15)!;
    const args = protoMessage(call, 1)!;
    seen.step = {
      text: protoString(protoMessage(steps[0], 1)!, 1),
      id: protoString(protoMessage(steps[1], 2)!, 57),
      tool: protoString(args, 5),
      path: decodeJsonValue(protoMap(args, 2).get('path')!),
      result: protoString(protoMessage(protoMessage(protoMessage(protoMessage(call, 2)!, 1)!, 1)!, 1)!, 1),
    };
    io.send(1, textDelta('a.py prints 1.'));
    io.send(1, turnEnded(100, 10, 0));
    io.end();
  });
  try {
    const r = await new CursorAgentProvider(info(srv.url), 'cursor-token').chat({
      model: 'claude-x-high',
      messages: [
        { role: 'system', content: 'You are Axiom.' },
        { role: 'user', content: 'read a.py' },
        { role: 'assistant', content: 'Let me read it.', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.py' } }] },
        { role: 'tool', content: 'print(1)', toolCallId: 'call_1', name: 'read_file' },
      ],
      tools,
    });
    assert.deepEqual(srv.errors, []);
    assert.equal(r.content, 'a.py prints 1.');
    assert.equal(r.toolCalls, undefined);
    assert.equal(seen.resume, true);
    assert.deepEqual(seen.root, [
      { role: 'system', content: 'You are Axiom.' },
      { role: 'user', content: [{ type: 'text', text: 'read a.py' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me read it.' }, { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', args: { path: 'a.py' } }] },
      { role: 'tool', id: 'call_1', content: [{ type: 'tool-result', toolName: 'read_file', toolCallId: 'call_1', result: 'print(1)' }] },
    ]);
    assert.equal(seen.turnUser, 'read a.py');
    assert.deepEqual(seen.step, { text: 'Let me read it.', id: 'call_1', tool: 'read_file', path: 'a.py', result: 'print(1)' });
  } finally {
    await srv.close();
  }
});

test('AgentLoop runs the handed-back call through its registry and finishes on the next turn', async () => {
  const resultsSeen: string[] = [];
  let runs = 0;
  const srv = await fakeCursor(async (io) => {
    const first = runs++ === 0;
    const state = protoMessage(protoMessage(await io.next(), 1)!, 1)!;
    const root = await Promise.all((state.get(1) ?? []).map(async (id) => json(await io.blob(id as Uint8Array))));
    for (const m of root) if (m.role === 'tool') resultsSeen.push(m.content[0].result);
    if (first) {
      const args = new ProtoWriter().string(3, 'call_7').string(5, 'read_file').message(2, new ProtoWriter().string(1, 'path').message(2, encodeJsonValue('a.txt')));
      io.send(2, exec(1, 11, args));
      await io.next();
    } else {
      io.send(1, textDelta('It says hello.'));
    }
    io.send(1, turnEnded(10, 2, 0));
    io.end();
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  try {
    const agent = new AgentLoop({
      config: { ...DEFAULT_CONFIG, workspaceRoot: root },
      provider: new CursorAgentProvider(info(srv.url), 't'),
      model: 'claude-x-high',
      costTracker: new CostTracker(),
      sessionManager: new SessionManager({ workspaceRoot: root, sessionsDir: path.join(root, '.s'), autoSave: false }),
      eventBus: new EventBus(),
    });
    const r = await agent.runTask('what does a.txt say?');
    assert.deepEqual(srv.errors, []);
    assert.equal(r.status, 'completed');
    assert.equal(runs, 2);
    assert.equal(resultsSeen.length, 1);
    assert.match(resultsSeen[0], /hello/);
    assert.equal(agent.transcript().at(-1)?.content, 'It says hello.');
  } finally {
    await srv.close();
  }
});

test('stream errors, a stream cut before turnEnded and a missing token become ProviderError', async () => {
  const failing = await fakeCursor(async (io) => {
    await io.next();
    io.send(1, textDelta('par'));
    io.end({ error: { code: 'resource_exhausted', message: 'usage limit reached' } });
  });
  const cut = await fakeCursor(async (io) => {
    await io.next();
    io.send(1, textDelta('cut'));
    io.end();
  });
  try {
    const call = (url: string, token?: string) => new CursorAgentProvider(info(url), token).chat({ model: 'claude-x-high', messages: [{ role: 'user', content: 'x' }] });
    await assert.rejects(call(failing.url, 't'), (e: unknown) => e instanceof ProviderError && e.code === 'resource_exhausted' && e.partialContent === 'par' && /usage limit/.test(e.message));
    await assert.rejects(call(cut.url, 't'), (e: unknown) => e instanceof ProviderError && /ended before the turn finished/.test(e.message));
    await assert.rejects(call(cut.url), /\/login cursor/);
  } finally {
    await Promise.all([failing.close(), cut.close()]);
  }
});

test('an abort closes the stream and rejects the call', async () => {
  const srv = await fakeCursor(async (io) => {
    await io.next();
    io.send(1, textDelta('slow'));
  });
  try {
    const controller = new AbortController();
    const pending = new CursorAgentProvider(info(srv.url), 't').chat({ model: 'claude-x-high', messages: [{ role: 'user', content: 'x' }], onToken: () => controller.abort(), signal: controller.signal });
    await assert.rejects(pending);
    assert.ok(controller.signal.aborted);
  } finally {
    await srv.close();
  }
});

test('google.protobuf.Value round-trips JSON, including zero, empty and false', () => {
  const value = { n: 0, s: '', b: false, nil: null, list: [1, 'two', { deep: [true] }], text: 'tiếng Việt' };
  assert.deepEqual(decodeJsonValue(encodeJsonValue(value).finish()), value);
});
