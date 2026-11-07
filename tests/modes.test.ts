// tests/modes.test.ts - Quyền phiên phải chặn cả view cũ, edited args và workflow có side effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { BaseTool } from '../src/tools/base-tool.js';
import { READ_ONLY_TOOLS, PLAN_MODE_SYSTEM_DIRECTIVE } from '../src/tools/permissions.js';
import { modeCommand } from '../src/commands/mode.js';
import { planCommand } from '../src/commands/plan.js';
import { permissionSession } from '../src/commands/permission-session.js';
import type { CommandContext } from '../src/commands/types.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { EventBus } from '../src/core/event-bus.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { SessionManager } from '../src/core/session.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { MOCK_MODEL } from '../src/cli/agent.js';
import { readAudit } from '../src/core/audit.js';
import { fixIssue } from '../src/agents/fix.js';

function setup(t: test.TestContext): CommandContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-security-'));
  const before = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(root, 'home');
  t.after(() => {
    if (before === undefined) delete process.env.AXIOM_HOME; else process.env.AXIOM_HOME = before;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const tools = new ToolRegistry();
  const bus = new EventBus(); tools.bus = bus;
  return { tools, bus, runId: 'mode-test', costTracker: new CostTracker(), config: DEFAULT_CONFIG,
    workspaceRoot: root, signal: new AbortController().signal,
    session: { model: MOCK_MODEL, setModel() {} }, ui: { print() {}, async ask() { return ''; }, async confirm() { return false; } } };
}

test('mode commands reject auto and invalid arguments without changing state', async t => {
  const ctx = setup(t);
  await modeCommand.run('read-only', ctx);
  const sessionsDir = path.join(process.env.AXIOM_HOME!, 'sessions');
  assert.deepEqual(fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [], [], 'mode alone must not persist an empty session');
  for (const input of ['auto', 'invalid', 'edit extra']) await assert.rejects(modeCommand.run(input, ctx), /Usage/);
  await assert.rejects(planCommand.run('invalid', ctx), /Usage/);
  assert.equal(ctx.tools.permissionMode, 'read-only');
  assert.throws(() => ctx.tools.setPermissionMode('auto' as 'edit'), /Only/);
});

test('read-only hides mutators and denies old scoped views, custom submit tools and unattended execution', async t => {
  const ctx = setup(t);
  const tools = ctx.tools;
  const oldView = tools.scoped(['write_file', 'run_tests', 'run_command', 'submit_write']);
  let executed = 0;
  class Submit extends BaseTool {
    readonly name = 'submit_write'; readonly description = ''; readonly parameters = {};
    async execute() { executed++; return 'done'; }
  }
  oldView.registerTool(new Submit());
  tools.allowWithoutApprover = true;
  await modeCommand.run('read-only', ctx);
  assert.deepEqual(tools.getDefinitions().map(t => t.name).sort(), [...READ_ONLY_TOOLS].sort());
  assert.equal(oldView.isReadOnly(), true);
  assert.equal(oldView.hasTool('write_file'), false);
  assert.equal(oldView.getTool('run_command'), undefined);
  for (const view of [oldView, oldView.scoped(['write_file', 'run_command', 'submit_write'])]) {
    for (const [name, args] of [['write_file', { path: 'a.txt', content: 'bad' }],
      ['run_command', { command: 'pip install requests' }], ['submit_write', {}]] as const) {
      assert.equal((await view.executeTool(name, args, ctx)).isError, true);
    }
  }
  assert.equal(executed, 0); assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, 'a.txt')), false);
  assert.ok(readAudit().some(e => e.decision === 'deny' && e.reason.includes('read-only')));
  await modeCommand.run('edit', ctx);
  assert.equal((await oldView.executeTool('write_file', { path: 'a.txt', content: 'ok' }, ctx)).isError, false);
  assert.equal(fs.readFileSync(path.join(ctx.workspaceRoot, 'a.txt'), 'utf8'), 'ok');
});

test('switching modes preserves denials and session approval state across nested scopes', async t => {
  const ctx = setup(t); let approvals = 0;
  ctx.tools.approver = async () => { approvals++; return 'deny'; };
  const denied = ctx.tools.denied;
  await ctx.tools.executeTool('run_command', { command: 'pip install requests' }, ctx);
  await modeCommand.run('read-only', ctx); await modeCommand.run('edit', ctx);
  const retry = await ctx.tools.scoped(['run_command']).scoped(['run_command'])
    .executeTool('run_command', { command: 'python3 -m pip install requests' }, ctx);
  assert.equal(retry.isError, true); assert.equal(approvals, 1); assert.equal(ctx.tools.denied, denied);
  assert.match(retry.output, /denied earlier/);
  assert.equal(new ToolRegistry().denied.size, 0);
});

test('mode changes during approval recheck original and edited arguments before execution', async t => {
  const ctx = setup(t);
  for (const edited of [false, true]) {
    ctx.tools.setPermissionMode('edit');
    ctx.tools.approver = async () => {
      ctx.tools.setPermissionMode('read-only');
      return edited ? { editedArgs: { path: 'note.txt', content: 'bad' } } : 'approve';
    };
    const result = await ctx.tools.executeTool('write_file', { path: 'package.json', content: '{}' }, ctx);
    assert.equal(result.isError, true); assert.match(result.output, /read-only/);
  }
  assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, 'package.json')), false);
  assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, 'note.txt')), false);
});

test('plan is idempotent, restores previous mode and updates the existing agent system message', async t => {
  const ctx = setup(t);
  const permissions = permissionSession(ctx);
  await planCommand.run('', ctx); await planCommand.run('', ctx);
  const provider = new MockProvider('mock', ['one', 'two']);
  const manager = new SessionManager({ workspaceRoot: ctx.workspaceRoot, sessionsDir: path.join(ctx.workspaceRoot, 'chat') });
  const agent = new AgentLoop({ config: { ...DEFAULT_CONFIG, workspaceRoot: ctx.workspaceRoot }, provider,
    model: 'mock', toolRegistry: ctx.tools, eventBus: ctx.bus, sessionManager: manager, systemPrompt: 'base prompt' });
  permissions.bind(agent);
  await agent.runTask('inspect');
  assert.equal(manager.getPermissionMode(), 'read-only'); assert.equal(manager.getPlanMode(), true);
  assert.equal(agent.getSystemPrompt().split(PLAN_MODE_SYSTEM_DIRECTIVE).length, 2);
  assert.ok(manager.requireSession().messages[0].content.includes(PLAN_MODE_SYSTEM_DIRECTIVE));
  await planCommand.run('off', ctx);
  assert.equal(permissions.mode, 'edit'); assert.equal(agent.getSystemPrompt(), 'base prompt');
  assert.equal(manager.requireSession().messages[0].content, 'base prompt');
  agent.stateMachine.reset(); await agent.runTask('continue');
  assert.equal(provider.callHistory.length, 2);
  await modeCommand.run('read-only', ctx); await planCommand.run('', ctx); await planCommand.run('off', ctx);
  assert.equal(permissions.mode, 'read-only');
  await planCommand.run('', ctx); await modeCommand.run('edit', ctx); await planCommand.run('off', ctx);
  assert.equal(permissions.mode, 'edit'); assert.equal(permissions.planning, false);
});

test('read-only registry does not expose write_file, edit, apply_patch, run_command', async t => {
  const ctx = setup(t); await modeCommand.run('read-only', ctx);
  for (const name of ['write_file', 'edit', 'apply_patch', 'run_command']) {
    assert.equal(ctx.tools.hasTool(name), false);
    assert.ok(!ctx.tools.getDefinitions().some(d => d.name === name));
  }
});

test('edit still denies .env', async t => {
  const ctx = setup(t); let asked = 0;
  ctx.tools.approver = async () => { asked++; return 'approve'; };
  fs.writeFileSync(path.join(ctx.workspaceRoot, '.env'), 'TOKEN=secret');
  await modeCommand.run('edit', ctx);
  const result = await ctx.tools.executeTool('read_file', { path: '.env' }, ctx);
  assert.equal(result.isError, true); assert.equal(asked, 0); assert.doesNotMatch(result.output, /TOKEN=/);
});

test('edit still asks for pip install and git push', async t => {
  const ctx = setup(t);
  await modeCommand.run('edit', ctx);
  for (const [command, risk] of [['pip install requests', 'medium'], ['git push origin feature', 'high']] as const) {
    // Fresh registry per command: E2 escalation would otherwise deny the second call without asking.
    const tools = new ToolRegistry(); tools.setPermissionMode('edit'); const asked: string[] = [];
    tools.approver = async request => { asked.push(`${String(request.args.command)}|${request.risk}`); return 'deny'; };
    assert.equal((await tools.executeTool('run_command', { command }, ctx)).isError, true);
    assert.deepEqual(asked, [`${command}|${risk}`]);
  }
});

test('edit allows a small apply_patch', async t => {
  const ctx = setup(t); let asked = 0;
  ctx.tools.approver = async () => { asked++; return 'deny'; };
  fs.writeFileSync(path.join(ctx.workspaceRoot, 'a.py'), 'one\n');
  await modeCommand.run('edit', ctx);
  const result = await ctx.tools.executeTool('apply_patch', { patch: '--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-one\n+ONE\n' }, ctx);
  assert.equal(result.isError, false, result.output); assert.equal(asked, 0);
  assert.equal(fs.readFileSync(path.join(ctx.workspaceRoot, 'a.py'), 'utf8'), 'ONE\n');
});

test('/plan off restores the previous mode', async t => {
  const ctx = setup(t);
  for (const previous of ['edit', 'read-only'] as const) {
    await modeCommand.run(previous, ctx);
    const on = await planCommand.run('', ctx);
    assert.deepEqual(on?.data, { mode: 'read-only', planMode: true });
    const off = await planCommand.run('off', ctx);
    assert.deepEqual(off?.data, { mode: previous, planMode: false });
    assert.equal(ctx.tools.permissionMode, previous);
  }
});

test('read-only reaches the upstream fix guard before provider, verifier or workspace effects', async t => {
  const ctx = setup(t); await modeCommand.run('read-only', ctx);
  let verifierCalls = 0; const provider = new MockProvider('mock');
  const report = await fixIssue({ issue: 'bug', workspaceRoot: ctx.workspaceRoot, tools: ctx.tools,
    bus: ctx.bus, model: 'mock', provider, runTests: async () => { verifierCalls++; throw new Error('must not execute'); } });
  assert.equal(report.status, 'failed'); assert.match(report.summary, /read-only/);
  assert.equal(verifierCalls, 0); assert.equal(provider.callHistory.length, 0);
});
