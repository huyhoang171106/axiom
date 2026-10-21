// tests/tui-app.test.ts - Render the full TUI so output Ink drops between components is caught
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { App } from '../src/tui/app.js';
import { TuiStore } from '../src/tui/store.js';
import { TuiController } from '../src/tui/controller.js';

function fakeTty(columns = 100, rows = 40): PassThrough & { columns: number; rows: number; isTTY: boolean; setRawMode(): void; ref(): void; unref(): void } {
  return Object.assign(new PassThrough(), { columns, rows, isTTY: true, setRawMode() {}, ref() {}, unref() {} });
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false, interactive: true });

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
  assert.equal(countOccurrences(written, 'Axiom v0.1'), 1);

  app.unmount();
  store.dispose();
});

test('multi-turn chat -> /help -> /model -> /login -> /clear -> chat never duplicates startup Header or leaks state machine errors', async () => {
  const stdout = fakeTty(90, 24);
  const stdin = fakeTty(90, 24);
  let written = '';
  stdout.on('data', (chunk: Buffer) => { written += chunk.toString(); });

  const consoleErrors: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  };

  try {
    const store = new TuiStore();
    const controller = new TuiController(store, { workspaceRoot: process.cwd(), mock: true });
    const app = render(createElement(App, { store, controller, workspace: '/repo', initial: '' }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
      interactive: true,
    });

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(60);

    // Startup: Header rendered exactly once.
    assert.equal(countOccurrences(written, 'Axiom v0.1'), 1);

    // Chat 1 -> Chat 2 -> Chat 3
    await controller.submit('Chat message 1');
    await wait(50);
    await controller.submit('Chat message 2');
    await wait(50);
    await controller.submit('Chat message 3');
    await wait(50);

    assert.equal(store.getSnapshot().entries.length, 3);
    assert.equal(store.getSnapshot().error, null);
    assert.equal(countOccurrences(written, 'Axiom v0.1'), 1);

    // /help command
    await controller.submit('/help');
    await wait(50);
    assert.equal(store.getSnapshot().entries.length, 4);
    assert.match(written, /Show commands and how to use them/);
    assert.equal(countOccurrences(written, 'Axiom v0.1'), 1);

    // /model transient menu -> select model -> closes without adding transcript entry or duplicate header
    const modelMenu = store.openMenu({
      kind: 'model',
      title: 'Chọn model cho phiên làm việc',
      items: [
        { value: 'google/gemini-3.1-flash-lite', label: 'google/gemini-3.1-flash-lite', description: 'Flash Lite' },
        { value: 'openrouter/qwen3-coder', label: 'openrouter/qwen3-coder', description: 'Qwen 3 Coder' },
      ],
    });
    store.flush();
    await wait(50);
    stdin.write('\u001b[B'); // Down arrow
    await wait(30);
    stdin.write('\r'); // Enter
    const selectedModel = await modelMenu;
    assert.equal(selectedModel, 'openrouter/qwen3-coder');
    store.flush();
    await wait(50);
    assert.equal(store.getSnapshot().menu, null);
    assert.equal(store.getSnapshot().entries.length, 4);
    assert.equal(countOccurrences(written, 'Axiom v0.1'), 1);

    // /login transient menu -> Esc cancel -> closes cleanly
    const loginPromise = controller.submit('/login');
    await wait(50);
    assert.equal(store.getSnapshot().menu?.kind, 'login');
    stdin.write('\u001b'); // Esc
    await loginPromise;
    await wait(50);
    assert.equal(store.getSnapshot().menu, null);
    assert.equal(countOccurrences(written, 'Axiom v0.1'), 1);

    // Terminal resize (narrow + short, then wide)
    stdout.columns = 68;
    stdout.rows = 18;
    stdout.emit('resize');
    await wait(50);
    stdout.columns = 110;
    stdout.rows = 32;
    stdout.emit('resize');
    await wait(50);
    assert.equal(countOccurrences(written, 'Axiom v0.1'), 1);

    // Chat 4 after /help, /model, /login, and resize
    await controller.submit('Chat message 4');
    await wait(50);
    assert.equal(store.getSnapshot().entries.length, 5);
    assert.equal(store.getSnapshot().entries[4]?.prompt, 'Chat message 4');
    assert.equal(countOccurrences(written, 'Axiom v0.1'), 1);

    // /clear command -> clears entries in state without re-emitting a second Welcome/Header
    await controller.submit('/clear');
    await wait(50);
    assert.equal(store.getSnapshot().entries.length, 0);
    assert.equal(countOccurrences(written, 'Axiom v0.1'), 1);

    // /help after /clear -> prints help output cleanly without duplicating Header
    await controller.submit('/help');
    await wait(50);
    assert.equal(store.getSnapshot().entries.length, 1);
    assert.equal(countOccurrences(written, 'Axiom v0.1'), 1);

    // Verify no state-machine console.error occurred at any point
    assert.equal(
      consoleErrors.filter((line) => line.includes('Invalid state transition')).length,
      0,
    );

    app.unmount();
    store.dispose();

    // Restart app in a new session -> renders Welcome/Header once for the new session
    const stdout2 = fakeTty(90, 24);
    let written2 = '';
    stdout2.on('data', (chunk: Buffer) => { written2 += chunk.toString(); });
    const store2 = new TuiStore();
    const controller2 = new TuiController(store2, { workspaceRoot: process.cwd(), mock: true });
    const app2 = render(createElement(App, { store: store2, controller: controller2, workspace: '/repo', initial: '' }), {
      stdout: stdout2 as unknown as NodeJS.WriteStream,
      stdin: fakeTty(90, 24) as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
      interactive: true,
    });
    await wait(60);
    assert.equal(countOccurrences(written2, 'Axiom v0.1'), 1);
    app2.unmount();
    store2.dispose();
  } finally {
    console.error = origConsoleError;
  }
});

test('fullscreen alternateScreen mode enters alternate buffer on mount and restores on unmount', async () => {
  const stdout = fakeTty();
  let written = '';
  stdout.on('data', (chunk: Buffer) => { written += chunk.toString(); });
  const store = new TuiStore();
  const controller = { submit: async () => {}, interrupt() {}, abort() {}, lastPrompt: '' } as unknown as TuiController;
  const app = render(createElement(App, { store, controller, workspace: '/repo', initial: '' }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeTty() as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
    interactive: true,
    alternateScreen: true,
  });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.match(written, /\x1b\[\?1049h/);
  app.unmount();
  assert.match(written, /\x1b\[\?1049l/);
  store.dispose();
});

test('typing partial slash command shows vertical completions and Enter auto-matches first suggestion', async () => {
  const stdout = fakeTty(90, 24);
  const stdin = fakeTty(90, 24);
  let written = '';
  stdout.on('data', (chunk: Buffer) => { written += chunk.toString(); });
  const store = new TuiStore();
  let submitted = '';
  const controller = {
    submit: async (input: string) => { submitted = input; },
    interrupt() {},
    abort() {},
    lastPrompt: '',
  } as unknown as TuiController;

  const app = render(createElement(App, { store, controller, workspace: '/repo', initial: '' }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
    interactive: true,
  });

  try {
    await wait(60);
    // Type /mo
    stdin.write('/mo');
    await wait(60);

    // Assert vertical completions are rendered
    assert.match(written, /→ model/);
    assert.match(written, /models/);
    assert.match(written, /\(1\/2\)/);

    // Press Enter on /mo
    stdin.write('\r');
    await wait(60);

    // Enter should have auto-matched /model instead of sending raw /mo
    assert.equal(submitted, '/model');

    // Now test Down arrow selection
    stdin.write('/mo');
    await wait(60);
    stdin.write('\u001b[B'); // Down arrow -> selects `models`
    await wait(60);
    stdin.write('\r'); // Enter
    await wait(60);
    assert.equal(submitted, '/models');
  } finally {
    app.unmount();
    store.dispose();
  }
});



