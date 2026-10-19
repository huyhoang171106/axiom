// tests/tui-telemetry.test.ts - Footer and per-turn telemetry calculations (E5)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { EventBus } from '../src/core/event-bus.js';
import { TuiStore, type TuiState } from '../src/tui/store.js';
import { GitStatusCache } from '../src/tui/git-status.js';
import { Footer } from '../src/tui/components/footer.js';
import {
  computeTelemetry, contextBar, fitFooterLine, footerLeftSegments, footerUsageText, formatTelemetryLine,
  formatTokens, parseGitStatus, visibleWidth, MISSING,
} from '../src/tui/layout.js';

test('TTFT is first token minus send; TPS excludes tool time', () => {
  const t = computeTelemetry({ sentAt: 1000, firstTokenAt: 2200, endAt: 6200, toolMs: 2000 }, 84);
  assert.equal(t.ttftMs, 1200);
  assert.equal(t.durationMs, 5200);
  assert.equal(t.tps, 42); // 84 tokens over (4000 - 2000) ms
});

test('missing timing or tokens yields null, rendered as a dash not 0', () => {
  const t = computeTelemetry({ sentAt: 0, endAt: 500, toolMs: 0 }, 10);
  assert.deepEqual(t, { ttftMs: null, tps: null, durationMs: 500 });
  assert.equal(computeTelemetry({ sentAt: 0, firstTokenAt: 10, endAt: 20, toolMs: 50 }, 5).tps, null);
  const line = formatTelemetryLine(t, null);
  assert.match(line, /TPS —/);
  assert.match(line, /TTFT —/);
  assert.ok(!/\b0 tok/.test(line));
  assert.equal(formatTokens(undefined), MISSING);
});

test('telemetry line matches the guide format', () => {
  const line = formatTelemetryLine({ ttftMs: 1200, tps: 42, durationMs: 29_700 }, { promptTokens: 5600, completionTokens: 1200, costEstimate: 0.004 });
  assert.equal(line, '> TPS 42 tok/s | TTFT 1.2s | 29.7s | ↑ 5.6k | ↓ 1.2k | $0.004');
});

test('context bar uses contextWindow and warns from 60%', () => {
  const low = contextBar(12_000, 252_000);
  assert.match(low.text, /^\[█░{8}\] 4\.8% · 12k\/252k$/);
  assert.equal(low.warn, false);
  assert.equal(contextBar(60, 100).warn, true);
  assert.equal(contextBar(59, 100).warn, false);
  const missing = contextBar(null, 252_000);
  assert.equal(missing.ratio, null);
  assert.match(missing.text, /—/);
  assert.equal(contextBar(10, 0).ratio, null);
  assert.match(contextBar(500, 100).text, /^\[█{9}\]/);
});

test('git porcelain v2 parsing and footer cut order keeps the right side', () => {
  const git = parseGitStatus([
    '# branch.oid 0123456789abcdef', '# branch.head main',
    '1 .M N... 100644 100644 100644 a b src/a.ts', '1 M. N... 100644 100644 100644 a b src/b.ts', '? new.txt', '',
  ].join('\n'));
  assert.deepEqual(git, { branch: 'main', commit: '0123456', changed: 2, untracked: 1 });
  assert.equal(parseGitStatus('# branch.oid (initial)\n# branch.head (detached)').branch, null);
  const left = footerLeftSegments('/home/u/nhom-30/workspace/tinydb', git);
  const right = '[█░░░░░░░░] 4.7% · 12k/252k';
  const wide = fitFooterLine(left, right, 120);
  assert.match(wide, /tinydb main \[!2 \?1\] 0123456/);
  const mid = fitFooterLine(left, right, 70);
  assert.ok(!mid.includes('0123456'), 'commit is cut first');
  assert.match(mid, /main/);
  const narrow = fitFooterLine(left, right, 40);
  assert.ok(narrow.endsWith(right));
  assert.equal(visibleWidth(narrow), 40);
});

test('usage text splits uncached and cache-read input', () => {
  assert.equal(footerUsageText({ promptTokens: 36_000, completionTokens: 69, costEstimate: 0.041, cacheReadInputTokens: 31_000 }), '↑36k (U 5k + R 31k) ↓69 $0.041');
  assert.equal(footerUsageText(null), `↑${MISSING} ↓${MISSING} ${MISSING}`);
});

test('store records telemetry from mocked clock, excluding tool time', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const store = new TuiStore();
  t.after(() => store.dispose());
  const bus = new EventBus();
  store.attach(bus);
  store.prepareTurn('hi');
  bus.emit('state_change', { from: 'idle', to: 'executing' });
  t.mock.timers.tick(1000);
  bus.emit('stream_token', { delta: 'a' });
  t.mock.timers.tick(500);
  bus.emit('tool_call_start', { id: 't1', name: 'read_file', arguments: {} });
  t.mock.timers.tick(3000);
  bus.emit('tool_call_end', { toolCallId: 't1', name: 'read_file', output: '' });
  t.mock.timers.tick(500);
  bus.emit('cost_update', { promptTokens: 100, completionTokens: 50, totalTokens: 150, costEstimate: 0.001 });
  bus.emit('state_change', { from: 'executing', to: 'completed' });
  t.mock.timers.tick(34);
  const turn = store.getSnapshot().entries.at(-1)!;
  assert.equal(turn.telemetry?.ttftMs, 1000);
  assert.equal(turn.telemetry?.durationMs, 5000);
  assert.equal(turn.telemetry?.tps, 50); // 50 tokens over (4000 - 3000) ms
});

test('git cache refreshes after writing tools only and survives git failures', async () => {
  let runs = 0;
  const seen: unknown[] = [];
  const cache = new GitStatusCache('/x', s => seen.push(s), async () => { runs++; return '# branch.head dev\n'; });
  assert.equal((await cache.refresh())?.branch, 'dev');
  const bus = new EventBus();
  cache.attach(bus);
  bus.emit('tool_call_end', { toolCallId: '1', name: 'read_file', output: '' });
  bus.emit('tool_call_end', { toolCallId: '2', name: 'write_file', output: '' });
  await cache.refresh();
  assert.equal(runs, 2);
  const failing = new GitStatusCache('/x', s => seen.push(s), async () => { throw new Error('not a repo'); });
  assert.equal(await failing.refresh(), null);
});

for (const columns of [80, 120]) test(`footer renders two lines within ${columns} columns`, () => {
  const state = {
    usage: { latest: { promptTokens: 160_000, completionTokens: 1, totalTokens: 1, costEstimate: 0 }, total: null },
    model: { provider: 'openrouter', id: 'qwen3-coder', contextWindow: 252_000 }, mode: 'edit',
    git: { branch: 'main', commit: 'abc1234', changed: 1, untracked: 0 },
  } as unknown as TuiState;
  const out = renderToString(createElement(Footer, { state, workspace: 'D:/nhom-30/workspace/tinydb', width: columns }), { columns });
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => visibleWidth(line) <= columns));
  assert.match(lines[0], /63\.5% · 160k\/252k/);
  assert.match(lines[1], /openrouter qwen3-coder edit/);
});
