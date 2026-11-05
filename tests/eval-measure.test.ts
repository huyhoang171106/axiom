// tests/eval-measure.test.ts - Kiểm phép đo từng case độc lập, kể cả workflow thất bại.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { measureCase } from '../evals/measure.js';
import { registerSecret } from '../src/core/secrets.js';
import { CostTracker, defaultCostTracker } from '../src/llm/cost-tracker.js';

// Dùng usage giả có cost tường minh; không phụ thuộc bảng giá hay gọi model thật.
function recordUsage(tracker: CostTracker, prompt: number, completion: number, cost: number, model = 'test-chat'): void {
  tracker.record(model, { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, costEstimate: cost });
}

test('measureCase returns the value and measures the complete async callback', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const value = { completed: true };
  const measured = await measureCase('case-success', async tracker => {
    recordUsage(tracker, 10, 4, 0.02);
    // Clock giả giúp kiểm đúng cả đoạn await mà không cần sleep dễ chập chờn.
    now = 107;
    await Promise.resolve();
    now = 125;
    return value;
  });
  assert.equal(measured.value, value);
  assert.equal(measured.tokens, 14);
  assert.equal(measured.costDollars, 0.02);
  assert.equal(measured.latencyMs, 25);
  assert.equal('error' in measured, false);
});

test('measureCase sums chat, embedding and compaction usage through the same tracker', async () => {
  const measured = await measureCase('case-multi-model', async tracker => {
    recordUsage(tracker, 20, 5, 0.03);
    recordUsage(tracker, 8, 0, 0.002, 'test-embed');
    recordUsage(tracker, 6, 2, 0.004, 'test-compact');
    return 'done';
  });
  assert.equal(measured.tokens, 41);
  assert.equal(measured.costDollars, 0.036);
});

test('measureCase uses prompt plus completion without adding cached tokens again', async () => {
  const measured = await measureCase('case-cache', async tracker => {
    // totalTokens cố tình khác tổng vào/ra để bắt việc dùng nhầm field tổng của provider.
    tracker.record('test-chat', { promptTokens: 10, completionTokens: 2, totalTokens: 999,
      cacheReadInputTokens: 4, costEstimate: 0.01 });
  });
  assert.equal(measured.tokens, 12);
  assert.equal(measured.costDollars, 0.01);
});

test('measureCase preserves spent usage and latency when the callback rejects', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const measured = await measureCase('case-failed', async tracker => {
    recordUsage(tracker, 7, 3, 0.015);
    now = 40;
    await Promise.resolve();
    throw new Error('verification failed');
  });
  assert.equal(measured.tokens, 10);
  assert.equal(measured.costDollars, 0.015);
  assert.equal(measured.latencyMs, 40);
  assert.match(measured.error!, /case-failed.*verification failed/);
  assert.equal('value' in measured, false);
});

test('measureCase reports a failure before model use rather than a successful zero-cost result', async () => {
  const measured = await measureCase('case-no-provider', async () => { throw new Error('provider unavailable'); });
  assert.equal(measured.tokens, 0);
  assert.equal(measured.costDollars, 0);
  assert.match(measured.error!, /case-no-provider.*provider unavailable/);
  assert.equal('value' in measured, false);
});

for (const thrown of ['non-Error rejection', new Error(''), undefined]) {
  test(`measureCase keeps a non-empty error for ${thrown instanceof Error ? 'an empty Error' : String(thrown)}`, async () => {
    const measured = await measureCase('case-error-shape', async () => { throw thrown; });
    assert.match(measured.error!, /case-error-shape: \S/);
    assert.equal('value' in measured, false);
  });
}

test('measureCase redacts secrets in both the case id and error message', async () => {
  // Giá trị nhạy cảm giả sinh trong test, không có key thật trong source hoặc artifact.
  const sensitive = `measurement-${randomUUID()}`;
  registerSecret(sensitive);
  const measured = await measureCase(`case-${sensitive}`, async () => { throw new Error(`cannot use ${sensitive}`); });
  assert.ok(measured.error && !measured.error.includes(sensitive));
  assert.match(measured.error, /redacted/);
});

test('measureCase isolates overlapping cases without resetting the session tracker', async t => {
  defaultCostTracker.record('outside-case', { promptTokens: 100, completionTokens: 1, totalTokens: 101, costEstimate: 2 });
  const sessionBefore = defaultCostTracker.getSessionSummary();
  t.after(() => defaultCostTracker.reset());
  const trackers: CostTracker[] = [];
  let resumeFirst!: () => void;
  const pending = new Promise<void>(resolve => { resumeFirst = resolve; });
  const first = measureCase('first', async tracker => {
    trackers.push(tracker);
    recordUsage(tracker, 10, 1, 0.01);
    await pending;
    recordUsage(tracker, 2, 1, 0.005);
    return 'first value';
  });
  const second = await measureCase('second', async tracker => {
    trackers.push(tracker);
    assert.equal(tracker.getSessionSummary().totalTokens, 0);
    recordUsage(tracker, 20, 2, 0.02);
    resumeFirst();
    return 'second value';
  });
  const firstResult = await first;
  assert.notEqual(trackers[0], trackers[1]);
  assert.equal(firstResult.tokens, 14);
  assert.equal(firstResult.costDollars, 0.015);
  assert.equal(second.tokens, 22);
  assert.equal(second.costDollars, 0.02);
  assert.deepEqual(defaultCostTracker.getSessionSummary(), sessionBefore);
});
