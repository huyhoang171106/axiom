// tests/tui-approval-fixtures.test.ts - Verify prepared C7 fixtures against the real parser and policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../src/tools/apply-patch.js';
import { decide } from '../src/tools/permissions.js';
import { LONG_APPROVAL_PATCH, MULTI_FILE_APPROVAL_PATCH } from './fixtures/approval-patches.js';
test('C7 approval fixtures are real long and multi-file patches requiring approval', () => {
  assert.equal(parseUnifiedDiff(LONG_APPROVAL_PATCH).length, 1);
  assert.ok(LONG_APPROVAL_PATCH.split('\n').length > 30);
  assert.ok(LONG_APPROVAL_PATCH.includes('FINAL-DIFF-LINE'));
  assert.equal(parseUnifiedDiff(MULTI_FILE_APPROVAL_PATCH).length, 6);
  for (const patch of [LONG_APPROVAL_PATCH, MULTI_FILE_APPROVAL_PATCH]) assert.equal(decide('apply_patch', { patch }, process.cwd()).verdict, 'ask');
});
import { renderToString } from 'ink';
import { createElement } from 'react';
import { ApprovalDialog } from '../src/tui/components/approval-dialog.js';
import { visibleWidth } from '../src/tui/layout.js';
for (const risk of ['low', 'medium', 'high'] as const) test(`approval risk ${risk} and all controls fit at 80 columns`, () => {
  const output = renderToString(createElement(ApprovalDialog, { approval: { name: 'apply_patch', args: { patch: LONG_APPROVAL_PATCH }, reason: 'reason '.repeat(40), risk }, width: 80 }), { columns: 80 });
  assert.match(output, new RegExp(`Risk: ${risk}`));
  for (const key of ['[y]', '[n / Enter]', '[e]']) assert.ok(output.includes(key));
  assert.ok(output.split('\n').every(line => visibleWidth(line) <= 80));
});
