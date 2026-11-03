// tests/execution-context.test.ts - One session context for chat, slash commands and workflow nodes
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/index.js';
import { defaultCommandRouter } from '../src/commands/index.js';
import type { CommandContext } from '../src/commands/types.js';
import { EventBus } from '../src/core/event-bus.js';
import { runTriage } from '../src/agents/triage.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { BaseTool } from '../src/tools/base-tool.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { TuiController } from '../src/tui/controller.js';
import { TuiStore } from '../src/tui/store.js';

process.env.AXIOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-exec-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-exec-ws-'));

const seen: CommandContext[] = [];
defaultCommandRouter.register({ name: 'ctx-probe', summary: 'test', usage: '/ctx-probe', run: async (_args, ctx) => void seen.push(ctx) });

test('a scoped view offers only allowed tools and never more than the session', () => {
  const session = new ToolRegistry(['read_file', 'list_dir']);
  const view = session.scoped(['read_file', 'edit']);
  assert.deepEqual(view.getDefinitions().map((d) => d.name), ['read_file']);
  assert.equal(view.getTool('read_file'), session.getTool('read_file'));
  assert.throws(() => view.registerTool(new (class extends BaseTool {
    readonly name = 'edit';
    readonly description = '';
    readonly parameters = {};
    async execute() { return ''; }
  })()), /not allowed/);
});

test('a scoped view asks the session approver set after the view was made', async () => {
  const session = new ToolRegistry();
  const view = session.scoped(['run_command']).scoped(['run_command']);
  const refused = await view.executeTool('run_command', { command: 'printenv' }, { workspaceRoot: root });
  assert.match(refused.output, /no approver is installed/);
  const asked: string[] = [];
  session.approver = async ({ name }) => (asked.push(name), 'deny');
  const denied = await view.executeTool('run_command', { command: 'printenv' }, { workspaceRoot: root });
  assert.deepEqual(asked, ['run_command']);
  assert.match(denied.output, /Denied by user/);
});

test('a tool that returns an Error string is reported as failed', async () => {
  const result = await new ToolRegistry().executeTool('apply_patch', { patch: '' }, { workspaceRoot: root });
  assert.equal(result.isError, true);
  assert.equal(result.metadata.success, false);
  assert.ok(new ToolRegistry().hasTool('run_tests'));
});

test('the first TUI slash command gets the session context with the approval dialog installed', async () => {
  seen.length = 0;
  const store = new TuiStore();
  const controller = new TuiController(store, { workspaceRoot: root, mock: true });
  await controller.submit('/ctx-probe');
  await controller.submit('/ctx-probe');
  store.dispose();
  const [first, second] = seen;
  assert.ok(first.tools.approver, 'approver installed before any chat');
  assert.equal(first.tools, second.tools);
  assert.equal(first.bus, second.bus);
  assert.equal(first.costTracker, second.costTracker);
  assert.match(first.runId, /\S/);
});

test('headless --yes confirms gates and runs risky calls unattended, but a policy deny still blocks', async () => {
  seen.length = 0;
  await runCli(['ctx-probe', '--yes']);
  const ctx = seen[0];
  assert.equal(await ctx.ui.confirm('Run the suggested route?'), true);
  assert.equal(ctx.tools.allowWithoutApprover, true);
  const secret = await ctx.tools.executeTool('read_file', { path: '.env' }, { workspaceRoot: root });
  assert.match(secret.output, /Blocked by policy/);

  seen.length = 0;
  await runCli(['ctx-probe']);
  assert.equal(await seen[0].ui.confirm('Run the suggested route?'), false);
  assert.equal(seen[0].tools.allowWithoutApprover, false);
});

test('triage on the session bus records usage on the session tracker and leaves no listener behind', async () => {
  const bus = new EventBus();
  const tracker = new CostTracker();
  const calls: string[] = [];
  const provider = new MockProvider('mock', [{
    content: '',
    toolCalls: [{ id: 'c1', name: 'submit_issue_ticket', arguments: { ticket: {
      type: 'question', priority: 'P3 - question', affected_files: [], reproduction_steps: [],
      acceptance_criteria: ['answered'], missing_info: [], route: 'answer',
    } } }],
  }]);
  const before = bus['emitter'].listenerCount('tool_call_start');
  await runTriage({ issue: 'How do I run tests?', workspaceRoot: root, provider, bus, costTracker: tracker, onToolCall: (n) => calls.push(n) });
  assert.deepEqual(calls, ['submit_issue_ticket']);
  assert.ok(tracker.getSessionSummary().totalTokens > 0);
  assert.equal(bus['emitter'].listenerCount('tool_call_start'), before);
});
