// src/llm/providers/devin-agent.ts - `devin-agent` wire: Codeium Cascade chat over Connect + protobuf (HTTP/1.1)
//
// Each call: GetUserJwt (unary) exchanges the key for a user JWT, then GetChatMessage streams the answer.
// Field numbers follow the exa.* protos (public facts, read from the oh-my-pi catalog, MIT). Router models
// that need AssignModel first are not supported; pick a concrete model such as the catalog default.

import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { LLMProviderType, Message, ToolCall } from '../../core/types.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { ProviderError, throwHttpError } from '../provider-error.js';
import {
  CONNECT_COMPRESSED,
  CONNECT_END_STREAM,
  ProtoWriter,
  connectFrame,
  decodeProto,
  protoMessage,
  protoMessages,
  protoNumber,
  protoString,
  readConnectFrames,
} from '../protobuf.js';
import { wireUsage } from '../wire-usage.js';

const AUTH_PATH = '/exa.auth_pb.AuthService/GetUserJwt';
const CHAT_PATH = '/exa.api_server_pb.ApiServerService/GetChatMessage';
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

// The backend gates behavior on the client identity; this is the released Devin CLI's.
const CLIENT = { ideName: 'devin-cli', ideType: 'chisel', version: '3000.11.205', extensionName: 'chisel' };
const SESSION_TOKEN_PREFIX = 'devin-session-token$';

const SOURCE = { USER: 1, SYSTEM: 2, TOOL: 4 } as const; // exa.chat_pb.ChatMessageSource
const REQUEST_TYPE_CASCADE = 5; // exa.chat_pb.ChatMessageRequestType
const PLANNER_MODE_DEFAULT = 1; // exa.chat_pb.ConversationalPlannerMode
const CACHE_EPHEMERAL = 1; // exa.chat_pb.CacheControlType
const STOP = { MAX_TOKENS: 3, CONTENT_FILTER: 11, ERROR: 13 } as const; // exa.codeium_common_pb.StopReason

export class DevinAgentProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;
  /** One Cascade thread per provider instance, so the server sees later calls as the same conversation. */
  private readonly cascadeId = crypto.randomUUID();

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  async chat({ model, messages, tools, temperature, maxTokens, onToken, onThinking, signal }: ChatParams): Promise<ChatResult> {
    if (!this.credential) {
      throw new ProviderError(`\`${this.name}\` chưa kết nối. Gõ \`/login ${this.name}\` hoặc đặt \`DEVIN_API_KEY\`.`, { provider: this.name, model, code: 'missing_credentials' });
    }
    const baseUrl = this.info.baseUrl.replace(/\/+$/, '');
    const auth = await this.fetchUserJwt(baseUrl, model, signal);

    const request = new ProtoWriter()
      .message(1, this.metadata(auth.userJwt))
      .string(2, messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'));
    messages.forEach((m, index) => m.role !== 'system' && request.message(3, this.prompt(m, index)));
    request
      .uint(7, REQUEST_TYPE_CASCADE)
      .message(8, new ProtoWriter().uint(1, 1).uint(2, maxTokens ?? this.info.maxTokens ?? 64000).uint(3, 400).double(5, temperature ?? 1).uint(7, 40).double(8, Math.fround(0.95)))
      .message(12, new ProtoWriter().string(1, 'auto'))
      .message(13, new ProtoWriter().uint(1, CACHE_EPHEMERAL))
      .string(16, this.cascadeId)
      .uint(20, PLANNER_MODE_DEFAULT)
      .string(21, model)
      .string(22, crypto.randomUUID());
    for (const t of tools ?? []) request.message(10, new ProtoWriter().string(1, t.name).string(2, t.description).string(3, JSON.stringify(t.parameters)));

    const response = await fetch(auth.baseUrl + CHAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/connect+proto', 'connect-protocol-version': '1', 'connect-accept-encoding': 'gzip', 'accept-encoding': 'identity', ...this.info.headers },
      body: connectFrame(request.finish()),
      signal,
    });
    if (!response.ok) await throwHttpError(response, this.name, model);
    if (!response.body) throw new ProviderError(`${this.name}: empty response body for model ${model}`, { provider: this.name, model });

    let content = '';
    const calls = new Map<string, { name: string; args: string }>();
    let activeCallId = '';
    let usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
    let stopReason = 0;
    let ended = false;

    let buffer: Buffer = Buffer.alloc(0);
    for await (const bytes of response.body) {
      let parsed: ReturnType<typeof readConnectFrames>;
      try {
        parsed = readConnectFrames(Buffer.concat([buffer, bytes as Uint8Array]), MAX_FRAME_BYTES);
      } catch (err) {
        throw new ProviderError(`${this.name}: ${(err as Error).message}`, { provider: this.name, model, partialContent: content });
      }
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        const payload = frame.flags & CONNECT_COMPRESSED ? gunzipSync(frame.payload) : frame.payload;
        if (frame.flags & CONNECT_END_STREAM) {
          ended = true;
          const error = trailerError(payload.toString('utf8'));
          if (error) throw new ProviderError(`${this.name} API error (stream ${error.code || 'error'}): ${error.message}`, { provider: this.name, model, code: error.code, partialContent: content });
          continue;
        }
        const msg = decodeProto(payload);
        const thinking = protoString(msg, 9);
        if (thinking) onThinking?.(thinking);
        const text = protoString(msg, 3);
        if (text) {
          content += text;
          onToken?.(text);
        }
        for (const tc of protoMessages(msg, 6)) {
          const id = protoString(tc, 1) || activeCallId;
          if (!id) continue;
          activeCallId = id;
          const call = calls.get(id) ?? { name: '', args: '' };
          call.name = protoString(tc, 2) || call.name;
          // Deltas carry either the whole argument text so far or only the new part.
          const args = protoString(tc, 3);
          call.args = args.startsWith(call.args) ? args : call.args + args;
          calls.set(id, call);
        }
        stopReason = protoNumber(msg, 5) || stopReason;
        const stats = protoMessage(msg, 7);
        if (stats) usage = { input: protoNumber(stats, 2), output: protoNumber(stats, 3), cacheWrite: protoNumber(stats, 4), cacheRead: protoNumber(stats, 5) };
      }
    }
    if (!ended) throw new ProviderError(`${this.name}: stream for model ${model} ended without its end-of-stream frame`, { provider: this.name, model, partialContent: content });

    const toolCalls: ToolCall[] = [...calls].map(([id, call]) => ({ id, name: call.name, arguments: parseArguments(call.args) }));
    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: wireUsage(this.info, usage?.input ?? 0, usage?.output ?? 0, usage?.cacheRead ?? 0, usage?.cacheWrite ?? 0),
      usageMissing: !usage,
      finishReason: stopReason === STOP.MAX_TOKENS ? 'length' : stopReason === STOP.CONTENT_FILTER ? 'content_filter' : stopReason === STOP.ERROR ? 'error' : undefined,
    };
  }

  /** Exchanges the key for a user JWT; the account may also name its own API server. */
  private async fetchUserJwt(baseUrl: string, model: string, signal?: AbortSignal): Promise<{ userJwt: string; baseUrl: string }> {
    const response = await fetch(baseUrl + AUTH_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/proto', 'connect-protocol-version': '1', ...this.info.headers },
      body: new ProtoWriter().message(1, this.metadata('')).finish(),
      signal,
    });
    if (!response.ok) await throwHttpError(response, this.name, model);
    let body = Buffer.from(await response.arrayBuffer());
    // Some edges gzip the unary body without saying so (magic bytes 1f 8b).
    if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body);
    const fields = decodeProto(body);
    const userJwt = protoString(fields, 1);
    if (!userJwt) throw new ProviderError(`${this.name} auth error: GetUserJwt returned no user JWT. Run /login ${this.name} again.`, { provider: this.name, model, code: 'auth' });
    return { userJwt, baseUrl: protoString(fields, 2).trim().replace(/\/+$/, '') || baseUrl };
  }

  private metadata(userJwt: string): ProtoWriter {
    const key = this.credential?.trim() ?? '';
    // A bare session JWT goes out with its prefix; API keys (`sk-ws-...`) go out as stored.
    const apiKey = !key.startsWith(SESSION_TOKEN_PREFIX) && key.split('.').length === 3 ? SESSION_TOKEN_PREFIX + key : key;
    const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
    return new ProtoWriter()
      .string(1, CLIENT.ideName)
      .string(2, CLIENT.version)
      .string(3, apiKey)
      .string(4, 'en')
      .string(5, os)
      .string(7, CLIENT.version)
      .string(12, CLIENT.extensionName)
      .string(21, userJwt)
      .string(28, CLIENT.ideType);
  }

  /** One history entry as a ChatMessagePrompt; ids are stable per position so replays thread the same way. */
  private prompt(m: Message, index: number): ProtoWriter {
    const hex = crypto.createHash('sha256').update(`${this.cascadeId}\0${index}\0${m.role}`).digest('hex');
    const messageId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    const prompt = new ProtoWriter().string(1, messageId);
    if (m.role === 'tool') return prompt.uint(2, SOURCE.TOOL).string(3, m.content).string(7, m.toolCallId).bool(9, m.isError);
    if (m.role === 'assistant') {
      prompt.uint(2, SOURCE.SYSTEM).string(3, m.content);
      for (const tc of m.toolCalls ?? []) prompt.message(6, new ProtoWriter().string(1, tc.id).string(2, tc.name).string(3, JSON.stringify(tc.arguments)));
      return prompt;
    }
    return prompt.uint(2, SOURCE.USER).string(3, m.content);
  }
}

/** `{ "error": { "code", "message" } }` from the end-of-stream frame, or undefined when the stream ended cleanly. */
function trailerError(text: string): { code: string; message: string } | undefined {
  try {
    const parsed = JSON.parse(text || '{}') as { error?: { code?: unknown; message?: unknown } };
    const error = parsed.error;
    if (!error) return undefined;
    return { code: typeof error.code === 'string' ? error.code : '', message: typeof error.message === 'string' ? error.message : JSON.stringify(error) };
  } catch {
    return { code: '', message: `unreadable end-of-stream frame: ${text.slice(0, 200)}` };
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw, __invalidJson: true };
  }
}
