import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WIRES } from '../src/llm/provider-factory.js';
import type { ModelInfo, WireApi } from '../src/llm/catalog/index.js';

/** Answers every request with `body` and records what was asked. */
async function fakeServer(body: unknown) {
  const seen: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    req.resume().on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const info = (api: WireApi, baseUrl: string): ModelInfo => ({
  provider: 'p', id: 'm', name: 'm', api, baseUrl, contextWindow: 1000, reasoning: false, input: ['text'],
});

test('anthropic-messages wire appends /v1 to the catalog base URL and sends the credential', async () => {
  const srv = await fakeServer({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
  try {
    const r = await WIRES['anthropic-messages'](info('anthropic-messages', `${srv.url}/api/anthropic`), 'k-1').chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.content, 'ok');
    assert.equal(srv.seen[0].url, '/api/anthropic/v1/messages');
    assert.equal(srv.seen[0].headers['x-api-key'], 'k-1');
    assert.equal(srv.seen[0].headers.authorization, undefined);
  } finally {
    srv.close();
  }
});

test('anthropic-messages with oauth token sends bearer auth, claude identity and oauth beta header', async () => {
  let seenBody: Record<string, unknown> | undefined;
  const srv = await fakeServer({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
  // Intercept body to inspect payload
  const origListeners = srv.close;
  try {
    const infoAnthropic: ModelInfo = { ...info('anthropic-messages', `${srv.url}/api/anthropic`), provider: 'anthropic' };
    const r = await WIRES['anthropic-messages'](infoAnthropic, 'sk-ant-oat01-test-token').chat({
      model: 'claude-opus-5-5',
      messages: [{ role: 'system', content: 'custom prompt' }, { role: 'user', content: 'hi' }],
    });
    assert.equal(r.content, 'ok');
    assert.equal(srv.seen[0].url, '/api/anthropic/v1/messages');
    assert.equal(srv.seen[0].headers.authorization, 'Bearer sk-ant-oat01-test-token');
    assert.equal(srv.seen[0].headers['x-api-key'], undefined, 'x-api-key must not be sent for OAuth token');
    assert.match(String(srv.seen[0].headers['anthropic-beta']), /oauth-2025-04-20/);
    assert.match(String(srv.seen[0].headers['anthropic-beta']), /claude-code-20250219/);
    assert.match(String(srv.seen[0].headers['user-agent']), /^claude-cli\//);
    assert.equal(srv.seen[0].headers['x-app'], 'cli');
  } finally {
    srv.close();
  }
});

test('anthropic-messages with github-copilot or gitlab-duo sends bearer auth instead of x-api-key', async () => {
  const srv = await fakeServer({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
  try {
    const copilotInfo: ModelInfo = { ...info('anthropic-messages', `${srv.url}/copilot`), provider: 'github-copilot' };
    await WIRES['anthropic-messages'](copilotInfo, 'gh-copilot-token').chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(srv.seen[0].headers.authorization, 'Bearer gh-copilot-token');
    assert.equal(srv.seen[0].headers['x-api-key'], undefined);

    const gitlabInfo: ModelInfo = { ...info('anthropic-messages', `${srv.url}/gitlab`), provider: 'gitlab-duo' };
    await WIRES['anthropic-messages'](gitlabInfo, 'gl-pat-token').chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(srv.seen[1].headers.authorization, 'Bearer gl-pat-token');
    assert.equal(srv.seen[1].headers['x-api-key'], undefined);
  } finally {
    srv.close();
  }
});

test('openai-completions wire posts to <baseUrl>/chat/completions with a bearer credential', async () => {
  const srv = await fakeServer({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  try {
    const r = await WIRES['openai-completions'](info('openai-completions', `${srv.url}/v1`), 'k-2').chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.content, 'ok');
    assert.equal(srv.seen[0].url, '/v1/chat/completions');
    assert.equal(srv.seen[0].headers.authorization, 'Bearer k-2');
  } finally {
    srv.close();
  }
});

test('openai-completions and anthropic-messages wires send the catalog headers of the model', async () => {
  const srv = await fakeServer({ choices: [{ message: { content: 'ok' } }], content: [{ type: 'text', text: 'ok' }], usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 } });
  try {
    for (const api of ['openai-completions', 'anthropic-messages'] as const) {
      await WIRES[api]({ ...info(api, srv.url), headers: { 'x-catalog': api } }, 'k').chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    }
    assert.deepEqual(srv.seen.map((s) => s.headers['x-catalog']), ['openai-completions', 'anthropic-messages']);
  } finally {
    srv.close();
  }
});
