import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolCall } from '../src/core/types.js';
import { issueTicketSchema, runTriage, validateTicket, type IssueTicket } from '../src/agents/triage.js';
import { MockProvider } from '../src/llm/providers/mock.js';

// runTriage stores its throwaway session under axiomHome(); keep it in a temp dir per run.
process.env.AXIOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-home-'));

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-triage-'));
  fs.writeFileSync(path.join(root, 'app.py'), 'def main(): pass\n');
  fs.writeFileSync(path.join(root, 'util.py'), 'X = 1\n');
  return root;
}

function ticket(overrides: Partial<IssueTicket> = {}): IssueTicket {
  return {
    type: 'bug',
    priority: 'P1 - crashes the CLI',
    affected_files: ['app.py'],
    reproduction_steps: ['run the cli'],
    acceptance_criteria: ['cli exits 0'],
    missing_info: [],
    route: 'fix',
    ...overrides,
  };
}

function submitCall(t: IssueTicket, id = 't1'): ToolCall {
  return { id, name: 'submit_issue_ticket', arguments: { ticket: t } };
}

test('the submit tool advertises the IssueTicket schema', async () => {
  const root = workspace();
  const provider = new MockProvider('mock', ['done']);
  await runTriage({ issue: 'anything', workspaceRoot: root, provider, maxSteps: 1 }).catch(() => undefined);
  const tools = provider.callHistory[0]?.tools ?? [];
  const submit = tools.find((tool) => tool.name === 'submit_issue_ticket');
  assert.ok(submit, 'submit_issue_ticket is offered');
  assert.deepEqual(submit.parameters.required, ['ticket']);
  const schema = submit.parameters.properties['ticket'] as { properties: Record<string, unknown> };
  for (const field of ['type', 'priority', 'affected_files', 'reproduction_steps', 'acceptance_criteria', 'missing_info', 'route']) {
    assert.ok(field in schema.properties, `${field} is in the schema`);
  }
});

test('a valid ticket is accepted and the loop stops at one model turn', async () => {
  const root = workspace();
  const provider = new MockProvider('mock', [
    { content: '', toolCalls: [submitCall(ticket())] },
    'this turn must never run',
  ]);
  const result = await runTriage({ issue: 'the cli crashes', workspaceRoot: root, provider });
  assert.equal(result.ticket.type, 'bug');
  assert.deepEqual(result.ticket.affected_files, ['app.py']);
  assert.deepEqual(result.warnings, []);
  assert.equal(provider.callHistory.length, 1, 'abort after accept stops the loop');
});

test('non-existent and outside-workspace files are dropped with warnings', async () => {
  const root = workspace();
  const provider = new MockProvider('mock', [
    { content: '', toolCalls: [submitCall(ticket({ affected_files: ['app.py', 'ghost.py', '../outside.py'] }))] },
  ]);
  const result = await runTriage({ issue: 'crash', workspaceRoot: root, provider });
  assert.deepEqual(result.ticket.affected_files, ['app.py']);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((w) => w.includes('ghost.py') && w.includes('does not exist')));
  assert.ok(result.warnings.some((w) => w.includes('outside.py') && w.includes('outside the workspace')));
});

test('missing_info forces the route to ask_user with a warning', async () => {
  const root = workspace();
  const provider = new MockProvider('mock', [
    { content: '', toolCalls: [submitCall(ticket({ missing_info: ['exact command'], route: 'fix' }))] },
  ]);
  const result = await runTriage({ issue: 'it is broken somehow', workspaceRoot: root, provider });
  assert.equal(result.ticket.route, 'ask_user');
  assert.ok(result.warnings.some((w) => w.includes('ask_user')));
});

test('a schema error is sent back to the model and the retry succeeds', async () => {
  const root = workspace();
  const provider = new MockProvider();
  provider.setHandler(async (params) => {
    const last = params.messages[params.messages.length - 1];
    if (last.role === 'tool') return { content: '', toolCalls: [submitCall(ticket(), 't2')] };
    return {
      content: '',
      toolCalls: [submitCall({ ...ticket(), acceptance_criteria: [] } as unknown as IssueTicket, 't1')],
    };
  });
  const result = await runTriage({ issue: 'crash', workspaceRoot: root, provider });
  assert.equal(result.ticket.type, 'bug');
  assert.equal(provider.callHistory.length, 2);
  const retryTurn = provider.callHistory[1].messages;
  // messages is the live session array; the schema error is one of the tool turns, not necessarily the last.
  assert.ok(
    retryTurn.some((m) => m.role === 'tool' && m.content.includes('does not match the IssueTicket schema')),
    'the schema error was sent back to the model'
  );
});

test('three schema-invalid tickets fail with a clear error', async () => {
  const root = workspace();
  const provider = new MockProvider();
  provider.setHandler(() => ({
    content: '',
    toolCalls: [submitCall({ type: 'nope' } as unknown as IssueTicket)],
  }));
  await assert.rejects(
    runTriage({ issue: 'crash', workspaceRoot: root, provider }),
    /did not match the IssueTicket schema after 3 attempts/
  );
});

test('a model that never submits fails with a clear error', async () => {
  const root = workspace();
  const provider = new MockProvider('mock', ['just chatting, no ticket']);
  await assert.rejects(
    runTriage({ issue: 'crash', workspaceRoot: root, provider, maxSteps: 2 }),
    /never called submit_issue_ticket/
  );
});

test('validateTicket keeps existing files and passes a clean ticket through', () => {
  const root = workspace();
  const { ticket: valid, warnings } = validateTicket(ticket(), root);
  assert.deepEqual(valid, ticket());
  assert.deepEqual(warnings, []);
});

test('validateTicket removes directories as well as missing and outside paths', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'subdir'));
  const result = validateTicket(ticket({ affected_files: ['app.py', 'subdir', 'missing.py', '../outside.py'] }), root);
  assert.deepEqual(result.ticket.affected_files, ['app.py']);
  assert.equal(result.warnings.length, 3);
  assert.ok(result.warnings.some((warning) => warning.includes('subdir') && warning.includes('not a file')));
});

test('issueTicketSchema rejects an empty acceptance_criteria list', () => {
  const parsed = issueTicketSchema.safeParse(ticket({ acceptance_criteria: [] }));
  assert.equal(parsed.success, false);
});

test('issueTicketSchema rejects a priority outside P0-P3', () => {
  const parsed = issueTicketSchema.safeParse(ticket({ priority: 'urgent' }));
  assert.equal(parsed.success, false);
});
