// src/llm/providers/google-vertex.ts - `google-vertex` wire (Google Vertex AI: ADC service account / authorized user, or API key)

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LLMProviderType } from '../../core/types.js';
import { registerSecret } from '../../core/secrets.js';
import type { ModelInfo } from '../catalog/index.js';
import { BaseLLMProvider, type ChatParams, type ChatResult } from '../base-provider.js';
import { ProviderError, throwHttpError } from '../provider-error.js';
import { hasHeader } from './responses-shared.js';
import { buildGeminiRequest, requestGemini, trimBase } from './google-shared.js';

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

interface AdcFile {
  type?: string;
  project_id?: string;
  quota_project_id?: string;
  client_email?: string;
  private_key?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  token_uri?: string;
}

interface VertexConfig {
  apiKey?: string;
  bearerToken?: string;
  credentialsFile?: string;
  adcInline?: AdcFile;
  project?: string;
  location: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

function defaultAdcPath(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') {
    const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'gcloud', 'application_default_credentials.json');
  }
  return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

function parseCredentialInput(credential: string | undefined, env: NodeJS.ProcessEnv): VertexConfig {
  let fields: Record<string, unknown> = {};
  let bare: string | undefined;
  if (credential?.trim()) {
    const trimmed = credential.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed;
      } catch {
        bare = trimmed;
      }
    } else {
      bare = trimmed;
    }
  }

  const str = (key: string): string | undefined => {
    const val = fields[key];
    return typeof val === 'string' && val.trim() ? val.trim() : undefined;
  };

  const adcInline: AdcFile | undefined =
    fields.type === 'service_account' || fields.type === 'authorized_user'
      ? (fields as unknown as AdcFile)
      : undefined;

  const apiKey = str('GOOGLE_CLOUD_API_KEY') ?? bare ?? env.GOOGLE_CLOUD_API_KEY;
  const bearerToken = str('accessToken') ?? str('access_token');
  const credentialsFile = str('GOOGLE_APPLICATION_CREDENTIALS') ?? env.GOOGLE_APPLICATION_CREDENTIALS;
  const project = str('GOOGLE_CLOUD_PROJECT') ?? str('project_id') ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT;
  const location = str('GOOGLE_CLOUD_LOCATION') ?? env.GOOGLE_CLOUD_LOCATION ?? env.CLOUD_ML_REGION ?? 'global';

  if (apiKey) registerSecret(apiKey);
  if (bearerToken) registerSecret(bearerToken);

  return { apiKey, bearerToken, credentialsFile, adcInline, project, location };
}

function loadAdcFile(explicitPath: string | undefined, env: NodeJS.ProcessEnv, provider: string, model: string): AdcFile | undefined {
  if (explicitPath) {
    let raw: string;
    try {
      raw = fs.readFileSync(explicitPath, 'utf8');
    } catch (error) {
      throw new ProviderError(`${provider}: cannot read GOOGLE_APPLICATION_CREDENTIALS file "${explicitPath}": ${(error as Error).message}`, {
        provider,
        model,
        code: 'missing_credentials',
      });
    }
    return parseAdcJson(raw, explicitPath, provider, model);
  }
  const fallback = defaultAdcPath(env);
  try {
    if (!fs.existsSync(fallback)) return undefined;
    return parseAdcJson(fs.readFileSync(fallback, 'utf8'), fallback, provider, model);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    return undefined;
  }
}

function parseAdcJson(raw: string, source: string, provider: string, model: string): AdcFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderError(`${provider}: ADC file "${source}" is not valid JSON`, { provider, model, code: 'invalid_credentials' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderError(`${provider}: ADC file "${source}" must be a JSON object`, { provider, model, code: 'invalid_credentials' });
  }
  const adc = parsed as AdcFile;
  if (adc.private_key) registerSecret(adc.private_key);
  if (adc.client_secret) registerSecret(adc.client_secret);
  if (adc.refresh_token) registerSecret(adc.refresh_token);
  return adc;
}

function signServiceAccountJwt(clientEmail: string, privateKey: string, tokenUri: string, nowSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: CLOUD_PLATFORM_SCOPE,
      aud: tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

async function exchangeAdcToken(adc: AdcFile, provider: string, model: string, signal?: AbortSignal): Promise<CachedToken> {
  const tokenUri = adc.token_uri || DEFAULT_TOKEN_URI;
  let body: URLSearchParams;

  if (adc.type === 'service_account' || (adc.client_email && adc.private_key)) {
    if (!adc.client_email || !adc.private_key) {
      throw new ProviderError(`${provider}: service_account ADC is missing client_email or private_key`, {
        provider,
        model,
        code: 'invalid_credentials',
      });
    }
    let assertion: string;
    try {
      assertion = signServiceAccountJwt(adc.client_email, adc.private_key, tokenUri, Math.floor(Date.now() / 1000));
    } catch (error) {
      throw new ProviderError(`${provider}: failed to sign service_account JWT: ${(error as Error).message}`, {
        provider,
        model,
        code: 'invalid_credentials',
      });
    }
    body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
  } else if (adc.type === 'authorized_user' || (adc.client_id && adc.client_secret && adc.refresh_token)) {
    if (!adc.client_id || !adc.client_secret || !adc.refresh_token) {
      throw new ProviderError(`${provider}: authorized_user ADC is missing client_id, client_secret or refresh_token`, {
        provider,
        model,
        code: 'invalid_credentials',
      });
    }
    body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: adc.client_id,
      client_secret: adc.client_secret,
      refresh_token: adc.refresh_token,
    });
  } else {
    throw new ProviderError(`${provider}: unsupported ADC credential type "${adc.type ?? 'unknown'}"`, {
      provider,
      model,
      code: 'invalid_credentials',
    });
  }

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  });
  if (!response.ok) await throwHttpError(response, provider, model);
  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new ProviderError(`${provider}: ADC token endpoint returned no access_token`, {
      provider,
      model,
      code: 'invalid_credentials',
    });
  }
  registerSecret(data.access_token);
  const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max(0, expiresIn - 60) * 1000,
  };
}

export function vertexStreamUrl(baseUrl: string, location: string, project: string | undefined, model: string): string {
  const resolvedBase = trimBase(
    baseUrl
      .replace('https://{location}-aiplatform.googleapis.com', location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`)
      .replace('{location}', location),
  );
  const cleanModel = encodeURIComponent(model.replace(/^models\//, ''));
  if (project) {
    return `${resolvedBase}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${cleanModel}:streamGenerateContent?alt=sse`;
  }
  return `${resolvedBase}/v1/publishers/google/models/${cleanModel}:streamGenerateContent?alt=sse`;
}

export class GoogleVertexProvider extends BaseLLMProvider {
  readonly name: LLMProviderType;
  private cachedToken?: CachedToken;

  constructor(
    private readonly info: ModelInfo,
    private readonly credential?: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    super();
    this.name = info.provider;
  }

  async chat({ model, messages, tools, temperature, maxTokens, onToken, onThinking, signal }: ChatParams): Promise<ChatResult> {
    const cfg = parseCredentialInput(this.credential, this.env);
    if (!/^[a-z0-9-]+$/.test(cfg.location)) {
      throw new ProviderError(`GOOGLE_CLOUD_LOCATION "${cfg.location}" is not a valid Vertex AI location (e.g. us-central1).`, {
        provider: this.name,
        model,
        code: 'invalid_credentials',
      });
    }

    const adc = cfg.adcInline ?? (!cfg.apiKey && !cfg.bearerToken ? loadAdcFile(cfg.credentialsFile, this.env, this.name, model) : undefined);
    const project = cfg.project ?? adc?.project_id ?? adc?.quota_project_id;
    const headers: Record<string, string> = { ...this.info.headers };

    if (cfg.apiKey && !hasHeader(headers, 'x-goog-api-key') && !hasHeader(headers, 'authorization')) {
      headers['x-goog-api-key'] = cfg.apiKey;
    } else if (cfg.bearerToken && !hasHeader(headers, 'authorization')) {
      headers.authorization = `Bearer ${cfg.bearerToken}`;
    } else if (adc && !hasHeader(headers, 'authorization')) {
      if (!this.cachedToken || Date.now() >= this.cachedToken.expiresAt) {
        this.cachedToken = await exchangeAdcToken(adc, this.name, model, signal);
      }
      headers.authorization = `Bearer ${this.cachedToken.accessToken}`;
      if (adc.quota_project_id && !hasHeader(headers, 'x-goog-user-project')) {
        headers['x-goog-user-project'] = adc.quota_project_id;
      }
    } else if (!hasHeader(headers, 'authorization') && !hasHeader(headers, 'x-goog-api-key')) {
      throw new ProviderError(
        `${this.name} is not connected. Run /login ${this.name} or set GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_CLOUD_API_KEY.`,
        { provider: this.name, model, code: 'missing_credentials' },
      );
    }

    if (!project && !cfg.apiKey) {
      throw new ProviderError(
        `${this.name}: missing Google Cloud project ID. Set GOOGLE_CLOUD_PROJECT or include project_id in ADC.`,
        { provider: this.name, model, code: 'missing_credentials' },
      );
    }

    return requestGemini({
      provider: this.name,
      info: this.info,
      model,
      url: vertexStreamUrl(this.info.baseUrl, cfg.location, project, model),
      headers,
      body: buildGeminiRequest(this.info, { messages, tools, temperature, maxTokens }),
      params: { onToken, onThinking, signal },
    });
  }
}
