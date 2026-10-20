// tests/tui-controller.test.ts - Commands and human decisions through the TUI contracts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TuiStore } from '../src/tui/store.js';
import { TuiController, resolveActiveModel, enrichErrorMessage } from '../src/tui/controller.js';
import { loadCatalog } from '../src/llm/catalog/index.js';
import { saveCredential } from '../src/llm/auth/store.js';
import { loadConfig } from '../src/core/config.js';

test('approval resolves only on a decision and cancellation refuses pending work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new TuiStore();
  t.after(() => store.dispose());
  const approval = new Promise(resolve => store.requestApproval({ name: 'run_command', args: { command: 'pip install x' }, reason: 'dependency' }, resolve));
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

test('help uses the shared router and Ctrl+C requires two presses within two seconds', async t => {
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

test('resolveActiveModel avoids unconfigured auth:none providers like litellm and selects logged-in provider', t => {
  const prevHome = process.env.AXIOM_HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tui-test-'));
  process.env.AXIOM_HOME = tmpHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

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

test('submitting a prompt with no connected provider shows /login instructions instead of calling litellm', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const prevHome = process.env.AXIOM_HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tui-noprovider-'));
  process.env.AXIOM_HOME = tmpHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

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

test('/model and /logout update TuiStore model state and config.json immediately', async t => {
  const prevHome = process.env.AXIOM_HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tui-commands-'));
  process.env.AXIOM_HOME = tmpHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  saveCredential('google', { type: 'api_key', key: 'AIzaSyDummyKeyForTest' });
  const store = new TuiStore();
  t.after(() => store.dispose());
  const controller = new TuiController(store, { workspaceRoot: process.cwd() });
  assert.equal(store.getSnapshot().model?.id, 'gemini-3.1-flash-lite');

  await controller.submit('/model google/gemini-2.5-pro');
  assert.equal(store.getSnapshot().model?.id, 'gemini-2.5-pro');
  assert.equal(loadConfig().defaultModel, 'google/gemini-2.5-pro');

  await controller.submit('/logout google');
  assert.equal(store.getSnapshot().model, null);
});
