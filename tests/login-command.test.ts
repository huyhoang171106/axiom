import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginCommand } from '../src/commands/login.js';
import { logoutCommand } from '../src/commands/logout.js';
import type { CommandContext } from '../src/commands/types.js';
import { readAuth } from '../src/llm/auth/store.js';
import { loadCatalog } from '../src/llm/catalog/index.js';
import { fakeUI } from './fake-ui.js';
import { startFakeServer } from './fake-server.js';

function useTempHome(t: { after(fn: () => void): void }): string {
  const saved = process.env.AXIOM_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-login-'));
  process.env.AXIOM_HOME = home;
  t.after(() => (saved === undefined ? delete process.env.AXIOM_HOME : (process.env.AXIOM_HOME = saved)));
  return home;
}

const ctx = (answers: string[] = []) => ({ ui: fakeUI(answers) }) as unknown as CommandContext;

// A provider whose key check is a chat call on its own base URL, so models.json can point it at the fake server.
const target = loadCatalog().providers().find((p) => {
  const v = p.login?.validate as { kind?: string; baseUrl?: string } | undefined;
  return p.login?.type === 'api-key' && v?.kind === 'chat-completions' && !v.baseUrl;
})!;

test('/login <provider> stores a key the provider accepts (200) and not one it rejects (401)', async (t) => {
  const home = useTempHome(t);
  const srv = await startFakeServer((req, res) => res.writeHead(req.headers.authorization === 'Bearer good' ? 200 : 401).end('{}'));
  try {
    fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers: { [target.id]: { baseUrl: srv.url } } }));
    await assert.rejects(loginCommand.run(target.id, ctx(['bad'])), /rejected the key/);
    assert.equal(readAuth(home)[target.id], undefined);
    const result = await loginCommand.run(target.id, ctx(['good']));
    assert.match(result!.text, /Connected/);
    assert.deepEqual(readAuth(home)[target.id], { type: 'api_key', key: 'good' });
    assert.equal(srv.seen[1].url, '/chat/completions');
  } finally {
    await srv.close();
  }
});

test('/login with no provider lists every provider in /login order with its status', async (t) => {
  useTempHome(t);
  const result = await loginCommand.run('', ctx());
  const rows = result!.data as { id: string; status: string }[];
  assert.equal(rows.length, 91);
  assert.deepEqual(rows.map((r) => r.id), loadCatalog().providers().map((p) => p.id));
  assert.match(rows.find((r) => r.id === 'typesafe')!.status, /^unsupported: /);
  assert.equal(rows.find((r) => r.id === 'ollama')!.status, 'available');
});

test('/login explains unsupported, env-only, local and unknown providers instead of failing silently', async (t) => {
  useTempHome(t);
  await assert.rejects(loginCommand.run('apple', ctx()), /not supported in Axiom/);
  assert.match((await loginCommand.run('ollama', ctx()))!.text, /needs no login/);
  assert.match((await loginCommand.run('bedrock-mantle', ctx()))!.text, /Set AWS_BEARER_TOKEN_BEDROCK/);
  await assert.rejects(loginCommand.run('deepsek', ctx()), /Unknown provider deepsek\. Did you mean deepseek/);
});

test('/logout removes only the named credential', async (t) => {
  const home = useTempHome(t);
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ a: { type: 'api_key', key: '1' }, b: { type: 'api_key', key: '2' } }));
  assert.match((await logoutCommand.run('', ctx()))!.text, /Logged in: a, b/);
  assert.match((await logoutCommand.run('a', ctx()))!.text, /Removed/);
  assert.match((await logoutCommand.run('a', ctx()))!.text, /Nothing stored for a/);
  assert.deepEqual(Object.keys(readAuth(home)), ['b']);
});
