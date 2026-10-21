// src/llm/providers/google-gemini-cli.ts - `google-gemini-cli` wire (Cloud Code Assist & Antigravity)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMProviderType } from '../../core/types.js';
import { axiomHome } from '../../core/paths.js';
import { registerSecret } from '../../core/secrets.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { ProviderError } from '../provider-error.js';
import { hasHeader } from './responses-shared.js';
import { buildGeminiRequest, requestGemini, trimBase } from './google-shared.js';

export interface CodeAssistCredential {
  token: string;
  projectId: string;
}

function readHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function projectFromAuthFile(provider: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(axiomHome(), 'auth.json'), 'utf8')) as Record<string, Record<string, unknown>>;
    const entry = raw?.[provider];
    if (!entry || typeof entry !== 'object') return undefined;
    for (const key of ['projectId', 'project', 'cloudaicompanionProject']) {
      if (typeof entry[key] === 'string' && entry[key]) return entry[key] as string;
    }
    const headers = entry.headers as Record<string, string> | undefined;
    return readHeader(headers, 'x-goog-user-project') ?? readHeader(headers, 'x-cloud-project');
  } catch {
    return undefined;
  }
}

/**
 * Extracts the OAuth access token and Cloud Code Assist project ID from the credential.
 * Accepts JSON (`{ token | access, projectId | project }`), `info.headers['x-goog-user-project']`,
 * or `projectId` stored alongside the OAuth record in `auth.json`.
 */
export function parseCodeAssistCredential(
  provider: string,
  model: string,
  credential: string | undefined,
  headers?: Record<string, string>,
): CodeAssistCredential {
  let token = credential?.trim() ?? '';
  let projectId = readHeader(headers, 'x-goog-user-project') ?? readHeader(headers, 'x-cloud-project') ?? '';

  if (token.startsWith('{')) {
    try {
      const parsed = JSON.parse(token) as Record<string, unknown>;
      const tok = parsed.token ?? parsed.access ?? parsed.access_token ?? parsed.key;
      const proj = parsed.projectId ?? parsed.project ?? parsed.cloudaicompanionProject;
      if (typeof tok === 'string') token = tok.trim();
      if (typeof proj === 'string' && proj.trim()) projectId = proj.trim();
    } catch {
      // Not valid JSON; treat as a raw bearer token below.
    }
  }

  if (!projectId) projectId = projectFromAuthFile(provider) ?? '';
  if (token) registerSecret(token);

  if (!token && !hasHeader(headers, 'authorization')) {
    throw new ProviderError(`${provider} is not connected. Run /login ${provider}.`, {
      provider,
      model,
      code: 'missing_credentials',
    });
  }
  if (!projectId) {
    throw new ProviderError(`${provider}: missing Cloud Code Assist project in credential. Run /login ${provider}.`, {
      provider,
      model,
      code: 'missing_credentials',
    });
  }
  return { token, projectId };
}

function resolveAntigravityWireModel(model: string, thinking?: string): string {
  const clean = model.replace(/^models\//, '');
  const tier = thinking === 'low' ? 'low' : thinking === 'high' ? 'high' : 'medium';
  const tierMap: Record<string, string> = {
    'gemini-3.8-flash': `gemini-3.8-flash-${tier}`,
    'gemini-4-argon': `gemini-4-argon-${tier}`,
    'claude-sonnet-5-5': `claude-sonnet-5-5-${tier}`,
    'claude-opus-5-5': `claude-opus-5-5-${tier}`,
    'claude-sonnet-4-5': `claude-sonnet-5-5-${tier}`,
    'claude-opus-4-5': `claude-opus-5-5-${tier}`,
    'claude-sonnet-4-6': `claude-sonnet-5-5-${tier}`,
    'claude-opus-4-6': `claude-opus-5-5-${tier}`,
  };
  return tierMap[clean] || clean;
}

export class GoogleGeminiCliProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
  ) {
    super();
    this.name = info.provider;
  }

  async chat({ model, messages, tools, temperature, maxTokens, onToken, onThinking, signal }: ChatParams): Promise<ChatResult> {
    const { token, projectId } = parseCodeAssistCredential(this.name, model, this.credential, this.info.headers);
    const request = buildGeminiRequest(this.info, { messages, tools, temperature, maxTokens });
    const isAntigravity = this.name === 'google-antigravity';
    const os = process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const antigravityUserAgent = isAntigravity
      ? `antigravity/hub/2.26.0 (aidev_client; os_type=${os}; arch=${arch}; cl=1005016104)`
      : undefined;

    const effectiveHeaders: Record<string, string> = { ...this.info.headers };
    if (isAntigravity) {
      for (const k of Object.keys(effectiveHeaders)) {
        if (/^x-(goog-user|cloud)-project$/i.test(k)) {
          delete effectiveHeaders[k];
        }
      }
    }

    const wireModel = isAntigravity
      ? resolveAntigravityWireModel(model, (this.info as unknown as { thinking?: string }).thinking)
      : model.replace(/^models\//, '');

    const body = isAntigravity
      ? {
          project: projectId,
          model: wireModel,
          requestId: `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/1`,
          userAgent: 'antigravity',
          requestType: 'agent',
          request,
        }
      : {
          project: projectId,
          model: wireModel,
          userPromptId: crypto.randomUUID(),
          request,
        };

    return requestGemini({
      provider: this.name,
      info: this.info,
      model,
      url: `${trimBase(this.info.baseUrl)}/v1internal:streamGenerateContent?alt=sse`,
      headers: {
        ...(antigravityUserAgent && { 'User-Agent': antigravityUserAgent }),
        ...effectiveHeaders,
        ...(token && !hasHeader(effectiveHeaders, 'authorization') && { authorization: `Bearer ${token}` }),
      },
      body,
      params: { onToken, onThinking, signal },
    });
  }
}
