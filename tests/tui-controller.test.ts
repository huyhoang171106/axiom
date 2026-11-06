// tests/tui-controller.test.ts - Commands, transient selectors and human decisions through the TUI contracts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TuiStore } from '../src/tui/store.js';
import { TuiController, resolveActiveModel, enrichErrorMessage } from '../src/tui/controller.js';
import { loadCatalog } from '../src/llm/catalog/index.js';
import { readAuth, saveCredential } from '../src/llm/auth/store.js';
import { loadConfig } from '../src/core/config.js';
import { startFakeServer } from './fake-server.js';

function useTempHome(t: { after(fn: () => void): void }): string {
  const prevHome = process.env.AXIOM_HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tui-test-'));
  process.env.AXIOM_HOME = tmpHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });
  return tmpHome;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('approval resolves only on a decision and cancellation refuses pending work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new TuiStore();
  t.after(() => store.dispose());
  const approval = new Promise((resolve) =>
    store.requestApproval({ name: 'run_command', args: { command: 'pip install x' }, reason: 'dependency' }, resolve),
  );
  t.mock.timers.tick(34);
  assert.equal(store.getSnapshot().pendingApproval?.name, 'run_command');
  store.cancelInteraction();
  assert.equal(await approval, 'deny');
  t.mock.timers.tick(34);
  assert.equal(store.getSnapshot().pendingApproval, null);
  const answer = store.ask('Key', true);
  store.answer('typed');
  assert.equal(await answer, 'typed');
  const cancelled = store.ask('Key', true);
  const rejected = assert.rejects(cancelled, /Cancelled/);
  store.cancelInteraction();
  await rejected;
});

test('help uses the shared router and Ctrl+C requires two presses within two seconds', async (t) => {
  useTempHome(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new TuiStore();
  t.after(() => store.dispose());
  let exits = 0;
  const controller = new TuiController(store, { workspaceRoot: process.cwd(), mock: true, exit: () => exits++ });
  await controller.submit('/help');
  t.mock.timers.tick(34);
  assert.match(store.getSnapshot().entries[0].text, /triage/);
  store.update({ editor: { text: 'draft', cursor: 5 } });
  controller.interrupt(1000);
  t.mock.timers.tick(34);
  assert.equal(store.getSnapshot().editor.text, '');
  assert.equal(exits, 0);
  controller.interrupt(4000);
  assert.equal(exits, 0);
  controller.interrupt(5000);
  assert.equal(exits, 1);
});

test('resolveActiveModel avoids unconfigured auth:none providers like litellm and selects logged-in provider', (t) => {
  useTempHome(t);
  const catalog = loadCatalog();
  assert.equal(resolveActiveModel(catalog, {}), null);

  saveCredential('google', { type: 'api_key', key: 'AIzaSyDummyKeyForTest' });
  const catalogAfterLogin = loadCatalog();
  const resolved = resolveActiveModel(catalogAfterLogin, {});
  assert.equal(resolved && `${resolved.provider}/${resolved.id}`, 'google/gemini-3.1-flash-lite');

  const store = new TuiStore();
  t.after(() => store.dispose());
  const controller = new TuiController(store, { workspaceRoot: process.cwd() });
  const active = store.getSnapshot().model;
  assert.equal(active && `${active.provider}/${active.id}`, 'google/gemini-3.1-flash-lite');
  assert.equal(loadConfig().defaultModel, 'google/gemini-3.1-flash-lite');
  void controller;
});

test('submitting a prompt with no connected provider shows /login instructions instead of calling litellm', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  useTempHome(t);
  const store = new TuiStore();
  t.after(() => store.dispose());
  const controller = new TuiController(store, { workspaceRoot: process.cwd() });
  assert.equal(store.getSnapshot().model, null);

  await controller.submit('hello');
  t.mock.timers.tick(34);
  const entries = store.getSnapshot().entries;
  assert.equal(entries.length, 1);
  assert.match(entries[0].text, /\/login/);
});

test('enrichErrorMessage adds actionable guidance for HTTP 400, fetch failed, 404, and 429', () => {
  const catalog = loadCatalog();
  const litellmModel = catalog.models('litellm')[0] ?? null;
  const googleModel = catalog.models('google')[0] ?? null;
  assert.match(enrichErrorMessage('Key not saved (HTTP 400).', null), /API key không hợp lệ/);
  assert.match(enrichErrorMessage('LLM provider error: fetch failed', litellmModel), /localhost:4000/);
  assert.match(enrichErrorMessage('Google error (404): model is no longer available', googleModel), /gemini-3\.1-flash-lite/);
  assert.match(enrichErrorMessage('Google error (429): Quota exceeded', googleModel), /vượt hạn mức/);
});

test('/model and /logout with explicit arguments update TuiStore model state and config.json immediately', async (t) => {
  useTempHome(t);
  saveCredential('google', { type: 'api_key', key: 'AIzaSyDummyKeyForTest' });
  const store = new TuiStore();
  t.after(() => store.dispose());
  const controller = new TuiController(store, { workspaceRoot: process.cwd() });
  assert.equal(store.getSnapshot().model?.id, 'gemini-3.1-flash-lite');

  await controller.submit('/model google/gemini-2.5-pro');
  assert.equal(store.getSnapshot().model?.id, 'gemini-2.5-pro');
  assert.equal(loadConfig().defaultModel, 'google/gemini-2.5-pro');
  assert.equal(store.getSnapshot().entries.length, 0);

  await controller.submit('/logout google');
  assert.equal(store.getSnapshot().model, null);
  assert.equal(store.getSnapshot().entries.length, 0);
});

test('TEST A & TEST B: interactive /model selector updates model on Enter and preserves model on Esc without polluting transcript', async (t) => {
  const home = useTempHome(t);
  saveCredential('google', { type: 'api_key', key: 'AIzaSyDummyKeyForTest' });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ enabledProviders: ['google'] }));

  const store = new TuiStore();
  t.after(() => store.dispose());
  const controller = new TuiController(store, { workspaceRoot: process.cwd() });
  assert.equal(store.getSnapshot().model?.id, 'gemini-3.1-flash-lite');

  // TEST B: Open /model -> press Esc -> selector closes, model unchanged, transcript empty.
  const cancelPromise = controller.submit('/model');
  await waitFor(() => store.getMenu()?.kind === 'model');
  store.flush();
  assert.equal(store.getSnapshot().menu?.kind, 'model');
  assert.ok((store.getSnapshot().menu?.items.length ?? 0) > 0);
  store.resolveMenu(null);
  await cancelPromise;

  assert.equal(store.getSnapshot().menu, null);
  assert.equal(store.getSnapshot().model?.id, 'gemini-3.1-flash-lite');
  assert.equal(store.getSnapshot().entries.length, 0);

  // TEST A: Open /model -> select google/gemini-2.5-pro -> selector closes, model updated, transcript empty.
  const selectPromise = controller.submit('/model');
  await waitFor(() => store.getMenu()?.kind === 'model');
  store.resolveMenu('google/gemini-2.5-pro');
  await selectPromise;

  assert.equal(store.getSnapshot().menu, null);
  assert.equal(store.getSnapshot().model?.id, 'gemini-2.5-pro');
  assert.equal(loadConfig().defaultModel, 'google/gemini-2.5-pro');
  assert.equal(store.getSnapshot().entries.length, 0);
});

test('TEST C: interactive /login selector picks provider, completes auth and closes without leaving provider list in transcript', async (t) => {
  const home = useTempHome(t);
  const target = loadCatalog()
    .providers()
    .find((p) => {
      const v = p.login?.validate as { kind?: string; baseUrl?: string } | undefined;
      return p.login?.type === 'api-key' && v?.kind === 'chat-completions' && !v.baseUrl;
    })!;

  const srv = await startFakeServer((req, res) =>
    res.writeHead(req.headers.authorization === 'Bearer valid-key' ? 200 : 401).end('{}'),
  );
  t.after(() => srv.close());
  fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers: { [target.id]: { baseUrl: srv.url } } }));

  const store = new TuiStore();
  t.after(() => store.dispose());
  const controller = new TuiController(store, { workspaceRoot: process.cwd() });

  const loginPromise = controller.submit('/login');
  await waitFor(() => store.getMenu()?.kind === 'login');
  store.flush();
  assert.equal(store.getSnapshot().menu?.kind, 'login');
  assert.equal(store.getSnapshot().entries.length, 0);

  // Select the provider from the menu.
  store.resolveMenu(target.id);
  await waitFor(() => {
    store.flush();
    return store.getSnapshot().question !== null;
  });
  // Menu is closed while the transient auth prompt is active.
  assert.equal(store.getSnapshot().menu, null);
  assert.equal(store.getSnapshot().question?.secret, true);

  // Submit the API key.
  store.answer('valid-key');
  await loginPromise;

  assert.equal(store.getSnapshot().menu, null);
  assert.equal(store.getSnapshot().question, null);
  assert.deepEqual(readAuth(home)[target.id], { type: 'api_key', key: 'valid-key' });
  assert.equal(store.getSnapshot().model?.provider, target.id);
  // Zero provider list or prompt lines were left in the conversation history!
  assert.equal(store.getSnapshot().entries.length, 0);
});

test('TEST D, TEST E & TEST G: repeated menu open/cancel preserves prior chat history and handles abort cleanly', async (t) => {
  const home = useTempHome(t);
  saveCredential('google', { type: 'api_key', key: 'AIzaSyDummyKeyForTest' });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ enabledProviders: ['google'] }));

  const store = new TuiStore();
  t.after(() => store.dispose());
  const controller = new TuiController(store, { workspaceRoot: process.cwd(), mock: true });

  // TEST E: Chat before opening any menu.
  await controller.submit('Explain this repository');
  store.flush();
  const initialEntriesCount = store.getSnapshot().entries.length;
  assert.equal(initialEntriesCount, 1);
  assert.match(store.getSnapshot().entries[0].prompt ?? '', /Explain this repository/);

  // TEST D: Open and cancel /login and /model multiple times.
  for (let i = 0; i < 3; i++) {
    const pLogin = controller.submit('/login');
    await waitFor(() => store.getMenu()?.kind === 'login');
    store.resolveMenu(null);
    await pLogin;
    assert.equal(store.getSnapshot().menu, null);

    const pModel = controller.submit('/model');
    await waitFor(() => store.getMenu()?.kind === 'model');
    store.resolveMenu(null);
    await pModel;
    assert.equal(store.getSnapshot().menu, null);
  }

  // TEST G: Open menu while async command is active, concurrent submit is ignored, and abort() closes menu cleanly.
  const pAbort = controller.submit('/login');
  await waitFor(() => store.getMenu()?.kind === 'login');
  await controller.submit('concurrent message while menu is open');
  controller.abort();
  await pAbort;
  assert.equal(store.getSnapshot().menu, null);
  assert.equal(store.getSnapshot().busy, false);

  // Prior chat history is still intact with zero menu pollution.
  assert.equal(store.getSnapshot().entries.length, initialEntriesCount);
  assert.match(store.getSnapshot().entries[0].prompt ?? '', /Explain this repository/);
});
