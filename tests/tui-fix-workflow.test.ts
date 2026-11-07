// tests/tui-fix-workflow.test.ts - Real fix graph and registry through controller/store/Ink; scripted model and verifier seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { render, renderToString } from 'ink';
import { fixIssue, type FixReport } from '../src/agents/fix.js';
import { formatFixReport } from '../src/commands/fix.js';
import { defaultCommandRouter } from '../src/commands/index.js';
import { MockProvider, type MockResponse } from '../src/llm/providers/mock.js';
import { TuiController } from '../src/tui/controller.js';
import { TuiStore } from '../src/tui/store.js';
import { App } from '../src/tui/app.js';
import { Turn } from '../src/tui/components/transcript.js';
import { visibleWidth } from '../src/tui/layout.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { readAudit } from '../src/core/audit.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await pause();
  assert.ok(predicate(), 'expected UI state before timeout');
}
const tty = (columns: number) => Object.assign(new PassThrough(), { columns, rows: 60, isTTY: true, setRawMode() {}, ref() {}, unref() {} });
const patch = (file: string, replacement: string) => `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${replacement}\n`;

function workspace(t: test.TestContext): string {
  if (process.env.AXIOM_TUI_FIX_TEST_ROOT) {
    process.env.AXIOM_HOME = path.join(process.env.AXIOM_TUI_FIX_TEST_ROOT, 'home');
    return process.env.AXIOM_TUI_FIX_TEST_ROOT;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-fix-flow-'));
  const before = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(root, 'home');
  t.after(() => {
    if (before === undefined) delete process.env.AXIOM_HOME; else process.env.AXIOM_HOME = before;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

// SQLite của workflow chưa có lifecycle close công khai; parent dọn sau khi child đóng mọi handle.
if (!process.env.AXIOM_TUI_FIX_TEST_ROOT) for (const keep of [true, false]) {
  test(`isolated real fix graph reaches C7 and keyboard keep=${keep}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-fix-child-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const childEnv = { ...process.env, AXIOM_TUI_FIX_TEST_ROOT: root, AXIOM_TUI_FIX_TEST_KEEP: String(keep) };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--test', fileURLToPath(import.meta.url)], {
      env: childEnv,
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.ok(child.stdout.includes(`real fix graph reaches C7 and keyboard keep=${keep}`), child.stdout);
    assert.match(child.stdout, /pass 1/);
  });
}

for (const keep of [true, false].filter(value => process.env.AXIOM_TUI_FIX_TEST_ROOT && String(value) === process.env.AXIOM_TUI_FIX_TEST_KEEP)) test(`real fix graph reaches C7 and keyboard keep=${keep}`, async t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'calc.py'), 'old\n');
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests/test_calc.py'), '# existing reproduction fixture\n');
  const target = 'tests/test_calc.py::test_sub';
  const applied = patch('calc.py', 'fixed');
  const scripts: Record<string, MockResponse[]> = {
    reproduce: [{ toolCalls: [{ id: 'repro', name: 'submit_repro', arguments: { targetTests: [target] } }] }],
    locate: [{ toolCalls: [{ id: 'locate', name: 'submit_hypothesis', arguments: { hypothesis: 'Replace the faulty value.', files: ['calc.py'] } }] }],
    patch: [{ toolCalls: [{ id: 'patch', name: 'apply_patch', arguments: { patch: applied } }] }],
  };
  const provider = new MockProvider('mock');
  provider.setHandler(params => {
    const system = params.messages.find(m => m.role === 'system')?.content ?? '';
    const step = /Axiom \/fix, step: (\w+)/.exec(system)?.[1] ?? '';
    return scripts[step]?.shift() ?? { content: 'done' };
  });
  const store = new TuiStore();
  const controller = new TuiController(store, { workspaceRoot: root, mock: true });
  const stdin = tty(80); const stdout = tty(80); let output = '';
  stdout.on('data', chunk => { output += String(chunk); });
  const command = defaultCommandRouter.get('fix')!; const original = command.run;
  // Adapter chỉ thay provider/verifier; graph, tool execution, confirm và rendering đều dùng implementation thật.
  command.run = async (args, ctx) => {
    const report = await fixIssue({ issue: args, workspaceRoot: root, provider, model: 'mock', bus: ctx.bus,
      tools: ctx.tools, costTracker: ctx.costTracker, ui: ctx.ui, signal: ctx.signal,
      runTests: async () => {
        const fixed = fs.readFileSync(path.join(root, 'calc.py'), 'utf8') === 'fixed\n';
        return { passed: fixed ? [target] : [], failed: fixed ? [] : [target], skipped: [], errors: [],
          timedOut: false, complete: true, output: '', exitCode: fixed ? 0 : 1 };
      } });
    return { kind: 'fix-report', data: report, text: formatFixReport(report) };
  };
  const app = render(createElement(App, { store, controller, workspace: root, initial: '' }), {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false, exitOnCtrlC: false, interactive: true,
  });
  try {
    await pause(); const running = controller.submit('/fix reproduction fixture');
    await until(() => store.getSnapshot().pendingApproval?.name === 'confirm');
    assert.equal(fs.readFileSync(path.join(root, 'calc.py'), 'utf8'), 'fixed\n');
    stdin.write(keep ? 'y' : 'n'); await running;
    const turn = store.getSnapshot().entries.find(e => e.kind === 'fix-report');
    assert.ok(turn);
    const report = turn.data as FixReport;
    assert.equal(report.status, 'fixed');
    assert.equal(report.rounds.length, 1);
    assert.deepEqual(report.rounds[0].regressions, []);
    assert.equal(report.patch, keep ? applied : '');
    assert.equal(fs.readFileSync(path.join(root, 'calc.py'), 'utf8'), keep ? 'fixed\n' : 'old\n');
    await until(() => output.includes('Vòng 1/5'));
    for (const width of [80, 120]) {
      const frame = renderToString(createElement(Turn, { turn, width, expanded: false }), { columns: width });
      assert.ok(frame.includes('Vòng 1/5'));
      assert.equal(frame.includes('+fixed'), keep);
      assert.ok(frame.split('\n').every(line => visibleWidth(line) <= width));
    }
  } finally { command.run = original; controller.abort(); app.unmount(); store.dispose(); }
});

if (!process.env.AXIOM_TUI_FIX_TEST_ROOT) test('keyboard edited patch executes only revised args and rechecks secret paths', async t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'package.json'), 'old\n');
  fs.writeFileSync(path.join(root, 'note.txt'), 'old\n');
  const store = new TuiStore(); const tools = new ToolRegistry();
  tools.approver = request => new Promise(resolve => { store.requestApproval(request, resolve); store.flush(); });
  const controller = new TuiController(store, { workspaceRoot: root, mock: true });
  const stdin = tty(80);
  const app = render(createElement(App, { store, controller, workspace: root, initial: '' }), {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: tty(80) as unknown as NodeJS.WriteStream,
    patchConsole: false, exitOnCtrlC: false, interactive: true,
  });
  const tool = tools.getTool('apply_patch')!; const execute = tool.execute.bind(tool); const executed: unknown[] = [];
  tool.execute = async (args, ctx) => { executed.push(structuredClone(args)); return execute(args, ctx); };
  try {
    for (const secret of [false, true]) {
      const revised = patch(secret ? '.env' : 'note.txt', 'edited');
      const pending = tools.executeTool('apply_patch', { patch: patch('package.json', 'original') }, { workspaceRoot: root });
      await until(() => !!store.getSnapshot().pendingApproval);
      stdin.write('e'); await until(() => !!store.getSnapshot().approvalEdit);
      const text = JSON.stringify({ patch: revised });
      store.updateApprovalEdit({ text, cursor: text.length }); store.flush(); await pause();
      stdin.write('\r'); const result = await pending;
      assert.equal(result.isError, secret);
      assert.equal(executed.length, 1);
      assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), 'old\n');
      assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'edited\n');
      assert.equal(fs.existsSync(path.join(root, '.env')), false);
    }
    assert.deepEqual(executed, [{ patch: patch('note.txt', 'edited') }]);
    assert.ok(readAudit(30).some(e => e.decision === 'edited' && e.args.patch === patch('note.txt', 'edited')));
    assert.ok(readAudit(30).some(e => e.decision === 'deny'));
  } finally { store.cancelInteraction(); app.unmount(); store.dispose(); }
});
