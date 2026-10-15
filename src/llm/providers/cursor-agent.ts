// src/llm/providers/cursor-agent.ts - `cursor-agent` wire: Cursor agent.v1 Run over HTTP/2 (Connect + protobuf)
//
// Cursor's server runs the agent loop and asks the client to execute tools over the same stream. Axiom keeps
// every tool call on its own policy path, so each Axiom tool is advertised as an MCP tool and every MCP exec
// is handed back: the server is told the client runs the call and the turn ends, the call returns from chat()
// as a ToolCall, AgentLoop runs it through executeTool/decide(), and the next chat() replays the history with
// the result. Cursor's native tools (shell, read, write, ...) and its server-side web, plan and mode queries are
// refused. History is rebuilt from `messages` on every call: root prompt JSON blobs and protobuf turn blobs the
// server reads back over KV. Field numbers follow agent.proto (public protocol facts read from oh-my-pi, MIT;
// no code copied). Not supported: images, discovered model routes and effort parameters, server checkpoints.

import crypto from 'node:crypto';
import http2 from 'node:http2';
import type { LLMProviderType, Message, ToolCall, ToolDefinition } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { ProviderError } from '../provider-error.js';
import {
  CONNECT_END_STREAM,
  ProtoWriter,
  connectFrame,
  decodeJsonValue,
  decodeProto,
  encodeJsonValue,
  protoMap,
  protoMessage,
  protoNumber,
  protoString,
  readConnectFrames,
  type JsonValue,
  type ProtoFields,
} from '../protobuf.js';
import { wireUsage } from '../wire-usage.js';

const RUN_PATH = '/agent.v1.AgentService/Run';
/** The service gates protocol features on the announced build; this is a released Cursor agent CLI. */
const CLIENT_VERSION = 'cli-2026.09.02-c22c1a3';
const PROVIDER_ID = 'axiom';
const HEARTBEAT_MS = 5_000;
/** A stream with no frame for this long is treated as dead, so a headless run cannot hang forever. */
const IDLE_TIMEOUT_MS = 120_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HANDOFF =
  'Axiom received this tool call and runs it itself. Do not call it again; end your turn now. The result arrives with the next request.';
const TOOLS_RULE =
  'Only the MCP tools of this client are available. Built-in tools (terminal, file read/write/edit, search, web) are disabled here; use the MCP tools instead.';

/** AgentClientMessage oneof fields. */
const CLIENT = { RUN: 1, EXEC: 2, KV: 3, EXEC_CONTROL: 5, INTERACTION: 6, HEARTBEAT: 7 } as const;
/** InteractionQuery field -> how to refuse it (InteractionResponse uses the same field numbers). */
const REFUSALS: Record<number, (reason: string) => ProtoWriter> = {
  2: (r) => rejected(2, r), // web search
  3: (r) => new ProtoWriter().message(1, rejected(3, r)), // ask question
  4: (r) => rejected(2, r), // switch mode
  5: (r) => rejected(2, r), // exa search
  6: (r) => rejected(2, r), // exa fetch
  7: (r) => new ProtoWriter().message(1, new ProtoWriter().message(2, new ProtoWriter().string(1, r))), // create plan
  9: (r) => rejected(2, r), // web fetch
};

function rejected(field: number, reason: string): ProtoWriter {
  return new ProtoWriter().message(field, new ProtoWriter().string(1, reason));
}

/** Cursor rejects tool-call ids outside `[A-Za-z0-9_-]` (ids minted by another provider can carry them). */
const wireId = (id: string | undefined) => (id ?? '').replace(/[^A-Za-z0-9_-]/g, '_');

export class CursorAgentProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;
  private readonly conversationId = crypto.randomUUID();
  /** Content-addressed blobs the server reads and writes over KV; they live as long as the conversation. */
  private readonly blobs = new Map<string, Uint8Array>();

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    if (!this.credential) {
      throw new ProviderError(`\`${this.name}\` chưa kết nối. Gõ \`/login ${this.name}\` hoặc đặt \`CURSOR_ACCESS_TOKEN\`.`, {
        provider: this.name,
        model: params.model,
        code: 'missing_credentials',
      });
    }
    return this.run(this.runRequest(params.model, params.messages), params);
  }

  private store(data: Uint8Array): Uint8Array {
    const id = crypto.createHash('sha256').update(data).digest();
    this.blobs.set(id.toString('hex'), data);
    return id;
  }

  private storeJson(value: unknown): Uint8Array {
    return this.store(new TextEncoder().encode(JSON.stringify(value)));
  }

  /** AgentClientMessage carrying the AgentRunRequest; the trailing user message rides in the action. */
  private runRequest(model: string, messages: Message[]): Uint8Array {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const history = messages.filter((m) => m.role !== 'system');
    const active = history.at(-1)?.role === 'user' ? history.at(-1) : undefined;
    const past = active ? history.slice(0, -1) : history;

    const state = new ProtoWriter(); // ConversationStateStructure
    for (const content of system.length > 0 ? system : ['You are a coding assistant.']) state.bytes(1, this.storeJson({ role: 'system', content }));
    for (const id of this.rootPrompt(past)) state.bytes(1, id);
    for (const id of this.turns(past)) state.bytes(8, id);

    // ConversationAction: user_message_action = 1 { user_message = 1 }, or resume_action = 2 after tool results.
    const action = active
      ? new ProtoWriter().message(1, new ProtoWriter().message(1, userMessage(active.content, crypto.randomUUID())))
      : new ProtoWriter().message(2, new ProtoWriter());
    const run = new ProtoWriter()
      .message(1, state)
      .message(2, action)
      .message(3, new ProtoWriter().string(1, model).string(3, model).string(4, this.info.name)) // ModelDetails
      .string(5, this.conversationId)
      .message(9, new ProtoWriter().string(1, model)); // RequestedModel
    return new ProtoWriter().message(CLIENT.RUN, run).finish();
  }

  /** `root_prompt_messages_json`: the server builds the model prompt from these (AI SDK message shapes). */
  private rootPrompt(past: Message[]): Uint8Array[] {
    const ids: Uint8Array[] = [];
    for (const m of past) {
      if (m.role === 'user' && m.content.trim()) ids.push(this.storeJson({ role: 'user', content: [{ type: 'text', text: m.content }] }));
      if (m.role === 'assistant') {
        const content = [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...(m.toolCalls ?? []).map((tc) => ({ type: 'tool-call', toolCallId: wireId(tc.id), toolName: tc.name, args: tc.arguments })),
        ];
        if (content.length > 0) ids.push(this.storeJson({ role: 'assistant', content }));
      }
      if (m.role === 'tool') {
        const toolCallId = wireId(m.toolCallId);
        const result = { type: 'tool-result', toolName: m.name, toolCallId, result: m.content, ...(m.isError && { isError: true }) };
        ids.push(this.storeJson({ role: 'tool', id: toolCallId, content: [result] }));
      }
    }
    return ids;
  }

  /** `turns`: one ConversationTurnStructure per user message, its steps as ConversationStep blobs. */
  private turns(past: Message[]): Uint8Array[] {
    const results = new Map(past.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m]));
    const turns: Uint8Array[] = [];
    let turn: { user: Uint8Array; steps: Uint8Array[] } | undefined;
    const flush = () => {
      if (!turn) return;
      const agentTurn = new ProtoWriter().bytes(1, turn.user);
      for (const step of turn.steps) agentTurn.bytes(2, step);
      turns.push(this.store(new ProtoWriter().message(1, agentTurn).finish()));
    };
    for (const [index, m] of past.entries()) {
      if (m.role === 'user') {
        flush();
        const id = crypto.createHash('sha256').update(`${this.conversationId}\0${index}`).digest('hex');
        turn = { user: this.store(userMessage(m.content, `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`).finish()), steps: [] };
      } else if (m.role === 'assistant' && turn) {
        if (m.content) turn.steps.push(this.store(new ProtoWriter().message(1, new ProtoWriter().string(1, m.content)).finish()));
        for (const tc of m.toolCalls ?? []) turn.steps.push(this.store(toolCallStep(tc, results.get(tc.id)).finish()));
      }
    }
    flush();
    return turns;
  }

  private run(request: Uint8Array, { model, tools, onToken, onThinking, signal }: ChatParams): Promise<ChatResult> {
    const base = new URL(this.info.baseUrl);
    let content = '';
    const toolCalls: ToolCall[] = [];
    let usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
    let streamedTokens = 0;
    let turnEnded = false;

    return new Promise<ChatResult>((resolve, reject) => {
      const session = http2.connect(base.origin);
      const stream = session.request({
        ':method': 'POST',
        ':path': `${base.pathname.replace(/\/+$/, '')}${RUN_PATH}`,
        'content-type': 'application/connect+proto',
        'connect-protocol-version': '1',
        te: 'trailers',
        authorization: `Bearer ${this.credential}`,
        'x-cursor-client-type': 'cli',
        'x-cursor-client-version': CLIENT_VERSION,
        'x-ghost-mode': 'true',
        'x-request-id': crypto.randomUUID(),
        ...this.info.headers,
      });
      const fail = (message: string, extra: { status?: number; code?: string } = {}) =>
        new ProviderError(`${this.name}: ${message}`, { provider: this.name, model, partialContent: content, ...extra });

      let settled = false;
      let idle: NodeJS.Timeout | undefined;
      const heartbeat = setInterval(() => send(CLIENT.HEARTBEAT, new ProtoWriter()), HEARTBEAT_MS);
      const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('Request was aborted'));
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        clearTimeout(idle);
        signal?.removeEventListener('abort', onAbort);
        stream.close();
        session.close();
        if (error) return reject(error);
        resolve({
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: wireUsage(this.info, usage ? Math.max(usage.input - usage.cacheRead - usage.cacheWrite, 0) : 0, usage?.output ?? streamedTokens, usage?.cacheRead ?? 0, usage?.cacheWrite ?? 0),
          usageMissing: !usage,
        });
      };
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => finish(fail(`no data from the server for ${IDLE_TIMEOUT_MS / 1000}s`)), IDLE_TIMEOUT_MS);
      };
      const send = (field: number, body: ProtoWriter) => {
        if (!stream.writableEnded && !stream.destroyed) stream.write(connectFrame(new ProtoWriter().message(field, body).finish()));
      };

      const handle = (msg: ProtoFields) => {
        const update = protoMessage(msg, 1); // interaction_update
        if (update) {
          const text = protoMessage(update, 1);
          if (text) {
            const delta = protoString(text, 1);
            content += delta;
            if (delta) onToken?.(delta);
          }
          const thinking = protoMessage(update, 4);
          if (thinking && protoString(thinking, 1)) onThinking?.(protoString(thinking, 1));
          const tokens = protoMessage(update, 8);
          if (tokens) streamedTokens += protoNumber(tokens, 1);
          const ended = protoMessage(update, 14);
          if (ended) {
            turnEnded = true;
            usage = { input: protoNumber(ended, 1), output: protoNumber(ended, 2), cacheRead: protoNumber(ended, 3), cacheWrite: protoNumber(ended, 4) };
          }
        }
        const exec = protoMessage(msg, 2);
        if (exec) this.answerExec(exec, tools ?? [], toolCalls, send);
        const kv = protoMessage(msg, 4);
        if (kv) this.answerKv(kv, send);
        const query = protoMessage(msg, 7);
        if (query) {
          const kind = [...query.keys()].find((field) => field !== 1);
          const refuse = kind === undefined ? undefined : REFUSALS[kind];
          // An unanswered query stalls the turn; one we cannot even refuse ends the call instead.
          if (!refuse) throw fail(`unsupported interaction query (field ${kind}) from the server`);
          send(CLIENT.INTERACTION, new ProtoWriter().uint(1, protoNumber(query, 1)).message(kind!, refuse('Not available in Axiom; continue with the MCP tools.')));
        }
      };

      let status = 0;
      let errorBody = '';
      let buffer: Buffer = Buffer.alloc(0);
      stream.on('response', (headers) => {
        status = Number(headers[':status']);
        touch();
      });
      stream.on('data', (chunk: Buffer) => {
        touch();
        if (status !== 200) {
          errorBody += chunk.toString('utf8');
          return;
        }
        try {
          const { frames, rest } = readConnectFrames(Buffer.concat([buffer, chunk]), MAX_FRAME_BYTES);
          buffer = rest;
          for (const frame of frames) {
            if (frame.flags & CONNECT_END_STREAM) {
              const error = endStreamError(frame.payload.toString('utf8'));
              if (error) {
                const fix = error.code === 'unauthenticated' ? ` Run /login ${this.name} again.` : '';
                return finish(fail(`API error (stream ${error.code || 'error'}): ${error.message}.${fix}`, { code: error.code }));
              }
              stream.end(); // The end frame is the server's last message; half-close so the stream can finish.
              continue;
            }
            handle(decodeProto(frame.payload));
          }
        } catch (err) {
          finish(err instanceof ProviderError ? err : fail((err as Error).message));
        }
      });
      stream.on('trailers', (trailers) => {
        const code = trailers['grpc-status'];
        if (code && code !== '0') finish(fail(`gRPC error ${code}: ${decodeURIComponent(String(trailers['grpc-message'] ?? ''))}`, { code: String(code) }));
      });
      stream.on('end', () => {
        if (status !== 200) return finish(fail(`API error (${status}): ${describeBody(errorBody)}`, { status }));
        if (!turnEnded) return finish(fail(`stream for model ${model} ended before the turn finished`));
        finish();
      });
      stream.on('error', (err) => finish(fail(err.message)));
      session.on('error', (err) => finish(fail(`cannot reach ${base.origin}: ${err.message}`)));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();

      stream.write(connectFrame(request));
      touch();
    });
  }

  /** ExecServerMessage: request context and MCP calls are answered; Cursor's native tools are refused. */
  private answerExec(exec: ProtoFields, tools: ToolDefinition[], toolCalls: ToolCall[], send: (field: number, body: ProtoWriter) => void): void {
    const id = protoNumber(exec, 1);
    const reply = (field: number, body: ProtoWriter) => send(CLIENT.EXEC, new ProtoWriter().uint(1, id).string(15, protoString(exec, 15)).message(field, body));

    if (exec.has(10)) {
      // RequestContextResult.success.request_context: rules = 2, tools = 7, web_search_enabled = 17.
      const context = new ProtoWriter().message(2, rule('/axiom/tools.mdc', TOOLS_RULE)).bool(17, false, true);
      for (const t of tools) {
        context.message(7, new ProtoWriter().string(1, t.name).string(2, t.description).message(3, encodeJsonValue(t.parameters)).string(4, PROVIDER_ID).string(5, t.name));
      }
      return reply(10, new ProtoWriter().message(1, new ProtoWriter().message(1, context)));
    }

    const args = protoMessage(exec, 11);
    if (args) {
      const name = protoString(args, 5) || protoString(args, 1);
      // An approval probe asks whether the call may run unasked; Axiom's policy only decides when it runs.
      if (protoNumber(args, 7)) return reply(11, rejected(3, `"${name}" must be approved by the user when it runs.`));
      const callId = protoString(args, 3) || `call_${crypto.randomUUID()}`;
      if (!toolCalls.some((tc) => tc.id === callId)) toolCalls.push({ id: callId, name, arguments: decodeArguments(protoMap(args, 2)) });
      const text = new ProtoWriter().message(1, new ProtoWriter().string(1, HANDOFF)); // McpToolResultContentItem.text
      return reply(11, new ProtoWriter().message(1, new ProtoWriter().message(1, text)));
    }

    // ExecClientControlMessage: throw = 2, then stream_close = 1. The server reports the error to the model.
    const kind = [...exec.keys()].find((field) => ![1, 15, 19, 55].includes(field));
    send(CLIENT.EXEC_CONTROL, new ProtoWriter().message(2, new ProtoWriter().uint(1, id).string(2, `Built-in tool (exec field ${kind}) is disabled in Axiom; use the MCP tools.`).string(4, 'unsupported_tool')));
    send(CLIENT.EXEC_CONTROL, new ProtoWriter().message(1, new ProtoWriter().uint(1, id)));
  }

  /** KvServerMessage: get_blob_args = 2 { blob_id }, set_blob_args = 3 { blob_id, blob_data }. */
  private answerKv(kv: ProtoFields, send: (field: number, body: ProtoWriter) => void): void {
    const id = protoNumber(kv, 1);
    const get = protoMessage(kv, 2);
    if (get) {
      const data = this.blobs.get(Buffer.from(blobId(get)).toString('hex'));
      const result = new ProtoWriter();
      if (data) result.bytes(1, data, true);
      send(CLIENT.KV, new ProtoWriter().uint(1, id).message(2, result));
    }
    const set = protoMessage(kv, 3);
    if (set) {
      const data = set.get(2)?.at(-1);
      this.blobs.set(Buffer.from(blobId(set)).toString('hex'), data instanceof Uint8Array ? Uint8Array.from(data) : new Uint8Array());
      send(CLIENT.KV, new ProtoWriter().uint(1, id).message(3, new ProtoWriter()));
    }
  }
}

function blobId(args: ProtoFields): Uint8Array {
  const value = args.get(1)?.at(-1);
  return value instanceof Uint8Array ? value : new Uint8Array();
}

function userMessage(text: string, messageId: string): ProtoWriter {
  return new ProtoWriter().string(1, text).string(2, messageId);
}

function rule(fullPath: string, content: string): ProtoWriter {
  // CursorRule: type = 3 { global = 1 {} }, source = 4 (2 = user).
  return new ProtoWriter().string(1, fullPath).string(2, content).message(3, new ProtoWriter().message(1, new ProtoWriter())).uint(4, 2);
}

/** ConversationStep.tool_call = 2: ToolCall { mcp_tool_call = 15 { args = 1, result = 2 }, tool_call_id = 57 }. */
function toolCallStep(tc: ToolCall, result: Message | undefined): ProtoWriter {
  const args = new ProtoWriter().string(1, tc.name).string(3, wireId(tc.id)).string(4, PROVIDER_ID).string(5, tc.name);
  for (const [key, value] of Object.entries(tc.arguments)) args.message(2, new ProtoWriter().string(1, key, true).message(2, encodeJsonValue(value)));
  const call = new ProtoWriter().message(1, args);
  if (result) {
    // McpToolResult: success = 1 { content = 1 [ { text = 1 { text = 1 } } ] }, error = 2 { error = 1 }.
    call.message(2, result.isError
      ? new ProtoWriter().message(2, new ProtoWriter().string(1, result.content))
      : new ProtoWriter().message(1, new ProtoWriter().message(1, new ProtoWriter().message(1, new ProtoWriter().string(1, result.content)))));
  }
  return new ProtoWriter().message(2, new ProtoWriter().message(15, call).string(57, wireId(tc.id)));
}

/** MCP argument values are google.protobuf.Value bytes; anything else is kept as text. */
function decodeArguments(map: Map<string, Uint8Array>): Record<string, unknown> {
  const out: Record<string, JsonValue> = {};
  for (const [key, bytes] of map) {
    try {
      out[key] = decodeJsonValue(bytes);
    } catch {
      out[key] = new TextDecoder().decode(bytes);
    }
  }
  return out;
}

/** `{ "error": { "code", "message" } }` from the end-of-stream frame, or undefined when it ended cleanly. */
function endStreamError(text: string): { code: string; message: string } | undefined {
  try {
    const error = (JSON.parse(text || '{}') as { error?: { code?: unknown; message?: unknown } }).error;
    if (!error) return undefined;
    return { code: typeof error.code === 'string' ? error.code : '', message: typeof error.message === 'string' ? error.message : JSON.stringify(error) };
  } catch {
    return { code: '', message: `unreadable end-of-stream frame: ${text.slice(0, 200)}` };
  }
}

/** Connect puts `{ code, message }` JSON in a non-200 body; fall back to the raw text. */
function describeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; code?: unknown };
    if (typeof parsed.message === 'string') return typeof parsed.code === 'string' ? `${parsed.code}: ${parsed.message}` : parsed.message;
  } catch {
    // Not JSON (a proxy page): show the start of it.
  }
  return body.slice(0, 300) || '<empty body>';
}
