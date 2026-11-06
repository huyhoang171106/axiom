// tests/audit.test.ts - Lưu trữ audit và đọc lịch sử qua command chung.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordDecision, readAudit, type AuditEntry } from '../src/core/audit.js';
import { auditCommand } from '../src/commands/audit.js';
import type { CommandContext } from '../src/commands/types.js';
import { registerSecret } from '../src/core/secrets.js';
import { createExecutionContext } from '../src/core/execution-context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { actionKey } from '../src/tools/denied-actions.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { SessionManager } from '../src/core/session.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { defaultCommandRouter } from '../src/commands/index.js';
import { runCli } from '../src/cli/index.js';
import { buildTriageGraph } from '../src/agents/triage.js';
import { runGraph } from '../src/core/human-gate.js';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { TuiController } from '../src/tui/controller.js';
import { TuiStore } from '../src/tui/store.js';

function home(t: { after(fn: () => void): void }) {
  const previous = process.env.AXIOM_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-audit-'));
  process.env.AXIOM_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function entry(index: number): AuditEntry {
  return { at: new Date(index).toISOString(), runId: 'audit-storage-test', tool: 'read_file',
    args: { path: `file-${index}` }, reason: 'allowed by policy', risk: 'low', decision: 'allow', approver: 'policy' };
}

test('audit storage appends JSON lines and defaults to the latest 50 in chronological order', (t) => {
  const root = home(t);
  assert.deepEqual(readAudit(), []);
  for (let i = 0; i < 55; i++) recordDecision(entry(i));
  assert.deepEqual(readAudit(), Array.from({ length: 50 }, (_, i) => entry(i + 5)));
  assert.deepEqual(readAudit(2), [entry(53), entry(54)]);
  assert.equal(fs.readFileSync(path.join(root, 'audit.jsonl'), 'utf8').trim().split('\n').length, 55);
});

test('secret values in args are redacted', (t) => {
  const root = home(t);
  const secret = 'audit-fixture-sensitive-value';
  registerSecret(secret);
  const record = { ...entry(1), args: { nested: [{ value: secret }], long: secret + 'x'.repeat(700) }, reason: secret };
  recordDecision(record);
  const raw = fs.readFileSync(path.join(root, 'audit.jsonl'), 'utf8');
  assert.equal(raw.includes(secret), false);
  assert.equal(readAudit()[0].reason.includes(secret), false);
  assert.equal((readAudit()[0].args.long as string).length, 500);
  assert.equal(record.args.nested[0].value, secret);
});

test('audit file is private on POSIX including an existing permissive file', (t) => {
  const root = home(t);
  const file = path.join(root, 'audit.jsonl');
  fs.writeFileSync(file, '', { mode: 0o666 });
  recordDecision(entry(1));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readAudit(), [entry(1)]);
});

test('/audit prints newest entries first', async (t) => {
  home(t);
  for (let i = 0; i < 3; i++) recordDecision(entry(i));
  const result = await auditCommand.run('2', {} as CommandContext);
  assert.equal(result?.kind, 'audit');
  assert.deepEqual(result?.data, [entry(2), entry(1)]);
  assert.ok(result!.text.indexOf('file-2') < result!.text.indexOf('file-1'));
  assert.equal(result!.text.includes('file-0'), false);
  await assert.rejects(auditCommand.run('invalid', {} as CommandContext), /positive integer/);
});

function session(t: { after(fn: () => void): void }) {
  const root = home(t);
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(workspaceRoot);
  const ctx = createExecutionContext();
  const events: unknown[] = [];
  ctx.bus.on('approval', (event) => events.push(event));
  return { ...ctx, root, workspaceRoot, events };
}

function audited(ctx: ReturnType<typeof session>): AuditEntry[] {
  const entries = readAudit(1000);
  const trace = fs.readFileSync(path.join(ctx.root, 'traces', `${ctx.runId}.jsonl`), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as { event: string; data: unknown });
  // So toàn bộ payload, không chỉ tên event hoặc số dòng.
  assert.deepEqual(ctx.events, entries);
  assert.deepEqual(trace.filter((line) => line.event === 'approval').map((line) => line.data), entries);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.runId, ctx.runId);
    assert.equal(new Date(entry.at).toISOString(), entry.at);
    assert.ok(entry.tool && entry.reason);
    assert.ok(['low', 'medium', 'high'].includes(entry.risk));
    assert.ok(['policy', 'user', 'headless', 'eval'].includes(entry.approver));
  }
  return entries;
}

test('approve and deny both write an audit line', async (t) => {
  const ctx = session(t);
  ctx.tools.approver = async () => {
    assert.equal(readAudit().at(-1)?.decision, 'ask');
    return 'approve';
  };
  const approved = await ctx.tools.executeTool('write_file', { path: 'package.json', content: '{}' }, ctx);
  assert.equal(approved.isError, false);
  assert.equal(fs.readFileSync(path.join(ctx.workspaceRoot, 'package.json'), 'utf8'), '{}');
  ctx.tools.approver = async () => 'deny';
  const rejected = await ctx.tools.executeTool('write_file', { path: 'requirements.txt', content: 'example' }, ctx);
  assert.equal(rejected.isError, true);
  assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, 'requirements.txt')), false);
  assert.deepEqual(audited(ctx).map(({ decision, approver }) => [decision, approver]),
    [['ask', 'policy'], ['approve', 'user'], ['ask', 'policy'], ['reject', 'user']]);
  let asked = false;
  ctx.tools.approver = async () => { asked = true; return 'approve'; };
  const deniedAgain = await ctx.tools.scoped(['write_file']).executeTool('write_file', { path: 'requirements.txt', content: 'example' }, ctx);
  assert.equal(deniedAgain.isError, true);
  assert.equal(asked, false);
  assert.equal(audited(ctx).at(-1)?.decision, 'deny');
  const history = await auditCommand.run('2', {} as CommandContext);
  assert.deepEqual(history?.data, readAudit(2).reverse());
});

test('policy deny writes approver policy', async (t) => {
  const ctx = session(t);
  let asked = false;
  ctx.tools.approver = async () => { asked = true; return 'approve'; };
  ctx.tools.allowWithoutApprover = true;
  const result = await ctx.tools.executeTool('write_file', { path: '.env', content: 'blocked' }, ctx);
  assert.equal(result.isError, true);
  assert.equal(asked, false);
  assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, '.env')), false);
  assert.deepEqual(audited(ctx).map(({ decision, approver, risk }) => [decision, approver, risk]), [['deny', 'policy', 'high']]);
});

test('no approver and unattended decisions are audited without bypassing hard deny', async (t) => {
  const ctx = session(t);
  const args = { path: 'package.json', content: '{}' };
  assert.equal((await ctx.tools.executeTool('write_file', args, ctx)).isError, true);
  assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, 'package.json')), false);
  ctx.tools.allowWithoutApprover = true;
  assert.equal((await ctx.tools.executeTool('write_file', args, ctx)).isError, false);
  assert.equal((await ctx.tools.executeTool('write_file', { ...args, path: '.env' }, ctx)).isError, true);
  assert.equal(fs.readFileSync(path.join(ctx.workspaceRoot, 'package.json'), 'utf8'), '{}');
  assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, '.env')), false);
  assert.deepEqual(audited(ctx).map(({ decision, approver }) => [decision, approver]),
    [['ask', 'policy'], ['auto-deny', 'headless'], ['ask', 'policy'], ['unattended', 'headless'], ['deny', 'policy']]);
});

for (const target of ['note.txt', '.env']) {
  test(`edited args ${target} are audited with the rechecked risk and policy outcome`, async (t) => {
    const ctx = session(t);
    const editedArgs = { path: target, content: 'edited value' };
    ctx.tools.approver = async () => ({ editedArgs });
    const result = await ctx.tools.executeTool('write_file', { path: 'package.json', content: '{}' }, ctx);
    const denied = target === '.env';
    assert.equal(result.isError, denied);
    assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, 'package.json')), false);
    assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, target)), !denied);
    const entries = audited(ctx);
    assert.deepEqual(entries.map(({ decision }) => decision), ['ask', 'edited', denied ? 'deny' : 'allow']);
    assert.deepEqual(entries[1].args, editedArgs);
    assert.deepEqual(entries[2].args, editedArgs);
    assert.equal(entries[1].risk, denied ? 'high' : 'low');
    assert.equal(entries[1].approver, 'user');
    assert.equal(entries[2].approver, 'policy');
  });
}

test('a policy change while awaiting approval records approve then deny without writing', async (t) => {
  const ctx = session(t);
  const args = { path: 'package.json', content: '{}' };
  ctx.tools.approver = async () => {
    ctx.tools.denied.add(actionKey('write_file', args, ctx.workspaceRoot));
    return 'approve';
  };
  assert.equal((await ctx.tools.executeTool('write_file', args, ctx)).isError, true);
  assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, 'package.json')), false);
  assert.deepEqual(audited(ctx).map(({ decision }) => decision), ['ask', 'approve', 'deny']);
});

test('the final execution recheck audits a new denial after an initial allow', async (t) => {
  const ctx = session(t);
  const args = { path: 'note.txt', content: 'blocked' };
  ctx.bus.once('approval', () => ctx.tools.denied.add(actionKey('write_file', args, ctx.workspaceRoot)));
  assert.equal((await ctx.tools.executeTool('write_file', args, ctx)).isError, true);
  assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, 'note.txt')), false);
  assert.deepEqual(audited(ctx).map(({ decision }) => decision), ['allow', 'deny']);
});

test('a newly risky path before execution is audited and refused until approved', async (t) => {
  const ctx = session(t);
  const alias = path.join(ctx.workspaceRoot, 'alias');
  const config = path.join(ctx.workspaceRoot, '.github');
  fs.mkdirSync(alias);
  fs.mkdirSync(config);
  ctx.bus.once('approval', () => {
    fs.rmdirSync(alias);
    fs.symlinkSync(config, alias, 'junction');
  });
  const result = await ctx.tools.executeTool('write_file', { path: 'alias/new.yml', content: 'blocked' }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.output, /Policy changed before execution/);
  assert.equal(fs.existsSync(path.join(config, 'new.yml')), false);
  assert.deepEqual(audited(ctx).map(({ decision }) => decision), ['allow', 'ask', 'auto-deny']);
});

test('approval failure records an automatic denial and never executes the tool', async (t) => {
  const ctx = session(t);
  ctx.tools.approver = async () => { throw new Error('Cancelled'); };
  const result = await ctx.tools.executeTool('write_file', { path: 'package.json', content: '{}' }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.output, /Cancelled/);
  assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, 'package.json')), false);
  assert.deepEqual(audited(ctx).map(({ decision }) => decision), ['ask', 'auto-deny']);
});

test('patch allow writes an audit line and reaches trace through nested scoped views', async (t) => {
  const ctx = session(t);
  fs.writeFileSync(path.join(ctx.workspaceRoot, 'note.txt'), 'before\n');
  const view = ctx.tools.scoped(['apply_patch']).scoped(['apply_patch']);
  const patch = '--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-before\n+after\n';
  const result = await view.executeTool('apply_patch', { patch }, ctx);
  assert.equal(result.isError, false);
  assert.equal(fs.readFileSync(path.join(ctx.workspaceRoot, 'note.txt'), 'utf8'), 'after\n');
  const entries = audited(ctx);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].decision, 'allow');
  assert.equal(entries[0].tool, 'apply_patch');
  assert.deepEqual(entries[0].args, { patch });
  const command = defaultCommandRouter.get('audit');
  assert.ok(command);
  const history = await command.run('1', {} as CommandContext);
  assert.equal(history?.kind, 'audit');
  assert.deepEqual(history?.data, entries);
});

test('registry redacts audit and event arguments without changing executed content', async (t) => {
  const ctx = session(t);
  const secret = 'audit-integration-sensitive-value';
  registerSecret(secret);
  const content = secret + 'x'.repeat(700);
  assert.equal((await ctx.tools.executeTool('write_file', { path: 'note.txt', content }, ctx)).isError, false);
  assert.equal(fs.readFileSync(path.join(ctx.workspaceRoot, 'note.txt'), 'utf8'), content);
  const entries = audited(ctx);
  assert.equal((entries[0].args.content as string).length, 500);
  assert.equal(JSON.stringify(ctx.events).includes(secret), false);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'audit.jsonl'), 'utf8').includes(secret), false);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'traces', `${ctx.runId}.jsonl`), 'utf8').includes(secret), false);
});

test('audit storage failure blocks tool execution and reports the error', async (t) => {
  const ctx = session(t);
  fs.mkdirSync(path.join(ctx.root, 'audit.jsonl'));
  const result = await ctx.tools.executeTool('write_file', { path: 'note.txt', content: 'blocked' }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.output, /EISDIR|EACCES|EPERM/);
  assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, 'note.txt')), false);
  assert.deepEqual(ctx.events, []);
});

test('standalone registry audit identity remains stable across scoped calls', async (t) => {
  const root = home(t);
  const registry = new ToolRegistry();
  await registry.executeTool('list_dir', { path: '.' }, { workspaceRoot: root });
  await registry.scoped(['list_dir']).executeTool('list_dir', { path: '.' }, { workspaceRoot: root });
  const entries = readAudit();
  assert.equal(entries.length, 2);
  assert.ok(entries[0].runId);
  assert.equal(entries[1].runId, entries[0].runId);
});

test('approval event reaches the trace', async (t) => {
  const ctx = session(t);
  ctx.tools.approver = async () => 'deny';
  const loop = new AgentLoop({ config: { ...DEFAULT_CONFIG, workspaceRoot: ctx.workspaceRoot },
    provider: new MockProvider('mock', [{ content: '', toolCalls: [
      { id: 'write', name: 'write_file', arguments: { path: 'note.txt', content: 'ok' } },
      { id: 'deny', name: 'write_file', arguments: { path: 'package.json', content: '{}' } },
    ] }, 'finished']),
    toolRegistry: ctx.tools.scoped(['write_file']), eventBus: ctx.bus, costTracker: ctx.costTracker,
    sessionManager: new SessionManager({ workspaceRoot: ctx.workspaceRoot, sessionsDir: path.join(ctx.root, 'sessions'), autoSave: false }),
  });
  assert.equal((await loop.runTask('Write the files')).status, 'completed');
  assert.equal(fs.readFileSync(path.join(ctx.workspaceRoot, 'note.txt'), 'utf8'), 'ok');
  assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, 'package.json')), false);
  assert.deepEqual(audited(ctx).map(({ decision }) => decision), ['allow', 'ask', 'reject']);
});

test('triage records policy decisions with the same session identity as its trace', async (t) => {
  const ctx = session(t);
  const graph = buildTriageGraph({ issue: 'How?', workspaceRoot: ctx.workspaceRoot,
    tools: ctx.tools, bus: ctx.bus, costTracker: ctx.costTracker,
    provider: new MockProvider('mock', [{ content: '', toolCalls: [
      { id: 'secret', name: 'read_file', arguments: { path: '.env' } },
      { id: 'ticket', name: 'submit_issue_ticket', arguments: { ticket: {
        type: 'question', priority: 'P3 - question', affected_files: [], reproduction_steps: [],
        acceptance_criteria: ['answered'], missing_info: [], route: 'answer',
      } } },
    ] }]),
  });
  assert.ok(graph.checkpointer instanceof SqliteSaver);
  try {
    await runGraph(graph, { issue: 'How?', ticket: null, warnings: [], confirmed: false }, {
      threadId: 'audit-triage', ui: { print() {}, async ask() { return 'no'; }, async confirm() { return false; } },
    });
  } finally {
    graph.checkpointer.db.close();
  }
  assert.deepEqual(audited(ctx).map(({ tool, decision }) => [tool, decision]),
    [['read_file', 'deny'], ['submit_issue_ticket', 'allow']]);
});

for (const yes of [false, true]) {
  test(`headless entry point audits ${yes ? '--yes' : 'no-TTY'} decisions and hard deny`, async (t) => {
    const setup = session(t);
    let context: ReturnType<typeof session> | undefined;
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    t.after(() => {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    });
    const name = `e4-audit-cli-${yes}`;
    defaultCommandRouter.register({ name, summary: '', usage: '', async run(_args, ctx) {
      const events: unknown[] = [];
      ctx.bus.on('approval', (event) => events.push(event));
      context = { ...setup, ...ctx, workspaceRoot: setup.workspaceRoot, events };
      const write = await ctx.tools.executeTool('write_file', { path: 'package.json', content: '{}' }, context);
      assert.equal(write.isError, !yes);
      const denied = await ctx.tools.executeTool('write_file', { path: '.env', content: 'blocked' }, context);
      assert.equal(denied.isError, true);
    } });
    await runCli([name, ...(yes ? ['--yes'] : [])]);
    assert.ok(context);
    assert.equal(fs.existsSync(path.join(setup.workspaceRoot, 'package.json')), yes);
    assert.equal(fs.existsSync(path.join(setup.workspaceRoot, '.env')), false);
    assert.deepEqual(audited(context).map(({ decision }) => decision), ['ask', yes ? 'unattended' : 'auto-deny', 'deny']);
  });
}

test('first TUI command audits cancelled approval and /audit preserves ordered data', async (t) => {
  const setup = session(t);
  const store = new TuiStore();
  const controller = new TuiController(store, { workspaceRoot: setup.workspaceRoot, mock: true });
  let context: ReturnType<typeof session> | undefined;
  let cancelled = false;
  defaultCommandRouter.register({ name: 'e4-audit-tui', summary: '', usage: '', async run(_args, ctx) {
    const events: unknown[] = [];
    ctx.bus.on('approval', (event) => events.push(event));
    context = { ...setup, ...ctx, events };
    assert.equal((await ctx.tools.executeTool('write_file', { path: 'package.json', content: '{}' }, ctx)).isError, true);
  } });
  const unsubscribe = store.subscribe(() => {
    if (!cancelled && store.getSnapshot().pendingApproval?.name === 'write_file') {
      cancelled = true;
      controller.abort();
    }
  });
  try {
    await controller.submit('/e4-audit-tui');
    store.flush();
    assert.equal(cancelled, true);
    assert.equal(store.getSnapshot().pendingApproval, null);
    assert.equal(fs.existsSync(path.join(setup.workspaceRoot, 'package.json')), false);
    assert.ok(context);
    const entries = audited(context);
    assert.deepEqual(entries.map(({ decision }) => decision), ['ask', 'reject']);
    await controller.submit('/audit');
    store.flush();
    const result = store.getSnapshot().entries.at(-1)!;
    assert.equal(result.kind, 'audit');
    assert.deepEqual(result.data, entries.reverse());
  } finally {
    unsubscribe();
    store.dispose();
  }
});
