// tests/tui-controller.test.ts - Commands and human decisions through the TUI contracts
import test from 'node:test';
import assert from 'node:assert/strict';
import { TuiStore } from '../src/tui/store.js';
import { TuiController } from '../src/tui/controller.js';

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
