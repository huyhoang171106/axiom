// tests/tui-app.test.ts - Render the full TUI so output Ink drops between components is caught
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { App } from '../src/tui/app.js';
import { TuiStore } from '../src/tui/store.js';
import type { TuiController } from '../src/tui/controller.js';

function fakeTty(): PassThrough & { columns: number; rows: number; isTTY: boolean; setRawMode(): void; ref(): void; unref(): void } {
  return Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: true, setRawMode() {}, ref() {}, unref() {} });
}

test('command output printed after the header is shown in the terminal', async () => {
  const stdout = fakeTty();
  let written = '';
  stdout.on('data', (chunk: Buffer) => { written += chunk.toString(); });
  const store = new TuiStore();
  const controller = { submit: async () => {}, interrupt() {}, abort() {}, lastPrompt: '' } as unknown as TuiController;
  const app = render(createElement(App, { store, controller, workspace: '/repo', initial: '' }),
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: fakeTty() as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 100));
  store.print('provider list goes here', '/login');
  await new Promise(resolve => setTimeout(resolve, 200));
  app.unmount();
  store.dispose();
  assert.match(written, /Axiom/);
  assert.match(written, /provider list goes here/);
});

test('TEST F: transient SelectMenu mounts in App, handles terminal resize and unmounts cleanly on selection', async () => {
  const stdout = fakeTty();
  const stdin = fakeTty();
  let written = '';
  stdout.on('data', (chunk: Buffer) => { written += chunk.toString(); });
  const store = new TuiStore();
  const controller = { submit: async () => {}, interrupt() {}, abort() {}, lastPrompt: '' } as unknown as TuiController;
  const app = render(createElement(App, { store, controller, workspace: '/repo', initial: '' }),
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false });

  await new Promise(resolve => setTimeout(resolve, 60));

  const menuPromise = store.openMenu({
    kind: 'model',
    title: 'Chọn model cho phiên làm việc',
    items: [
      { value: 'google/gemini-3.1-flash-lite', label: 'google/gemini-3.1-flash-lite', description: 'Gemini 3.1 Flash Lite' },
      { value: 'google/gemini-2.5-pro', label: 'google/gemini-2.5-pro', description: 'Gemini 2.5 Pro' },
    ],
  });
  store.flush();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.match(written, /Chọn model cho phiên làm việc/);

  // Simulate terminal resize while the menu is open.
  stdout.columns = 60;
  stdout.emit('resize');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(store.getSnapshot().menu?.kind, 'model');

  // Press Enter in stdin (or resolve menu) to select and close.
  stdin.write('\r');
  const chosen = await menuPromise;
  store.flush();
  await new Promise(resolve => setTimeout(resolve, 60));

  assert.equal(chosen, 'google/gemini-3.1-flash-lite');
  assert.equal(store.getSnapshot().menu, null);
  assert.equal(store.getSnapshot().entries.length, 0);

  app.unmount();
  store.dispose();
});
