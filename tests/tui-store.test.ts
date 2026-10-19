// tests/tui-store.test.ts - TUI state, batching and EventBus subscription contracts

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.js';
import type { TokenUsage, ToolCall, ToolResult } from '../src/core/types.js';
import { TuiStore } from '../src/tui/store.js';

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const bus = new EventBus();
  const store = new TuiStore();
  const detach = store.attach(bus);
  t.after(detach);
  return { bus, store, detach, frame: () => t.mock.timers.tick(34) };
}

function start(bus: EventBus) {
  bus.emit('state_change', { from: 'idle', to: 'failed', reason: 'reset' });
  bus.emit('state_change', { from: 'failed', to: 'analyzing', reason: 'New task' });
  bus.emit('state_change', { from: 'analyzing', to: 'executing' });
}

const firstUsage: TokenUsage = {
  promptTokens: 10, completionTokens: 2, totalTokens: 12, costEstimate: 0.01, cacheReadInputTokens: 3,
};

test('snapshots are stable, stream deltas batch, and previous snapshots never change', (t) => {
  const { bus, store, frame } = setup(t);
  const { getSnapshot, subscribe } = store;
  const initial = getSnapshot();
  assert.equal(getSnapshot(), initial);
  assert.equal(initial.live, null);
  assert.deepEqual(initial.entries, []);
  assert.deepEqual(initial.usage, { latest: null, total: null });
  assert.equal(initial.model, null);
  assert.equal(initial.mode, 'edit');
  assert.equal(initial.pendingApproval, null);
  let notifications = 0;
  subscribe(() => notifications++);

  start(bus);
  for (const delta of ['Xin', ' ', 'chào', ' 👋']) bus.emit('stream_token', { delta });
  bus.emit('thinking', { delta: 'Đọc ' });
  bus.emit('thinking', { delta: 'repo' });
  assert.equal(getSnapshot(), initial);
  assert.equal(notifications, 0);
  frame();
  const liveSnapshot = getSnapshot();
  assert.equal(notifications, 1);
  assert.notEqual(liveSnapshot, initial);
  assert.equal(liveSnapshot.live?.text, 'Xin chào 👋');
  assert.equal(liveSnapshot.live?.thinking, 'Đọc repo');
  assert.equal(liveSnapshot.live?.status, 'executing');
  assert.deepEqual(liveSnapshot.entries, []);
  assert.equal(initial.live, null);

  bus.emit('stream_token', { delta: '!' });
  frame();
  assert.equal(getSnapshot().live?.text, 'Xin chào 👋!');
  assert.equal(liveSnapshot.live?.text, 'Xin chào 👋');
  const unchanged = getSnapshot();
  bus.emit('stream_token', { delta: '' });
  bus.emit('thinking', { delta: '' });
  bus.emit('state_change', { from: 'executing', to: 'executing' });
  frame();
  assert.equal(getSnapshot(), unchanged);
  assert.equal(notifications, 2);
});

test('mixed events notify at most 30 times per second without losing the trailing token', (t) => {
  const { bus, store } = setup(t);
  const times: number[] = [];
  store.subscribe(() => times.push(Date.now()));
  start(bus);
  for (let i = 0; i < 1000; i++) {
    bus.emit('stream_token', { delta: 'x' });
    bus.emit('thinking', { delta: '.' });
    if (i % 10 === 0) bus.emit('cost_update', firstUsage);
    t.mock.timers.tick(1);
  }
  assert.ok(times.length > 0 && times.length <= 30);
  t.mock.timers.tick(34);
  assert.ok(times.every((time, i) => i === 0 || time - times[i - 1] >= 1000 / 30));
  assert.equal(store.getSnapshot().live?.text, 'x'.repeat(1000));
  assert.equal(store.getSnapshot().live?.thinking, '.'.repeat(1000));
  assert.equal(store.getSnapshot().usage.total?.totalTokens, 1200);
  const count = times.length;
  t.mock.timers.tick(1000);
  assert.equal(times.length, count);
});

test('tool results match call IDs even out of order and retain policy metadata', (t) => {
  const { bus, store, frame } = setup(t);
  start(bus);
  const call: ToolCall = { id: 'a', name: 'read_file', arguments: { path: 'a.ts', nested: { value: 1 } } };
  bus.emit('tool_call_start', call);
  bus.emit('tool_call_start', { id: 'b', name: 'run_command', arguments: { command: 'pip install requests' } });
  frame();
  const before = store.getSnapshot();
  const result: ToolResult = {
    toolCallId: 'b', name: 'run_command', output: 'Denied', isError: true,
    metadata: { durationMs: 8, policy: { verdict: 'ask', approval: 'denied' } },
  };
  bus.emit('tool_call_end', result);
  bus.emit('tool_call_end', { toolCallId: 'a', name: 'read_file', output: 'contents' });
  (call.arguments.nested as { value: number }).value = 99;
  (result.metadata!.policy as { verdict: string }).verdict = 'allow';
  frame();
  const rows = store.getSnapshot().live!.tools;
  assert.deepEqual(rows.map((row) => [row.call.id, row.result?.output]), [['a', 'contents'], ['b', 'Denied']]);
  assert.deepEqual(rows[0].call.arguments.nested, { value: 1 });
  assert.deepEqual(rows[1].result?.metadata, { durationMs: 8, policy: { verdict: 'ask', approval: 'denied' } });
  assert.equal(rows[1].result?.isError, true);
  assert.ok(before.live!.tools.every((row) => row.result === null));
  const snapshot = store.getSnapshot();
  bus.emit('tool_call_end', { toolCallId: 'unknown', name: 'read_file', output: 'ignored' });
  frame();
  assert.equal(store.getSnapshot(), snapshot);
});

test('usage distinguishes the latest model call, turn total and session total', (t) => {
  const { bus, store, frame } = setup(t);
  start(bus);
  bus.emit('cost_update', firstUsage);
  const second: TokenUsage = {
    promptTokens: 20, completionTokens: 4, totalTokens: 24, costEstimate: 0.02, cacheCreationInputTokens: 5,
  };
  bus.emit('cost_update', second);
  bus.emit('state_change', { from: 'executing', to: 'completed' });
  frame();
  const completed = store.getSnapshot();
  const total = {
    promptTokens: 30, completionTokens: 6, totalTokens: 36, costEstimate: 0.03,
    cacheReadInputTokens: 3, cacheCreationInputTokens: 5,
  };
  assert.deepEqual(completed.usage.latest, second);
  assert.deepEqual(completed.usage.total, total);
  assert.deepEqual(completed.entries[0].usage, total);
  assert.equal(completed.live, null);

  start(bus);
  bus.emit('cost_update', firstUsage);
  frame();
  assert.deepEqual(store.getSnapshot().live?.usage, firstUsage);
  assert.equal(store.getSnapshot().usage.total?.totalTokens, 48);
  assert.equal(store.getSnapshot().entries[0], completed.entries[0]);
  assert.equal(completed.usage.total?.totalTokens, 36);
});

test('complete turns within one frame preserve all text and archive each turn once', (t) => {
  const { bus, store, frame } = setup(t);
  start(bus);
  bus.emit('stream_token', { delta: 'first' });
  bus.emit('state_change', { from: 'executing', to: 'completed' });
  bus.emit('state_change', { from: 'completed', to: 'completed' });
  start(bus);
  bus.emit('stream_token', { delta: 'second' });
  bus.emit('state_change', { from: 'executing', to: 'completed' });
  frame();
  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.entries.map((turn) => [turn.id, turn.text, turn.status]), [
    [1, 'first', 'completed'], [2, 'second', 'completed'],
  ]);
  assert.equal(snapshot.live, null);
  assert.equal(snapshot.status, 'completed');
});

test('failed turns keep partial output and error, and the next turn starts cleanly', (t) => {
  t.mock.method(console, 'error', () => {});
  const { bus, store, frame } = setup(t);
  start(bus);
  bus.emit('stream_token', { delta: 'partial' });
  bus.emit('error', { message: 'Task aborted via AbortSignal' });
  bus.emit('state_change', { from: 'executing', to: 'failed', reason: 'Task aborted via AbortSignal' });
  frame();
  const failed = store.getSnapshot();
  assert.equal(failed.entries[0].text, 'partial');
  assert.equal(failed.entries[0].error, 'Task aborted via AbortSignal');
  assert.equal(failed.entries[0].status, 'failed');
  assert.equal(failed.live, null);
  start(bus);
  frame();
  assert.equal(store.getSnapshot().error, null);
  assert.equal(store.getSnapshot().live?.error, null);
  assert.equal(store.getSnapshot().entries[0], failed.entries[0]);
});

test('detach preserves received tokens and does not remove other EventBus listeners', (t) => {
  const { bus, store, detach, frame } = setup(t);
  let otherCalls = 0;
  bus.on('stream_token', () => otherCalls++);
  bus.emit('stream_token', { delta: 'kept' });
  detach();
  detach();
  bus.emit('stream_token', { delta: 'ignored' });
  frame();
  assert.equal(store.getSnapshot().live?.text, 'kept');
  assert.equal(otherCalls, 2);
  const snapshot = store.getSnapshot();
  bus.emit('cost_update', firstUsage);
  frame();
  assert.equal(store.getSnapshot(), snapshot);
});

test('reattaching does not duplicate events and old cleanup cannot detach the new listener', (t) => {
  const { bus, store, detach, frame } = setup(t);
  const detachAgain = store.attach(bus);
  t.after(detachAgain);
  detach();
  bus.emit('stream_token', { delta: 'once' });
  frame();
  assert.equal(store.getSnapshot().live?.text, 'once');

  const nextBus = new EventBus();
  t.after(store.attach(nextBus));
  bus.emit('stream_token', { delta: 'old' });
  nextBus.emit('stream_token', { delta: ' next' });
  frame();
  assert.equal(store.getSnapshot().live?.text, 'once next');
});

test('unsubscribe stops callbacks without stopping updates or another subscriber', (t) => {
  const { bus, store, frame } = setup(t);
  let calls = 0;
  const listener = () => calls++;
  const unsubscribe = store.subscribe(listener);
  const unsubscribeOther = store.subscribe(listener);
  unsubscribe();
  unsubscribe();
  bus.emit('stream_token', { delta: 'a' });
  frame();
  assert.equal(calls, 1);
  unsubscribeOther();
  bus.emit('stream_token', { delta: 'b' });
  frame();
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot().live?.text, 'ab');
});
