import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { GitlabDuoAgentProvider } from '../src/llm/providers/gitlab-duo-agent.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { ProviderError } from '../src/llm/provider-error.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

interface SeenRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** One JSON payload per entry: a text frame, `{fragments}` split across continuation frames, `{ping}` or `{end}`. */
type ServerFrame = string | { fragments: string[] } | { ping: string } | { end: true };

interface FakeGitLab {
  url: string;
  seen: SeenRequest[];
  wsUrl?: string;
  wsHeaders?: http.IncomingHttpHeaders;
  clientMessages: string[];
  close(): Promise<void>;
}

function encodeLength(len: number): Buffer {
  if (len < 126) return Buffer.from([len]);
  if (len < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = 126;
    b.writeUInt16BE(len, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 127;
  b.writeBigUInt64BE(BigInt(len), 1);
  return b;
}

function encodeFrame(payload: Buffer, opcode: number, fin = true): Buffer {
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode]), encodeLength(payload.length), payload]);
}

/** Server→client text frames are unmasked (RFC 6455 §5.1). */
function encodeServerFrames(frame: ServerFrame): Buffer[] {
  if (typeof frame === 'string') return [encodeFrame(Buffer.from(frame, 'utf8'), 0x1)];
  if ('ping' in frame) return [encodeFrame(Buffer.from(frame.ping, 'utf8'), 0x9)];
  if ('end' in frame) return [];
  return frame.fragments.map((chunk, i) =>
    encodeFrame(Buffer.from(chunk, 'utf8'), i === 0 ? 0x1 : 0x0, i === frame.fragments.length - 1),
  );
}

/** Decodes the masked text frames the client sends (the wire only ever sends text). */
function decodeClientFrames(buffer: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let offset = 0;
  while (true) {
    if (buffer.length - offset < 2) break;
    const b1 = buffer[offset + 1]!;
    const opcode = buffer[offset]! & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let head = 2;
    if (len === 126) {
      if (buffer.length - offset < 4) break;
      len = buffer.readUInt16BE(offset + 2);
      head = 4;
    } else if (len === 127) {
      if (buffer.length - offset < 10) break;
      len = Number(buffer.readBigUInt64BE(offset + 2));
      head = 10;
    }
    let mask: Buffer | undefined;
    if (masked) {
      if (buffer.length - offset < head + 4) break;
      mask = buffer.subarray(offset + head, offset + head + 4);
      head += 4;
    }
    if (buffer.length - offset < head + len) break;
    let payload = buffer.subarray(offset + head, offset + head + len);
    if (mask) {
      const unmasked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) unmasked[i] = payload[i]! ^ mask[i % 4]!;
      payload = unmasked;
    }
    if (opcode === 0x1) messages.push(payload.toString('utf8'));
    offset += head + len;
  }
  return { messages, rest: buffer.subarray(offset) };
}

async function startFakeGitLab(options: {
  routes: (req: SeenRequest) => { status?: number; body: unknown } | undefined;
  onStarted?: (startRequest: Record<string, unknown>) => ServerFrame[];
}): Promise<FakeGitLab> {
  const seen: SeenRequest[] = [];
  const sockets = new Set<Socket>();
  const handle: FakeGitLab = {
    url: '',
    seen,
    clientMessages: [],
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const request: SeenRequest = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(request);
      const route = options.routes(request);
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      res.writeHead(route.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(route.body));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket: Socket) => {
    handle.wsUrl = req.url;
    handle.wsHeaders = req.headers;
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const decoded = decodeClientFrames(buffered);
      buffered = decoded.rest;
      for (const text of decoded.messages) {
        handle.clientMessages.push(text);
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (!parsed.startRequest || !options.onStarted) continue;
        for (const frame of options.onStarted(parsed.startRequest as Record<string, unknown>)) {
          if (typeof frame === 'object' && 'end' in frame) {
            setTimeout(() => socket.end(), 10);
            continue;
          }
          for (const bytes of encodeServerFrames(frame)) socket.write(bytes);
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  handle.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return handle;
}

const info = (baseUrl: string): ModelInfo => ({
  provider: 'gitlab-duo-agent', id: 'claude_sonnet_4_6_vertex', name: 'Claude Sonnet', api: 'gitlab-duo-agent',
  baseUrl, contextWindow: 200000, reasoning: false, input: ['text'], cost: { input: 0, output: 0 },
});

const tools = [{ name: 'read_file', description: 'Read', parameters: { type: 'object' as const, properties: { path: { type: 'string' } } } }];

const checkpoint = (log: unknown[]) => JSON.stringify({ channel_values: { ui_chat_log: log } });

/** The discovery/setup routes every happy-path test needs. */
const setupRoutes = (req: SeenRequest) => {
  if (req.url?.startsWith('/api/v4/groups?')) return { body: [{ id: 1, full_path: 'grp', duo_features_enabled: true }] };
  if (req.url?.startsWith('/api/v4/groups/1/projects')) return { body: [{ id: 7, path_with_namespace: 'grp/app' }] };
  if (req.url === '/api/v4/ai/duo_workflows/direct_access') return { body: { token: 'wf-token' } };
  if (req.url === '/api/v4/ai/duo_workflows/workflows') return { body: { id: 42 } };
  return undefined;
};

test('sets up the workflow and streams checkpoint text, reasoning and context usage', async () => {
  const srv = await startFakeGitLab({
    routes: setupRoutes,
    onStarted: () => [
      // A ping and a fragmented frame must not disturb the checkpoint diffing.
      { ping: 'keepalive' },
      JSON.stringify({
        agent_context_usage: { 'Chat Agent': { total_tokens: 1234, max_tokens: 200000 } },
        newCheckpoint: {
          checkpoint: checkpoint([
            { message_type: 'agent', message_id: 'm1', message_sub_type: 'reasoning', content: 'Think' },
            { message_type: 'agent', message_id: 'm2', content: 'Hel' },
          ]),
        },
      }),
      JSON.stringify({
        newCheckpoint: {
          checkpoint: checkpoint([
            { message_type: 'agent', message_id: 'm1', message_sub_type: 'reasoning', content: 'Think' },
            { message_type: 'agent', message_id: 'm2', content: 'Hello' },
          ]),
        },
      }),
      { fragments: ['{"status":"FIN', 'ISHED"}'] },
    ],
  });
  try {
    const tokens: string[] = [];
    const thoughts: string[] = [];
    const r = await new GitlabDuoAgentProvider(info(srv.url), 'pat-1').chat({
      model: 'claude_sonnet_4_6_vertex',
      messages: [{ role: 'system', content: 'You are Axiom.' }, { role: 'user', content: 'fix it' }],
      tools,
      onToken: (t) => tokens.push(t),
      onThinking: (t) => thoughts.push(t),
    });
    assert.equal(r.content, 'Hello');
    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.deepEqual(thoughts, ['Think']);
    assert.equal(r.toolCalls, undefined);
    assert.equal(r.usage.promptTokens, 1234);
    assert.equal(r.usage.completionTokens, 0);
    assert.equal(r.usageMissing, false);

    const direct = srv.seen.find((req) => req.url === '/api/v4/ai/duo_workflows/direct_access')!;
    assert.equal(direct.headers.authorization, 'Bearer pat-1');
    assert.deepEqual(JSON.parse(direct.body.toString()), {
      workflow_definition: 'ambient',
      root_namespace_id: 'gid://gitlab/Group/1',
      project_id: 'grp/app',
    });
    const create = JSON.parse(srv.seen.find((req) => req.url === '/api/v4/ai/duo_workflows/workflows')!.body.toString());
    assert.equal(create.project_id, 'grp/app');
    assert.equal(create.namespace_id, undefined);
    assert.equal(create.goal, '');
    assert.deepEqual(create.agent_privileges, [6]);

    const wsUrl = new URL(srv.wsUrl!, 'http://x');
    assert.equal(wsUrl.pathname, '/api/v4/ai/duo_workflows/ws');
    assert.equal(wsUrl.searchParams.get('project_id'), '7');
    assert.equal(wsUrl.searchParams.get('namespace_id'), '1');
    assert.equal(wsUrl.searchParams.get('root_namespace_id'), '1');
    assert.equal(wsUrl.searchParams.get('user_selected_model_identifier'), 'claude_sonnet_4_6_vertex');
    assert.equal(wsUrl.searchParams.get('workflow_definition'), 'ambient');
    assert.equal(srv.wsHeaders!.authorization, 'Bearer wf-token');
    assert.equal(srv.wsHeaders!['x-gitlab-client-type'], 'node-websocket');
    assert.equal(srv.wsHeaders!['x-gitlab-project-id'], '7');

    const start = JSON.parse(srv.clientMessages[0]!).startRequest;
    assert.equal(start.workflowID, '42');
    assert.equal(start.goal, 'fix it');
    assert.deepEqual(start.preapproved_tools, ['read_file']);
    assert.equal(start.mcpTools[0].name, 'read_file');
    assert.deepEqual(JSON.parse(start.mcpTools[0].inputSchema), tools[0].parameters);
    assert.equal(start.flowConfig.prompts[0].prompt_template.system, 'You are Axiom.');
    assert.equal(start.flowConfig.prompts[0].prompt_template.user, '{{goal}}');
    assert.equal(start.flowConfig.flow.entry_point, 'omp_agent');
  } finally {
    await srv.close();
  }
});

test('replays a multi-turn history as a ChatML goal and returns an action as a tool call', async () => {
  const srv = await startFakeGitLab({
    routes: setupRoutes,
    onStarted: () => [
      JSON.stringify({ action: { name: 'runMCPTool', requestID: 'req-1', args: { toolName: 'mcp__omp__read_file', args: '{"path":"b.py"}' } } }),
    ],
  });
  try {
    const provider = new GitlabDuoAgentProvider(info(srv.url), 'pat-1');
    const messages = [
      { role: 'system' as const, content: 'You are Axiom.' },
      { role: 'user' as const, content: 'read a.py' },
      { role: 'assistant' as const, content: 'ok', toolCalls: [{ id: 't0', name: 'read_file', arguments: { path: 'a.py' } }] },
      { role: 'tool' as const, content: 'print(1)', toolCallId: 't0', name: 'read_file' },
      { role: 'user' as const, content: 'now fix it' },
    ];
    const r = await provider.chat({ model: 'claude_sonnet_4_6_vertex', messages, tools });
    assert.equal(r.content, '');
    assert.deepEqual(r.toolCalls, [{ id: 'req-1', name: 'read_file', arguments: { path: 'b.py' } }]);
    assert.equal(r.usageMissing, true);

    const start = JSON.parse(srv.clientMessages[0]!).startRequest;
    assert.match(start.goal, /^<\|im_start\|>user\nread a\.py\n<\|im_end\|>/);
    assert.match(start.goal, /<\|im_start\|>assistant\nok\n<ran read_file>\{"path":"a\.py"\}<\/ran>\n<\|im_end\|>/);
    assert.match(start.goal, /<\|im_start\|>tool\n<ran:result>\nprint\(1\)\n<\|im_end\|>/);
    assert.match(start.flowConfig.prompts[0].prompt_template.system, /record of turns, tool calls and their results/);

    // The next call is a fresh workflow: the wire is stateless per call.
    await provider.chat({ model: 'claude_sonnet_4_6_vertex', messages, tools });
    assert.equal(srv.seen.filter((req) => req.url === '/api/v4/ai/duo_workflows/workflows').length, 2);
    assert.equal(srv.clientMessages.length, 2);
  } finally {
    await srv.close();
  }
});

test('a root-level run_mcp_tool action also maps to a tool call', async () => {
  const srv = await startFakeGitLab({
    routes: setupRoutes,
    onStarted: () => [JSON.stringify({ run_mcp_tool: { tool_name: 'read_file', arguments: { path: 'c.py' } }, requestID: 'req-2' })],
  });
  try {
    const r = await new GitlabDuoAgentProvider(info(srv.url), 'pat-1').chat({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools,
    });
    assert.deepEqual(r.toolCalls, [{ id: 'req-2', name: 'read_file', arguments: { path: 'c.py' } }]);
  } finally {
    await srv.close();
  }
});

test('contract failures become ProviderError: rejected token, FAILED, approval, no requestID, closed socket', async () => {
  const denied = await startFakeGitLab({
    routes: (req) => {
      if (req.url === '/api/v4/ai/duo_workflows/direct_access') return { status: 401, body: { message: 'Unauthorized' } };
      return { body: [{ id: 1 }] };
    },
  });
  const failed = await startFakeGitLab({ routes: setupRoutes, onStarted: () => [JSON.stringify({ status: 'FAILED', message: 'graph recursion limit' })] });
  const approval = await startFakeGitLab({ routes: setupRoutes, onStarted: () => [JSON.stringify({ status: 'TOOL_CALL_APPROVAL_REQUIRED' })] });
  const noId = await startFakeGitLab({ routes: setupRoutes, onStarted: () => [JSON.stringify({ action: { name: 'runMCPTool' } })] });
  const closed = await startFakeGitLab({ routes: setupRoutes, onStarted: () => [{ end: true }] });
  const call = (server: FakeGitLab, credential = 'pat-1') =>
    new GitlabDuoAgentProvider(info(server.url), credential).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
  try {
    await assert.rejects(call(denied), (e: unknown) => e instanceof ProviderError && e.status === 401 && /Unauthorized/.test(e.message));
    await assert.rejects(call(failed), (e: unknown) => e instanceof ProviderError && /graph recursion limit/.test(e.message));
    await assert.rejects(call(approval), (e: unknown) => e instanceof ProviderError && e.code === 'approval_required' && /approval/.test(e.message));
    await assert.rejects(call(noId), (e: unknown) => e instanceof ProviderError && e.code === 'protocol' && /requestID/.test(e.message));
    await assert.rejects(call(closed), (e: unknown) => e instanceof ProviderError && /closed before the workflow settled/.test(e.message));
    await assert.rejects(
      new GitlabDuoAgentProvider(info(closed.url)).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      /\/login gitlab-duo-agent/,
    );
  } finally {
    await Promise.all([denied, failed, approval, noId, closed].map((server) => server.close()));
  }
});

test('a service-endpoint direct_access response routes the socket to that host root', async () => {
  let srv!: FakeGitLab;
  srv = await startFakeGitLab({
    routes: (req) => {
      if (req.url?.startsWith('/api/v4/groups?')) return { body: [{ id: 1 }] };
      if (req.url?.startsWith('/api/v4/groups/1/projects')) return { body: [{ id: 7, path_with_namespace: 'grp/app' }] };
      if (req.url === '/api/v4/ai/duo_workflows/direct_access') {
        return {
          body: {
            // The service base URL carries its protocol (a protocol-less value would mean
            // https, which a plain-HTTP fake server cannot answer).
            duo_workflow_service: { token: 'svc-token', base_url: srv.url, headers: { 'x-svc': 'yes' } },
          },
        };
      }
      if (req.url === '/api/v4/ai/duo_workflows/workflows') return { body: { workflow_id: '88' } };
      return undefined;
    },
    onStarted: () => [JSON.stringify({ status: 'FINISHED' })],
  });
  try {
    const r = await new GitlabDuoAgentProvider(info(srv.url), 'pat-1').chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.content, '');
    const wsUrl = new URL(srv.wsUrl!, 'http://x');
    assert.equal(wsUrl.pathname, '/');
    assert.equal(wsUrl.searchParams.get('namespace_id'), null);
    assert.equal(wsUrl.searchParams.get('workflow_definition'), 'ambient');
    assert.equal(srv.wsHeaders!.authorization, 'Bearer svc-token');
    assert.equal(srv.wsHeaders!['x-svc'], 'yes');
    assert.equal(JSON.parse(srv.clientMessages[0]!).startRequest.workflowID, '88');
  } finally {
    await srv.close();
  }
});
