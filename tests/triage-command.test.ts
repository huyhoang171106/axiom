import test from 'node:test';
import assert from 'node:assert/strict';
import type { IssueTicket } from '../src/agents/triage.js';
import { formatIssueTicket, triageCommand } from '../src/commands/triage.js';
import type { CommandContext, CommandUI } from '../src/commands/types.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';

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

/** activeProvider 'mock' makes createProviderFor return a MockProvider, so nothing touches the network. */
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
    config: { ...DEFAULT_CONFIG, activeProvider: opts.activeProvider ?? DEFAULT_CONFIG.activeProvider },
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
