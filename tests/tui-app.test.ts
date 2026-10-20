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
  assert.match(written, /Axiom/);
  assert.match(written, /provider list goes here/);
});
