import { createExecutionContext } from '../src/core/execution-context.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IssueTicket } from '../src/agents/triage.js';
import { formatIssueTicket, triageCommand } from '../src/commands/triage.js';
import type { CommandContext, CommandUI } from '../src/commands/types.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { defaultCommandRouter } from '../src/commands/index.js';

process.env.AXIOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-command-home-'));
process.env.AXIOM_CONFIG_PATH = path.join(process.env.AXIOM_HOME, 'config.json');
fs.writeFileSync(process.env.AXIOM_CONFIG_PATH, JSON.stringify({ defaultModel: 'ollama/gpt-oss:20b' }));

// Giả lập ở ranh giới HTTP; activeProvider không điều khiển model resolver.
beforeEach(t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    'data: {"choices":[{"delta":{"content":"No ticket"}}]}\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  ));
});

const ticket = (over: Partial<IssueTicket> = {}): IssueTicket => ({
  type: 'bug',
  priority: 'P1 - crashes the CLI',
  affected_files: [],
  reproduction_steps: [],
  acceptance_criteria: ['Saving an empty file does not crash'],
  missing_info: [],
  route: 'fix',
  ...over,
});

/** Cấu hình model cố định và fetch giả giữ test độc lập với máy người chạy. */
function makeCtx(opts: { activeProvider?: string; onAsk?: () => string } = {}): {
  ctx: CommandContext;
  questions: string[];
} {
  const questions: string[] = [];
  const ui: CommandUI = {
    print() {},
    ask: async (question) => {
      questions.push(question);
      return opts.onAsk?.() ?? '';
    },
    confirm: async () => false,
  };
  const ctx: CommandContext = {
    ...createExecutionContext(),
    config: { ...DEFAULT_CONFIG, defaultModel: 'ollama/gpt-oss:20b', activeProvider: opts.activeProvider ?? DEFAULT_CONFIG.activeProvider },
    workspaceRoot: process.cwd(),
    ui,
    signal: new AbortController().signal,
    session: { model: {} as ModelInfo, setModel() {} },
  };
  return { ctx, questions };
}

test('run sends the issue through resolveModel(@smol) and createProviderFor into runTriage (mock, no network)', async () => {
  const { ctx } = makeCtx({ activeProvider: 'mock' });
  await assert.rejects(triageCommand.run('crash on save', ctx), /never called submit_issue_ticket/);
});

test('empty args ask for the issue through ctx.ui', async () => {
  const { ctx, questions } = makeCtx({ activeProvider: 'mock', onAsk: () => 'crash on save' });
  await assert.rejects(triageCommand.run('   ', ctx), /never called submit_issue_ticket/);
  assert.deepEqual(questions, ['Issue: ']);
});

test('empty issue after prompting is rejected before running triage', async () => {
  const { ctx } = makeCtx({ activeProvider: 'mock', onAsk: () => '   ' });
  await assert.rejects(triageCommand.run('', ctx), /Issue cannot be empty/);
});

test('registered triage command returns a formatted ticket from the provider', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-command-'));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ activeProvider: 'ollama', defaultModel: 'ollama/gpt-oss:20b', providers: { ollama: { baseUrl: 'http://localhost:11434/v1' } } }));
  const oldConfigPath = process.env.AXIOM_CONFIG_PATH;
  const oldFetch = globalThis.fetch;
  process.env.AXIOM_CONFIG_PATH = configPath;
  let request: { model?: string; messages?: Array<{ role: string; content: string }> } = {};
  globalThis.fetch = async (_input, init) => {
    request = JSON.parse(String(init?.body));
    const args = JSON.stringify({ ticket: ticket({ affected_files: [], missing_info: ['Which command fails?'], route: 'ask_user' }) });
    const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'submit', function: { name: 'submit_issue_ticket', arguments: args } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const { ctx } = makeCtx({ activeProvider: 'ollama' });
    ctx.workspaceRoot = root;
    ctx.config = { ...ctx.config, defaultModel: 'ollama/gpt-oss:20b' };
    const command = defaultCommandRouter.get('triage');
    assert.equal(command, triageCommand);
    const result = await command.run('app crashes', ctx);
    assert.ok(result);
    assert.equal(result.kind, 'issue-ticket');
    assert.match(result.text, /Route: ask_user/);
    assert.match(result.text, /Which command fails\?/);
    assert.equal(request.model, 'gpt-oss:20b');
    assert.ok(request.messages?.some((message) => message.role === 'user' && message.content === 'app crashes'));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldConfigPath === undefined) delete process.env.AXIOM_CONFIG_PATH;
    else process.env.AXIOM_CONFIG_PATH = oldConfigPath;
  }
});

test('formatIssueTicket renders every field, drops empty sections, keeps warnings', () => {
  const full = formatIssueTicket(
    ticket({
      affected_files: ['src/app.py'],
      reproduction_steps: ['Open the app', 'Save an empty file'],
      missing_info: ['exact command'],
    }),
    ['affected_files: "ghost.py" does not exist in the repository and was removed']
  );
  assert.match(full, /^\[bug\] P1 - crashes the CLI\nRoute: fix/);
  assert.match(full, /Affected files:\n- src\/app\.py/);
  assert.match(full, /Reproduction steps:\n1\. Open the app\n2\. Save an empty file/);
  assert.match(full, /Acceptance criteria:\n- Saving an empty file does not crash/);
  assert.match(full, /Missing info:\n- exact command/);
  assert.match(full, /Warning: affected_files: "ghost\.py" does not exist/);

  const minimal = formatIssueTicket(ticket(), []);
  assert.match(minimal, /^\[bug\] P1 - crashes the CLI\nRoute: fix\n\nAcceptance criteria:/);
  assert.ok(!minimal.includes('Affected files'));
  assert.ok(!minimal.includes('Reproduction steps'));
  assert.ok(!minimal.includes('Missing info'));
  assert.ok(!minimal.includes('Warning'));
});
