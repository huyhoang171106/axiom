import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICodexResponsesProvider } from '../src/llm/providers/openai-codex-responses.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { ProviderError } from '../src/llm/provider-error.js';
import { startFakeServer } from './fake-server.js';

const info = (baseUrl: string): ModelInfo => ({
  provider: 'openai-codex', id: 'gpt-5.5-codex', name: 'GPT-5.5 Codex', api: 'openai-codex-responses', baseUrl,
  contextWindow: 400000, maxTokens: 8192, reasoning: true, input: ['text'], cost: { input: 1, output: 8 },
});

/** `header.payload.signature`, payload carrying the ChatGPT account claim. */
const jwt = (claims: Record<string, unknown>): string =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

const completed = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } };

test('sends the account id from the JWT claim and streams the answer', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'hi' }, completed));
  });
  try {
    const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', sub: 'user-1' } });
    const r = await new OpenAICodexResponsesProvider(info(srv.url), token).chat({
      model: 'gpt-5.5-codex',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.9,
      maxTokens: 32,
    });
    assert.equal(r.content, 'hi');
    assert.equal(r.usage.promptTokens, 10);

    const req = srv.seen[0];
    assert.equal(req.url, '/responses');
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers['chatgpt-account-id'], 'acct-1');
    const sent = JSON.parse(req.body.toString());
    assert.equal(sent.max_output_tokens, 32);
    // The Codex backend rejects sampling params: temperature never reaches the body.
    assert.equal('temperature' in sent, false);
  } finally {
    await srv.close();
  }
});

test('mixed-case catalog headers override credential and account ID', async () => {
  const srv = await startFakeServer((_req, res) => res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'ok' }, completed)));
  try {
    const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } });
    await new OpenAICodexResponsesProvider({ ...info(srv.url), headers: { Authorization: 'Bearer pinned', 'ChatGPT-Account-ID': 'pinned-account' } }, token).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(srv.seen[0].headers.authorization, 'Bearer pinned');
    assert.equal(srv.seen[0].headers['chatgpt-account-id'], 'pinned-account');
  } finally { await srv.close(); }
});

test('a non-JWT credential omits the account header instead of failing', async () => {
  const srv = await startFakeServer((_req, res) => {
    res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'ok' }, completed));
  });
  try {
    await new OpenAICodexResponsesProvider(info(srv.url), 'gateway-token').chat({ model: 'gpt-5.5-codex', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(srv.seen[0].headers.authorization, 'Bearer gateway-token');
    assert.equal(srv.seen[0].headers['chatgpt-account-id'], undefined);
  } finally {
    await srv.close();
  }
});

test('reports ProviderError for a rejected key and a broken stream', async () => {
  const denied = await startFakeServer((_req, res) => res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"invalid token","type":"invalid_request_error"}}'));
  const broken = await startFakeServer((_req, res) => res.writeHead(200).end(sse({ type: 'response.output_text.delta', delta: 'par' }, { type: 'error', message: 'upstream reset' })));
  try {
    await assert.rejects(
      new OpenAICodexResponsesProvider(info(denied.url), jwt({})).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      (e: unknown) => e instanceof ProviderError && e.status === 401 && /invalid token/.test(e.message),
    );
    await assert.rejects(
      new OpenAICodexResponsesProvider(info(broken.url), jwt({})).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      (e: unknown) => e instanceof ProviderError && /upstream reset/.test(e.message) && e.partialContent === 'par',
    );
  } finally {
    await Promise.all([denied.close(), broken.close()]);
  }
});
