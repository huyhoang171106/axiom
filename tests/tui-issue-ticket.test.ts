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

test('renders every list item and marks empty lists', () => {
  const full: IssueTicket = {
    ...ticket,
    affected_files: ['src/main.ts', 'src/app.ts'],
    reproduction_steps: ['Start the CLI', 'Run the command'],
    acceptance_criteria: ['The CLI starts', 'The command succeeds'],
    missing_info: [],
  };
  const output = renderToString(createElement(IssueTicketView, {
    ticket: full, warnings: [], width: 80, workspaceRoot: '/workspace',
  }), { columns: 80 });
  for (const label of ['affected_files', 'reproduction_steps', 'acceptance_criteria', 'missing_info']) {
    assert.ok(output.includes(label), `missing label ${label}`);
  }
  for (const value of [...full.affected_files, ...full.reproduction_steps, ...full.acceptance_criteria]) {
    assert.ok(output.includes(value), `missing item ${value}`);
  }
  assert.match(output, /missing_info\s+—/);
  assert.ok(output.split('\n').every((line) => visibleWidth(line) <= 80));
});
