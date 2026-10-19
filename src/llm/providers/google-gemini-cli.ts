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
    return requestGemini({
      provider: this.name,
      info: this.info,
      model,
      url: `${trimBase(this.info.baseUrl)}/v1internal:streamGenerateContent?alt=sse`,
      headers: {
        ...this.info.headers,
        ...(token && !hasHeader(this.info.headers, 'authorization') && { authorization: `Bearer ${token}` }),
      },
      body: {
        project: projectId,
        model: model.replace(/^models\//, ''),
        userPromptId: crypto.randomUUID(),
        request,
      },
      params: { onToken, onThinking, signal },
    });
  }
}
