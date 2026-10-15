// src/llm/providers/bedrock-converse-stream.ts - `bedrock-converse-stream` wire: Bedrock ConverseStream, SigV4 or bearer, AWS event stream
//
// Credential, first match wins:
//   1. `credential` JSON from `/login` fields: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN,
//      AWS_REGION), or AWS_BEARER_TOKEN_BEDROCK. A non-JSON `credential` is a bearer token.
//   2. Environment: AWS_BEARER_TOKEN_BEDROCK, then AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN).
//   3. Static keys of profile AWS_PROFILE (or `default`) in ~/.aws/credentials.
// The ECS / IRSA / EC2 metadata chain is not supported.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LLMProviderType, Message, ToolCall } from '../../core/types.js';
import { registerSecret } from '../../core/secrets.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { ProviderError, throwHttpError } from '../provider-error.js';
import { wireUsage } from '../wire-usage.js';

export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

type BedrockAuth = { bearer: string; region?: string } | { keys: AwsKeys; region?: string };

type ContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { toolResult: { toolUseId: string; content: { text: string }[]; status: 'success' | 'error' } };

/** Payload of one ConverseStream event; untrusted, so every field is optional. */
interface BedrockEvent {
  contentBlockIndex?: number;
  start?: { toolUse?: { toolUseId?: string; name?: string } };
  delta?: { text?: unknown; reasoningContent?: { text?: unknown }; toolUse?: { input?: unknown } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
  message?: string;
}

/** A corrupt length prefix must fail fast instead of buffering gigabytes. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const RUNTIME_HOST = /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/;

export class BedrockConverseStreamProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  async chat({ model, messages, tools, temperature, maxTokens, onToken, onThinking, signal }: ChatParams): Promise<ChatResult> {
    const auth = resolveAuth(this.credential);
    if (!auth) {
      throw new ProviderError(`\`${this.name}\` chưa kết nối. Gõ \`/login ${this.name}\` hoặc đặt \`AWS_BEARER_TOKEN_BEDROCK\`.`, {
        provider: this.name,
        model,
        code: 'missing_credentials',
      });
    }
    const base = new URL(this.info.baseUrl);
    const region = resolveBedrockRegion(model, auth.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION);
    // The catalog URL is a placeholder for AWS's own host; gateways and VPC endpoints are used as configured.
    if (RUNTIME_HOST.test(base.hostname)) base.hostname = `bedrock-runtime.${region}.amazonaws.com`;
    const url = `${base.origin}${base.pathname.replace(/\/+$/, '')}/model/${encodeURIComponent(model)}/converse-stream`;

    const system = messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
    const body = JSON.stringify({
      messages: toBedrockMessages(messages),
      ...(system.length > 0 && { system }),
      inferenceConfig: { maxTokens: maxTokens ?? this.info.maxTokens, ...(temperature !== undefined && { temperature }) },
      ...(tools?.length && {
        toolConfig: { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } } })) },
      }),
    });
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/vnd.amazon.eventstream', ...this.info.headers };
    if ('bearer' in auth) headers.authorization = `Bearer ${auth.bearer}`;
    else Object.assign(headers, signV4({ method: 'POST', url, headers, body, keys: auth.keys, region, service: 'bedrock' }));

    const response = await fetch(url, { method: 'POST', headers, body, signal });
    if (!response.ok) await throwHttpError(response, this.name, model);
    if (!response.body) throw new ProviderError(`${this.name}: empty response body for model ${model}`, { provider: this.name, model });

    let content = '';
    const finished: { id: string; name: string; input: string }[] = [];
    const blocks = new Map<number | undefined, { id: string; name: string; input: string }>();
    let usage: BedrockEvent['usage'];
    let stopReason: string | undefined;

    const handle = (frame: EventFrame) => {
      const type = frame.headers[':message-type'];
      if (type === 'exception' || type === 'error') {
        const code = frame.headers[':exception-type'] ?? frame.headers[':error-code'];
        const detail = frame.headers[':error-message'] ?? parsePayload(frame.payload)?.message ?? '';
        throw new ProviderError(`${this.name} API error (stream ${code ?? 'error'}): ${detail}`, { provider: this.name, model, code, partialContent: content });
      }
      const event = parsePayload(frame.payload);
      if (!event) return;
      switch (frame.headers[':event-type']) {
        case 'contentBlockStart': {
          const start = event.start?.toolUse;
          if (start) blocks.set(event.contentBlockIndex, { id: start.toolUseId ?? '', name: start.name ?? '', input: '' });
          break;
        }
        case 'contentBlockDelta': {
          const delta = event.delta ?? {};
          if (typeof delta.text === 'string') {
            content += delta.text;
            onToken?.(delta.text);
          }
          if (typeof delta.reasoningContent?.text === 'string') onThinking?.(delta.reasoningContent.text);
          const block = blocks.get(event.contentBlockIndex);
          if (block && typeof delta.toolUse?.input === 'string') block.input += delta.toolUse.input;
          break;
        }
        case 'contentBlockStop': {
          const block = blocks.get(event.contentBlockIndex);
          if (block) finished.push(block);
          blocks.delete(event.contentBlockIndex);
          break;
        }
        case 'messageStop':
          stopReason = event.stopReason;
          break;
        case 'metadata':
          usage = event.usage;
          break;
      }
    };

    let buffer = Buffer.alloc(0);
    for await (const bytes of response.body) {
      buffer = Buffer.concat([buffer, bytes as Uint8Array]);
      for (;;) {
        const frame = readFrame(buffer, this.name, model);
        if (!frame) break;
        buffer = buffer.subarray(frame.size);
        handle(frame);
      }
    }
    if (buffer.length > 0) throw new ProviderError(`${this.name}: stream ended inside an event for model ${model}`, { provider: this.name, model, partialContent: content });

    const toolCalls: ToolCall[] = finished.map((t) => ({ id: t.id, name: t.name, arguments: parseArguments(t.input) }));
    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: wireUsage(this.info, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, usage?.cacheReadInputTokens ?? 0, usage?.cacheWriteInputTokens ?? 0),
      usageMissing: !usage,
      finishReason: stopReason && !['end_turn', 'tool_use', 'stop_sequence'].includes(stopReason) ? stopReason : undefined,
    };
  }
}

/** Bedrock wants strictly alternating user/assistant turns; tool results ride in the next user turn. */
function toBedrockMessages(messages: Message[]): { role: 'user' | 'assistant'; content: ContentBlock[] }[] {
  const turns: { role: 'user' | 'assistant'; content: ContentBlock[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content: ContentBlock[] = [];
    if (m.role === 'tool') {
      content.push({ toolResult: { toolUseId: m.toolCallId ?? '', content: [{ text: m.content }], status: m.isError ? 'error' : 'success' } });
    } else {
      // Bedrock rejects blank text blocks, which an assistant turn with only tool calls would produce.
      if (m.content.trim()) content.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) content.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: tc.arguments } });
    }
    // An empty turn (an aborted reply) is rejected outright; dropping it lets its neighbours merge.
    if (content.length === 0) continue;
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...content);
    else turns.push({ role, content });
  }
  return turns;
}

/**
 * Cross-region inference profiles (`us.anthropic...`) are served only from regions of their geo; anywhere else
 * Bedrock answers "The provided model identifier is invalid". `global.` profiles work from any region.
 */
const PROFILE_GEOS: Record<string, { home: string; serves: (region: string) => boolean }> = {
  us: { home: 'us-east-1', serves: (r) => r.startsWith('us-') && !r.startsWith('us-gov-') },
  'us-gov': { home: 'us-gov-west-1', serves: (r) => r.startsWith('us-gov-') },
  eu: { home: 'eu-west-1', serves: (r) => r.startsWith('eu-') },
  apac: { home: 'ap-southeast-1', serves: (r) => r.startsWith('ap-') },
  au: { home: 'ap-southeast-2', serves: (r) => r === 'ap-southeast-2' || r === 'ap-southeast-4' },
  jp: { home: 'ap-northeast-1', serves: (r) => r === 'ap-northeast-1' || r === 'ap-northeast-3' },
};

/** Region for one call: an ARN names its own; a geo profile keeps the user's region only when that region serves it. */
export function resolveBedrockRegion(modelId: string, userRegion: string | undefined): string {
  const arn = modelId.split(':');
  if (arn[0] === 'arn' && arn[2] === 'bedrock' && arn[3]) return arn[3];
  const prefix = modelId.split('.')[0];
  if (Object.hasOwn(PROFILE_GEOS, prefix)) {
    const geo = PROFILE_GEOS[prefix];
    return userRegion && geo.serves(userRegion) ? userRegion : geo.home;
  }
  return userRegion || 'us-east-1';
}

function resolveAuth(credential: string | undefined): BedrockAuth | undefined {
  let auth: BedrockAuth | undefined;
  if (credential) {
    const fields = parseFields(credential);
    auth = fields ? authFromFields(fields) : { bearer: credential };
  } else {
    auth = authFromFields(process.env) ?? profileKeys();
  }
  if (auth && 'bearer' in auth) registerSecret(auth.bearer);
  if (auth && 'keys' in auth) [auth.keys.secretAccessKey, auth.keys.sessionToken].forEach((v) => v && registerSecret(v));
  return auth;
}

function authFromFields(fields: Record<string, string | undefined>): BedrockAuth | undefined {
  const region = fields.AWS_REGION || undefined;
  if (fields.AWS_BEARER_TOKEN_BEDROCK) return { bearer: fields.AWS_BEARER_TOKEN_BEDROCK, region };
  if (fields.AWS_ACCESS_KEY_ID && fields.AWS_SECRET_ACCESS_KEY) {
    const keys: AwsKeys = { accessKeyId: fields.AWS_ACCESS_KEY_ID, secretAccessKey: fields.AWS_SECRET_ACCESS_KEY, sessionToken: fields.AWS_SESSION_TOKEN || undefined };
    return { keys, region };
  }
  return undefined;
}

function parseFields(credential: string): Record<string, string> | undefined {
  try {
    const value: unknown = JSON.parse(credential);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'));
    }
  } catch {
    // Not JSON: the credential is a bearer token.
  }
  return undefined;
}

/** Static keys from the shared credentials file (INI). */
function profileKeys(): BedrockAuth | undefined {
  const file = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined; // No AWS CLI setup: not an error, just no credential from this source.
  }
  const wanted = process.env.AWS_PROFILE || 'default';
  const values: Record<string, string> = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) section = header[1].trim();
    else if (section === wanted && line.includes('=') && !line.startsWith('#') && !line.startsWith(';')) {
      const at = line.indexOf('=');
      values[line.slice(0, at).trim().toUpperCase()] = line.slice(at + 1).trim();
    }
  }
  return authFromFields(values);
}

const sha256 = (data: string) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();
const encodeRfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS Signature Version 4 headers for one request (`authorization`, `x-amz-date`, `x-amz-security-token`).
 * Every header in `headers` plus `host` is signed. Non-S3 services sign the already-encoded path encoded again.
 */
export function signV4(opts: { method: string; url: string; headers: Record<string, string>; body: string; keys: AwsKeys; region: string; service: string; now?: Date }): Record<string, string> {
  const url = new URL(opts.url);
  const amzDate = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const added: Record<string, string> = { 'x-amz-date': amzDate, ...(opts.keys.sessionToken && { 'x-amz-security-token': opts.keys.sessionToken }) };
  const signed = Object.entries({ ...opts.headers, ...added, host: url.host })
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const signedHeaders = signed.map(([k]) => k).join(';');
  const canonicalRequest = [
    opts.method,
    url.pathname.split('/').map(encodeRfc3986).join('/'),
    [...url.searchParams].map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).sort().join('&'),
    signed.map(([k, v]) => `${k}:${v}\n`).join(''),
    signedHeaders,
    sha256(opts.body),
  ].join('\n');
  const scope = `${amzDate.slice(0, 8)}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${opts.keys.secretAccessKey}`, amzDate.slice(0, 8));
  const signingKey = hmac(hmac(hmac(dateKey, opts.region), opts.service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return { ...added, authorization: `AWS4-HMAC-SHA256 Credential=${opts.keys.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

interface EventFrame {
  size: number;
  headers: Record<string, string>;
  payload: Buffer;
}

/**
 * One `application/vnd.amazon.eventstream` message, or undefined until the buffer holds a whole one.
 * Layout: total length (4) | headers length (4) | prelude CRC (4) | headers | payload | message CRC (4).
 * CRCs are not checked: TLS already guarantees integrity, and a damaged frame fails JSON parsing.
 */
function readFrame(buffer: Buffer, provider: string, model: string): EventFrame | undefined {
  if (buffer.length < 12) return undefined;
  const size = buffer.readUInt32BE(0);
  const headersLength = buffer.readUInt32BE(4);
  if (size < 16 + headersLength || size > MAX_FRAME_BYTES) {
    throw new ProviderError(`${provider}: invalid event stream frame (${size} bytes) for model ${model}`, { provider, model });
  }
  if (buffer.length < size) return undefined;
  const headers: Record<string, string> = {};
  let at = 12;
  const end = 12 + headersLength;
  while (at < end) {
    const name = buffer.toString('utf8', at + 1, at + 1 + buffer[at]);
    at += 1 + buffer[at];
    const type = buffer[at++];
    if (type === 6 || type === 7) {
      const length = buffer.readUInt16BE(at);
      if (type === 7) headers[name] = buffer.toString('utf8', at + 2, at + 2 + length);
      at += 2 + length;
    } else {
      // Fixed-size value types: bool true/false carry no bytes; byte, short, int, long, timestamp, uuid.
      at += ({ 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 } as Record<number, number>)[type] ?? 0;
    }
  }
  return { size, headers, payload: buffer.subarray(end, size - 4) };
}

function parsePayload(payload: Buffer): BedrockEvent | undefined {
  try {
    return payload.length > 0 ? (JSON.parse(payload.toString('utf8')) as BedrockEvent) : undefined;
  } catch {
    return undefined;
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
