// tests/tui-modes.test.ts - Slash command, phím tắt và footer cùng phản ánh quyền registry phiên.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createElement } from 'react';
import { render, renderToString } from 'ink';
import { TuiController } from '../src/tui/controller.js';
import { TuiStore } from '../src/tui/store.js';
import { App } from '../src/tui/app.js';
import { Footer } from '../src/tui/components/footer.js';
import { visibleWidth } from '../src/tui/layout.js';
import { defaultCommandRouter } from '../src/commands/index.js';
import { READ_ONLY_TOOLS } from '../src/tools/permissions.js';
import type { CommandContext } from '../src/commands/types.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await pause();
  assert.ok(predicate(), 'UI state must settle');
}
function setup(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-modes-'));
  const previous = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(root, 'home');
  t.after(() => {
    if (previous === undefined) delete process.env.AXIOM_HOME; else process.env.AXIOM_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const tty = (columns: number) => Object.assign(new PassThrough(), { columns, rows: 30, isTTY: true, setRawMode() {}, ref() {}, unref() {} });

test('first slash mode, plan, Shift+Tab and clear share one registry and preserve denials', async t => {
  const root = setup(t); const store = new TuiStore();
  const controller = new TuiController(store, { workspaceRoot: root, mock: true });
  const stdin = tty(80); let ctx: CommandContext | undefined;
  defaultCommandRouter.register({ name: 'mode-probe', summary: '', usage: '', async run(args, context) {
    ctx = context;
    if (args) await context.tools.executeTool('run_command', { command: args }, context);
  } });
  const app = render(createElement(App, { store, controller, workspace: root, initial: '' }), {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: tty(80) as unknown as NodeJS.WriteStream,
    patchConsole: false, exitOnCtrlC: false, interactive: true,
  });
  try {
    await controller.submit('/mode read-only'); await controller.submit('/mode-probe');
    const original = ctx!.tools;
    assert.equal(store.getSnapshot().mode, 'read-only');
    assert.deepEqual(original.getDefinitions().map(t => t.name).sort(), [...READ_ONLY_TOOLS].sort());
    for (const name of ['fix', 'feature', 'resume']) {
      const command = defaultCommandRouter.get(name)!; const run = command.run;
      let invoked = false;
      command.run = async () => { invoked = true; throw new Error('must not dispatch'); };
      try {
        await controller.submit(`/${name} fixture`);
        assert.equal(invoked, false);
        assert.match(store.getSnapshot().entries.at(-1)!.text, /requires edit mode/);
      } finally { command.run = run; }
    }
    await controller.submit('/plan'); await controller.submit('/plan'); await controller.submit('/plan off');
    assert.equal(store.getSnapshot().mode, 'read-only');
    await pause(); stdin.write('\u001b[Z');
    await until(() => store.getSnapshot().mode === 'edit' && !store.getSnapshot().busy);
    assert.equal(original.permissionMode, 'edit');
    const pending = controller.submit('/mode-probe pip install requests');
    await until(() => !!store.getSnapshot().pendingApproval);
    stdin.write('n'); await pending;
    const denied = original.denied; assert.ok(denied.size > 0);
    await controller.submit('/plan');
    assert.equal(store.getSnapshot().planMode, true);
    for (const width of [80, 120]) {
      const frame = renderToString(createElement(Footer, { state: store.getSnapshot(), workspace: root, width }), { columns: width });
      assert.match(frame, /read-only \(plan\)/);
      assert.ok(frame.split('\n').every(line => visibleWidth(line) <= width));
    }
    await controller.submit('/mode auto');
    assert.equal(store.getSnapshot().mode, 'read-only'); assert.equal(store.getSnapshot().planMode, true);
    await controller.submit('/mode edit'); await controller.submit('/plan off'); await controller.submit('/clear');
    await controller.submit('/mode-probe python3 -m pip install requests');
    assert.equal(ctx!.tools, original); assert.equal(original.denied, denied);
    assert.equal(store.getSnapshot().pendingApproval, null);
    assert.equal(store.getSnapshot().mode, 'edit'); assert.equal(store.getSnapshot().planMode, false);
  } finally { controller.abort(); app.unmount(); store.dispose(); }
});

test('headless mode and plan use the same commands without a provider or automatic approval', t => {
  const root = setup(t);
  for (const [name, args, mode, planning] of [['mode', 'read-only', 'read-only', false], ['plan', '', 'read-only', true]] as const) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'bin/axiom.ts', name, ...(args ? [args] : []), '--json', '--mock'], {
      cwd: process.cwd(), env: { ...process.env, AXIOM_HOME: path.join(root, name) }, encoding: 'utf8', windowsHide: true, timeout: 20_000,
    });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr + child.stdout);
    assert.deepEqual(JSON.parse(child.stdout), { mode, planMode: planning });
  }
});
