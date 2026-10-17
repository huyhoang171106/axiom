import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloudFieldsEngine, cloudLoginSchema, prepareCloud } from '../src/llm/auth/engines/cloud-fields.js';
import { loadCatalog, type ProviderEntry } from '../src/llm/catalog/index.js';
import { createProviderFor } from '../src/llm/model-resolver.js';
import { fakeUI } from './fake-ui.js';
import { startFakeServer } from './fake-server.js';

const CLOUD = ['azure', 'google-vertex', 'amazon-bedrock', 'cloudflare-ai-gateway', 'snowflake'];
const catalog = loadCatalog(fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-cloud-')));
const entry = (id: string): ProviderEntry => catalog.providers().find((p) => p.id === id)!;
const modelOf = (id: string) => catalog.models(id)[0];
const prepare = (id: string, values: Record<string, string>) => prepareCloud(entry(id), modelOf(id), JSON.stringify(values));

test('the five cloud providers ask for fields that include their main env name', () => {
  for (const id of CLOUD) {
    const login = cloudLoginSchema.parse(entry(id).login);
    assert.ok(login.fields.some((f) => f.name === entry(id).env[0]), id);
  }
});

test('the engine asks every field, hides secrets, skips optional ones and refuses a missing required one', async () => {
  const ui = fakeUI(['tok', 'acc-1', 'gw-1']);
  assert.deepEqual(await cloudFieldsEngine(entry('cloudflare-ai-gateway'), ui), {
    type: 'fields', values: { CLOUDFLARE_AI_GATEWAY_API_KEY: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc-1', CLOUDFLARE_GATEWAY_ID: 'gw-1' },
  });
  assert.equal(ui.asked.length, 3);
  assert.deepEqual(await cloudFieldsEngine(entry('amazon-bedrock'), fakeUI(['', 'AKIA1', 'secret', '', 'eu-west-1'])), {
    type: 'fields', values: { AWS_ACCESS_KEY_ID: 'AKIA1', AWS_SECRET_ACCESS_KEY: 'secret', AWS_REGION: 'eu-west-1' },
  });
  await assert.rejects(cloudFieldsEngine(entry('snowflake'), fakeUI(['myorg-acct', ''])), /SNOWFLAKE_PAT is required/);
  await assert.rejects(cloudFieldsEngine(entry('amazon-bedrock'), fakeUI([])), /No field entered/);
});

test('the hook rejects unusable values at login time', async () => {
  await assert.rejects(cloudFieldsEngine(entry('azure'), fakeUI(['key', '', ''])), /AZURE_OPENAI_RESOURCE_NAME/);
  await assert.rejects(cloudFieldsEngine(entry('snowflake'), fakeUI(['evil.example/x', 'pat'])), /not a Snowflake account/);
});

test('azure hook: resource name or https base URL, key as the credential', async () => {
  const byName = await prepare('azure', { AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_RESOURCE_NAME: 'my-res' });
  assert.deepEqual([byName.info.baseUrl, byName.credential], ['https://my-res.openai.azure.com/openai/v1', 'k']);
  const byUrl = await prepare('azure', { AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_BASE_URL: 'https://proxy.example/openai/v1/' });
  assert.equal(byUrl.info.baseUrl, 'https://proxy.example/openai/v1');
  await assert.rejects(prepare('azure', { AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_BASE_URL: 'http://plain.example' }), /https/);
});

test('google-vertex hook: regional or global host, every field passed on', async () => {
  const regional = await prepare('google-vertex', { GOOGLE_CLOUD_PROJECT: 'p1', GOOGLE_CLOUD_LOCATION: 'us-central1' });
  assert.equal(regional.info.baseUrl, 'https://us-central1-aiplatform.googleapis.com');
  assert.deepEqual(JSON.parse(regional.credential!), { GOOGLE_CLOUD_PROJECT: 'p1', GOOGLE_CLOUD_LOCATION: 'us-central1' });
  assert.equal((await prepare('google-vertex', { GOOGLE_CLOUD_API_KEY: 'k' })).info.baseUrl, 'https://aiplatform.googleapis.com');
});

test('amazon-bedrock has no hook: the wire gets the JSON fields unchanged', async () => {
  const values = { AWS_ACCESS_KEY_ID: 'AKIA1', AWS_SECRET_ACCESS_KEY: 's', AWS_REGION: 'eu-west-1' };
  const prepared = await prepare('amazon-bedrock', values);
  assert.equal(prepared.info, modelOf('amazon-bedrock'));
  assert.deepEqual(JSON.parse(prepared.credential!), values);
});

test('cloudflare-ai-gateway hook: account and gateway in the URL, token in cf-aig-authorization', async () => {
  const p = await prepare('cloudflare-ai-gateway', { CLOUDFLARE_AI_GATEWAY_API_KEY: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_GATEWAY_ID: 'gw' });
  assert.equal(p.info.baseUrl, 'https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic');
  assert.equal(p.info.headers?.['cf-aig-authorization'], 'Bearer tok');
  await assert.rejects(prepare('cloudflare-ai-gateway', { CLOUDFLARE_AI_GATEWAY_API_KEY: 'tok', CLOUDFLARE_ACCOUNT_ID: '../x', CLOUDFLARE_GATEWAY_ID: 'gw' }), /needs/);
});

test('snowflake hook: account identifier to its host, PAT as bearer', async () => {
  const p = await prepare('snowflake', { SNOWFLAKE_ACCOUNT: 'MyOrg_Acct', SNOWFLAKE_PAT: 'pat' });
  assert.equal(p.info.baseUrl, 'https://myorg-acct.snowflakecomputing.com/api/v2/cortex');
  assert.equal(p.info.headers?.authorization, 'Bearer pat');
  assert.equal((await prepare('snowflake', { SNOWFLAKE_ACCOUNT: 'https://x1.snowflakecomputing.com/', SNOWFLAKE_PAT: 'pat' })).info.baseUrl, 'https://x1.snowflakecomputing.com/api/v2/cortex');
});

test('createProviderFor runs the hook on env credentials and the wire calls the prepared URL', async (t) => {
  const keys = ['AXIOM_HOME', 'CLOUDFLARE_AI_GATEWAY_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'] as const;
  const saved = keys.map((k) => process.env[k]);
  t.after(() => keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]))));
  const srv = await startFakeServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } })));
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-cloud-home-'));
    fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers: { 'cloudflare-ai-gateway': { baseUrl: `${srv.url}/v1/<account>/<gateway>/anthropic` } } }));
    Object.assign(process.env, { AXIOM_HOME: home, CLOUDFLARE_AI_GATEWAY_API_KEY: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_GATEWAY_ID: 'gw' });
    const info = loadCatalog().models('cloudflare-ai-gateway')[0];
    const r = await (await createProviderFor(info)).chat({ model: info.id, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.content, 'ok');
    assert.equal(srv.seen[0].url, '/v1/acc/gw/anthropic/v1/messages');
    assert.equal(srv.seen[0].headers['cf-aig-authorization'], 'Bearer tok');
  } finally {
    await srv.close();
  }
});
