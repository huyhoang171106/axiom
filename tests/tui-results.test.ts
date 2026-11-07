// tests/tui-results.test.ts - Structured reports preserve workflow details.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resultText } from '../src/tui/results.js';
test('feature result retains thread and step status, malformed data falls back', () => {
  assert.match(resultText('feature-report', { status: 'failed', summary: 'Stopped', filesChanged: ['a.py'], threadId: 'feature-1', steps: [{ id: 1, title: 'Implement', status: 'done' }] })!, /Thread: feature-1\n1. \[done\] Implement/);
  assert.equal(resultText('feature-report', {}), undefined);
  assert.equal(resultText('unknown', {}), undefined);
});
test('audit result preserves decision and actor order', () => {
  assert.equal(resultText('audit', [{ at: 'now', tool: 'run_command', args: { command: 'pip install x' }, risk: 'medium', decision: 'reject', approver: 'user' }]), 'now run_command\nmedium | reject | user\n{"command":"pip install x"}');
});
