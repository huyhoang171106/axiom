import test from 'node:test';
import assert from 'node:assert/strict';
import { costCommand } from '../src/commands/cost.js';
import type { CommandContext } from '../src/commands/types.js';
import { CostTracker } from '../src/llm/cost-tracker.js';

const ctx = (costTracker: CostTracker) => ({ costTracker }) as CommandContext;

test('cost reads only the current session without mutating it', async () => {
  const tracker = new CostTracker();
  const empty = await costCommand.run('', ctx(tracker));
  assert.match(empty!.text, /Session: input 0, output 0, total 0, \$0.000000/);
  tracker.record('one', { promptTokens: 10, completionTokens: 2, totalTokens: 12, costEstimate: 0 });
  tracker.record('one', { promptTokens: 3, completionTokens: 4, totalTokens: 7, costEstimate: 0.1 });
  tracker.record('two', { promptTokens: 5, completionTokens: 1, totalTokens: 6, costEstimate: 0.2 });
  const before = tracker.getSessionSummary();
  const result = await costCommand.run('', ctx(tracker));
  assert.match(result!.text, /one: input 13, output 6, \$0.100000/);
  assert.match(result!.text, /two: input 5, output 1, \$0.200000/);
  assert.match(result!.text, /Session: input 18, output 7, total 25, \$0.300000/);
  assert.deepEqual(await costCommand.run('', ctx(tracker)), result);
  assert.deepEqual(tracker.getSessionSummary(), before);
  assert.doesNotMatch((await costCommand.run('', ctx(new CostTracker())))!.text, /one:/);
  before.byModel.one.promptTokens = 999;
  assert.equal(tracker.getSessionSummary().byModel.one.promptTokens, 13);
  tracker.reset();
  assert.deepEqual(tracker.getSessionSummary().byModel, {});
});

test('invalid usage does not poison summary and explicit zero is retained', () => {
  const tracker = new CostTracker();
  tracker.record('one', { promptTokens: NaN, completionTokens: Infinity, totalTokens: -1, costEstimate: 0 });
  assert.equal(tracker.getSessionSummary().totalCost, 0);
  assert.equal(tracker.getSessionSummary().totalTokens, 0);
});
