// tests/google-wires.test.ts - Fake-server tests for google-generative-ai, google-gemini-cli, and google-vertex (E6)

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { GoogleGenerativeAIProvider } from '../src/llm/providers/google-generative-ai.js';
import { GoogleGeminiCliProvider } from '../src/llm/providers/google-gemini-cli.js';
import { GoogleVertexProvider } from '../src/llm/providers/google-vertex.js';
import { ProviderError } from '../src/llm/provider-error.js';
import { startFakeServer } from './fake-server.js';

const sse = (...frames: unknown[]) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');

const tools = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
  },
];

const makeInfo = (api: ModelInfo['api'], provider: string, baseUrl: string): ModelInfo => ({
  provider,
  id: 'gemini-test-pro',
  name: 'Gemini Test Pro',
  api,
  baseUrl,
  contextWindow: 1048576,
  maxTokens: 8192,
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
});

test('google-generative-ai streams text, thinking, tool calls and usage with x-goog-api-key', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const payload = sse(
      { candidates: [{ content: { parts: [{ text: 'analyzing...', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
      {
        candidates: [
          {
            content: {
              parts: [
                { text: 'lo' },
                {
                  functionCall: { id: 'fc_1', name: 'read_file', args: { path: 'src/index.ts' } },
                  thoughtSignature: 'sig_abc',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 1000,
          cachedContentTokenCount: 200,
          candidatesTokenCount: 300,
          thoughtsTokenCount: 100,
        },
      },
    );
    // Split mid-frame to verify chunk reassembly across TCP packets.
    res.write(payload.slice(0, 80));
    res.end(payload.slice(80));
  });
  try {
    const tokens: string[] = [];
    const thoughts: string[] = [];
    const provider = new GoogleGenerativeAIProvider(makeInfo('google-generative-ai', 'google', srv.url), 'gem-key-1');
    const result = await provider.chat({
      model: 'gemini-test-pro',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Inspect index.ts' },
      ],
      tools,
      temperature: 0.2,
      maxTokens: 512,
      onToken: (t) => tokens.push(t),
      onThinking: (t) => thoughts.push(t),
    });

    assert.equal(result.content, 'Hello');
    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.deepEqual(thoughts, ['analyzing...']);
    assert.equal(result.toolCalls?.length, 1);
    assert.deepEqual(result.toolCalls![0], {
      id: 'fc_1',
      name: 'read_file',
      arguments: { path: 'src/index.ts' },
      thoughtSignature: 'sig_abc',
    });
    assert.equal(result.usage.promptTokens, 1000);
    assert.equal(result.usage.cacheReadInputTokens, 200);
    assert.equal(result.usage.completionTokens, 400);
    assert.equal(result.usageMissing, false);

    const req = srv.seen[0];
    assert.equal(req.url, '/models/gemini-test-pro:streamGenerateContent?alt=sse');
    assert.equal(req.headers['x-goog-api-key'], 'gem-key-1');
    const body = JSON.parse(req.body.toString('utf8'));
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Be concise.' }] });
    assert.equal(body.generationConfig.temperature, 0.2);
    assert.equal(body.generationConfig.maxOutputTokens, 512);
    assert.deepEqual(body.generationConfig.thinkingConfig, { includeThoughts: true });
    // JSON Schema keywords rejected by Gemini must be stripped.
    assert.equal(body.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
    assert.equal(body.tools[0].functionDeclarations[0].parameters.$schema, undefined);
  } finally {
    await srv.close();
  }
});

test('google-generative-ai rejects missing credentials and surfaces stream errors', async () => {
  const missing = new GoogleGenerativeAIProvider(makeInfo('google-generative-ai', 'google', 'http://127.0.0.1:1'));
  await assert.rejects(
    missing.chat({ model: 'gemini-test-pro', messages: [{ role: 'user', content: 'hi' }] }),
    (err: unknown) => err instanceof ProviderError && err.code === 'missing_credentials',
  );

  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }));
  });
  try {
    const provider = new GoogleGenerativeAIProvider(makeInfo('google-generative-ai', 'google', srv.url), 'k');
    await assert.rejects(
      provider.chat({ model: 'gemini-test-pro', messages: [{ role: 'user', content: 'hi' }] }),
      (err: unknown) => err instanceof ProviderError && err.status === 429 && err.retryable === true,
    );
  } finally {
    await srv.close();
  }
});

test('google-gemini-cli wraps request with Cloud Code Assist project from credential and unwraps response chunks', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      sse(
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'Patch ready.' },
                    { functionCall: { name: 'read_file', args: { path: 'a.ts' } } },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 50 },
          },
        },
      ),
    );
  });
  try {
    const credential = JSON.stringify({ token: 'ya29.oauth-token', projectId: 'cca-proj-42' });
    const provider = new GoogleGeminiCliProvider(
      makeInfo('google-gemini-cli', 'google-gemini-cli', srv.url),
      credential,
    );
    const result = await provider.chat({
      model: 'gemini-test-pro',
      messages: [
        { role: 'user', content: 'read a.ts' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'fc_prev', name: 'read_file', arguments: { path: 'a.ts' }, thoughtSignature: 'sig_1' }],
        },
        { role: 'tool', toolCallId: 'fc_prev', name: 'read_file', content: 'export const x = 1;' },
      ],
      tools,
    });

    assert.equal(result.content, 'Patch ready.');
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls![0].name, 'read_file');
    assert.deepEqual(result.toolCalls![0].arguments, { path: 'a.ts' });
    assert.equal(result.usage.promptTokens, 500);
    assert.equal(result.usage.completionTokens, 50);

    const req = srv.seen[0];
    assert.equal(req.url, '/v1internal:streamGenerateContent?alt=sse');
    assert.equal(req.headers.authorization, 'Bearer ya29.oauth-token');
    const sent = JSON.parse(req.body.toString('utf8'));
    assert.equal(sent.project, 'cca-proj-42');
    assert.equal(sent.model, 'gemini-test-pro');
    assert.equal(typeof sent.userPromptId, 'string');
    assert.equal(sent.request.contents.length, 3);
    assert.equal(sent.request.contents[1].parts[0].thoughtSignature, 'sig_1');
    assert.deepEqual(sent.request.contents[2].parts[0].functionResponse, {
      id: 'fc_prev',
      name: 'read_file',
      response: { output: 'export const x = 1;' },
    });
  } finally {
    await srv.close();
  }
});

test('google-gemini-cli rejects credential without project', async () => {
  const provider = new GoogleGeminiCliProvider(
    makeInfo('google-gemini-cli', 'google-gemini-cli', 'http://127.0.0.1:1'),
    'ya29.token-without-project',
  );
  await assert.rejects(
    provider.chat({ model: 'gemini-test-pro', messages: [{ role: 'user', content: 'hi' }] }),
    (err: unknown) => err instanceof ProviderError && err.code === 'missing_credentials' && /project/i.test(err.message),
  );
});

test('google-antigravity formats wire body, resolves tier model and strips x-goog-user-project header', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      sse({
        response: {
          candidates: [{ content: { parts: [{ text: 'Antigravity online.' }] } }],
          finishReason: 'STOP',
        },
      }),
    );
  });
  try {
    const credential = JSON.stringify({ token: 'ya29.ag-token', projectId: 'aicode-consumers' });
    const info = {
      ...makeInfo('google-gemini-cli', 'google-antigravity', srv.url),
      headers: { 'x-goog-user-project': 'aicode-consumers' },
    };
    const provider = new GoogleGeminiCliProvider(info, credential);
    const result = await provider.chat({
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'hello' }],
    });

    assert.equal(result.content, 'Antigravity online.');
    const req = srv.seen[0];
    assert.equal(req.url, '/v1internal:streamGenerateContent?alt=sse');
    assert.equal(req.headers['x-goog-user-project'], undefined, 'x-goog-user-project must be stripped');
    assert.match(req.headers['user-agent'] as string, /^antigravity\/hub\//);

    const sent = JSON.parse(req.body.toString('utf8'));
    assert.equal(sent.project, 'aicode-consumers');
    assert.equal(sent.model, 'gemini-3.8-flash-medium', 'base flash model mapped to medium tier');
    assert.equal(sent.userAgent, 'antigravity');
    assert.equal(sent.requestType, 'agent');
    assert.match(sent.requestId, /^agent\//);
  } finally {
    await srv.close();
  }
});

test('google-vertex exchanges service_account ADC JWT for a bearer token, caches it, and streams from project/location endpoint', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  let tokenCalls = 0;
  const srv = await startFakeServer((req, res) => {
    if (req.url === '/oauth2/token') {
      tokenCalls++;
      const params = new URLSearchParams(req.body.toString('utf8'));
      assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const assertion = params.get('assertion')!;
      const [h, p, s] = assertion.split('.');
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(`${h}.${p}`);
      verifier.end();
      assert.equal(verifier.verify(publicKey, Buffer.from(s, 'base64url')), true);
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      assert.equal(claims.iss, 'svc@vertex-proj.iam.gserviceaccount.com');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'vertex-adc-token-1', expires_in: 3600 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      sse({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Vertex ok' },
                { functionCall: { id: 'v_call', name: 'read_file', args: { path: 'v.ts' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 250, candidatesTokenCount: 25 },
      }),
    );
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-vertex-adc-'));
  const adcPath = path.join(tmpDir, 'adc.json');
  fs.writeFileSync(
    adcPath,
    JSON.stringify({
      type: 'service_account',
      project_id: 'vertex-proj',
      client_email: 'svc@vertex-proj.iam.gserviceaccount.com',
      private_key: privatePem,
      token_uri: `${srv.url}/oauth2/token`,
    }),
  );

  try {
    const credential = JSON.stringify({
      GOOGLE_APPLICATION_CREDENTIALS: adcPath,
      GOOGLE_CLOUD_LOCATION: 'us-central1',
    });
    const provider = new GoogleVertexProvider(makeInfo('google-vertex', 'google-vertex', srv.url), credential, {});
    const first = await provider.chat({
      model: 'gemini-test-pro',
      messages: [{ role: 'user', content: 'hello vertex' }],
      tools,
    });
    assert.equal(first.content, 'Vertex ok');
    assert.equal(first.toolCalls?.[0].name, 'read_file');
    assert.equal(first.usage.promptTokens, 250);
    assert.equal(first.usage.completionTokens, 25);

    // Second call reuses the cached access token without hitting /oauth2/token again.
    await provider.chat({
      model: 'gemini-test-pro',
      messages: [{ role: 'user', content: 'again' }],
    });
    assert.equal(tokenCalls, 1);

    const chatReq = srv.seen[1];
    assert.equal(
      chatReq.url,
      '/v1/projects/vertex-proj/locations/us-central1/publishers/google/models/gemini-test-pro:streamGenerateContent?alt=sse',
    );
    assert.equal(chatReq.headers.authorization, 'Bearer vertex-adc-token-1');
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('google-vertex supports authorized_user ADC refresh and cancellation', async () => {
  const srv = await startFakeServer((req, res) => {
    if (req.url === '/token') {
      const params = new URLSearchParams(req.body.toString('utf8'));
      assert.equal(params.get('grant_type'), 'refresh_token');
      assert.equal(params.get('refresh_token'), 'r-tok');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'user-adc-tok', expires_in: 3600 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      sse({
        candidates: [{ content: { parts: [{ text: 'from user adc' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
      }),
    );
  });

  try {
    const adcInline = JSON.stringify({
      type: 'authorized_user',
      client_id: 'cid',
      client_secret: 'csec',
      refresh_token: 'r-tok',
      quota_project_id: 'quota-proj-9',
      token_uri: `${srv.url}/token`,
    });
    const provider = new GoogleVertexProvider(makeInfo('google-vertex', 'google-vertex', srv.url), adcInline, {});
    const res = await provider.chat({
      model: 'gemini-test-pro',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(res.content, 'from user adc');
    assert.equal(srv.seen[1].headers['x-goog-user-project'], 'quota-proj-9');

    const abortController = new AbortController();
    abortController.abort();
    await assert.rejects(
      provider.chat({
        model: 'gemini-test-pro',
        messages: [{ role: 'user', content: 'abort me' }],
        signal: abortController.signal,
      }),
      /abort/i,
    );
  } finally {
    await srv.close();
  }
});
