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

import { approvalPreview } from '../src/tui/approval-preview.js';
import { ToolRow } from '../src/tui/components/tool-row.js';
test('replacement previews describe the snippet and expanded proposed patches show every line', () => {
  const args = { path: 'file.py', oldText: 'old', newText: 'new', replaceAll: true, lineRange: '10-20' };
  assert.match(approvalPreview('edit', args)!, /Replacement snippet: file.py/);
  assert.match(approvalPreview('edit', args)!, /replaceAll=true; range=10-20/);
  assert.match(approvalPreview('edit', args)!, /-old\n\+new/);
  for (const width of [80, 120]) {
    const approval = { name: 'apply_patch', args: { patch: LONG_APPROVAL_PATCH }, reason: 'patch', risk: 'high' as const };
    const collapsed = renderToString(createElement(ApprovalDialog, { approval, width }), { columns: width });
    assert.equal(collapsed.includes('FINAL-DIFF-LINE'), false);
    const expanded = renderToString(createElement(ApprovalDialog, { approval, width, expanded: true }), { columns: width });
    assert.ok(expanded.includes('FINAL-DIFF-LINE'));
    assert.ok(expanded.split('\n').every(line => visibleWidth(line) <= width));
    const draft = renderToString(createElement(ApprovalDialog, { approval, width, draft: JSON.stringify({ patch: '+EDITED-PREVIEW' }) }), { columns: width });
    assert.ok(draft.includes('+EDITED-PREVIEW')); assert.equal(draft.includes('FINAL-DIFF-LINE'), false);
    const row = { call: { id: 'patch', name: 'apply_patch', arguments: approval.args }, result: null };
    assert.ok(renderToString(createElement(ToolRow, { row, width, expanded: true }), { columns: width }).includes('FINAL-DIFF-LINE'));
  }
});
