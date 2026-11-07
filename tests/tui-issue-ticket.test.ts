// tests/tui-issue-ticket.test.ts - Kiểm tra bảng IssueTicket bằng Ink.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'ink';
import type { IssueTicket } from '../src/agents/triage.js';
import { IssueTicketView } from '../src/tui/components/issue-ticket.js';
import { visibleWidth } from '../src/tui/layout.js';

const ticket: IssueTicket = {
  type: 'bug',
  priority: 'P1 - CLI crashes',
  route: 'fix',
  affected_files: [],
  reproduction_steps: [],
  acceptance_criteria: ['The CLI starts'],
  missing_info: [],
};

for (const width of [80, 120]) test(`renders ticket classification in two columns at ${width} columns`, () => {
  const output = renderToString(createElement(IssueTicketView, {
    ticket, warnings: [], width, workspaceRoot: '/workspace',
  }), { columns: width });
  for (const [label, value] of [['type', 'bug'], ['priority', 'P1 - CLI crashes'], ['route', 'fix']]) {
    assert.match(output, new RegExp(`${label}\\s+${value}`));
  }
  assert.ok(output.split('\n').every((line) => visibleWidth(line) <= width));
});
