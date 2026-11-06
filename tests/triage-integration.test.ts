// tests/triage-integration.test.ts - Command, CLI và TUI dùng graph/route thật với workflow giả.
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Annotation, START, END, StateGraph, MemorySaver } from '@langchain/langgraph';
import { createTriageCommand, triageCommand } from '../src/commands/triage.js';
import type { CommandContext } from '../src/commands/types.js';
import type { IssueTicket } from '../src/agents/triage.js';
import type { RouteDeps } from '../src/agents/route.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { createExecutionContext } from '../src/core/execution-context.js';
import { askHuman, runGraph } from '../src/core/human-gate.js';
import { runCli } from '../src/cli/index.js';
import { TuiController } from '../src/tui/controller.js';
import { TuiStore } from '../src/tui/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-triage-integration-'));
process.env.AXIOM_HOME = root;
process.env.AXIOM_CONFIG_PATH = path.join(root, 'config.json');
let providerBaseUrl: string;
function writeProvider(baseUrl: string): void {
  providerBaseUrl = baseUrl;
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: { 'test-a2': {
    api: 'openai-completions', baseUrl, auth: 'none',
    models: ['triage-model', 'answer-model', 'code-model', 'embed-model'].map(id => ({ id, contextWindow: 128000 })),
  } } }));
}
after(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Trên Windows, file handle còn mở có thể gây EPERM khi xoá thư mục tạm
  }
});

const config = { ...DEFAULT_CONFIG, defaultModel: 'test-a2/answer-model',
  enabledProviders: ['test-a2'], modelRoles: { smol: 'test-a2/triage-model',
    code: 'test-a2/code-model', embed: 'test-a2/embed-model' } };
let selected: IssueTicket['route'];
let calls: string[];
let requests: Array<{ model: string; input?: string[] }>;
let contexts: unknown[];
let failWorkflow: boolean;

const deps: RouteDeps = {
  answer: async (_issue, opts) => {
    calls.push('answer'); contexts.push(opts);
    assert.equal(opts.model, 'answer-model');
    // Index phải nhận định danh đã resolve, không nhận selector/alias trong config.
    assert.equal(opts.embedModel, `test-a2|openai-completions|${providerBaseUrl}|embed-model`);
    assert.deepEqual(await opts.embedder(['question']), [[1, 0]]);
    return { text: 'Answer from workflow', citations: [], found: true };
  },
  fix: async opts => {
    calls.push('fix'); contexts.push(opts);
    assert.equal(opts.model, 'code-model');
    if (failWorkflow) throw new Error('workflow failed');
    return { status: 'fixed', rounds: [], filesChanged: [], diffStat: { files: 0, added: 0, removed: 0 }, summary: 'Fixed once' };
  },
  feature: async (_issue, opts) => {
    calls.push('implement'); contexts.push(opts);
    assert.equal(opts.model, 'code-model');
    // Workflow con tự interrupt/resume; graph triage đã kết thúc nên không chạy lại route.
    const State = Annotation.Root({ approved: Annotation<boolean> });
    const graph = new StateGraph(State)
      .addNode('approve', async () => ({ approved: askHuman('Approve feature?', ['yes', 'no']) === 'yes' }))
      .addEdge(START, 'approve').addEdge('approve', END).compile({ checkpointer: new MemorySaver() });
    const result = await runGraph<typeof State.State>(graph, {}, { threadId: 'feature-test', ui: opts.ui! });
    return { threadId: 'feature-test', status: result.approved ? 'completed' : 'rejected', steps: [], filesChanged: [], summary: 'Feature finished' };
  },
};

// Chỉ thay workflow và fetch; command, graph, resolver và controller vẫn dùng code thật.
// Endpoint loopback giả bắt cả payload model và embedding, không gọi provider bên ngoài.
beforeEach(t => {
  selected = 'fix'; calls = []; requests = []; contexts = []; failWorkflow = false;
  writeProvider('http://127.0.0.1:1/v1');
  fs.writeFileSync(process.env.AXIOM_CONFIG_PATH!, JSON.stringify(config));
  t.mock.method(triageCommand, 'run', createTriageCommand(deps).run);
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.ok(String(url).startsWith(`${providerBaseUrl}/`), `Unexpected URL: ${url}`);
    const request = JSON.parse(String(init.body)); requests.push(request);
    if (String(url).endsWith('/embeddings')) {
      assert.equal(request.model, 'embed-model');
      return Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 7 } });
    }
    assert.equal(request.model, 'triage-model');
    const ticket: IssueTicket = { type: selected === 'reject' ? 'invalid' : 'bug', priority: 'P2 - test',
      route: selected, affected_files: [], reproduction_steps: [], acceptance_criteria: ['Testable outcome'],
      missing_info: selected === 'ask_user' ? ['Which version?'] : [] };
    const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'submit', function: {
      name: 'submit_issue_ticket', arguments: JSON.stringify({ ticket }),
    } }] } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
});

function context(approved: boolean): CommandContext {
  return { ...createExecutionContext(), workspaceRoot: root, config, signal: new AbortController().signal,
    ui: { print() {}, ask: async () => '', confirm: async () => approved },
    session: { get model(): never { throw new Error('Unexpected startup model'); }, setModel() {} } };
}

// Kiểm cả đường từ chối và duyệt cho từng workflow, đối chiếu trace với context phiên.
for (const route of ['answer', 'fix', 'implement'] as const) {
  for (const approved of [false, true]) {
    test(`command ${route}: approval=${approved}, route executes at most once`, async () => {
      selected = route;
      const ctx = context(approved);
      if (route !== 'answer') ctx.config = { ...config, modelRoles: { smol: config.modelRoles.smol, code: config.modelRoles.code } };
      const nodes: Array<{ node: string; phase: string; threadId?: string }> = [];
      ctx.bus.on('node', e => nodes.push(e));
      const result = await triageCommand.run('issue', ctx);
      assert.ok(result);
      assert.deepEqual(calls, approved ? [route] : []);
      assert.equal(requests.filter(r => r.model === 'triage-model').length, 1);
      assert.deepEqual(nodes.filter(e => e.node === 'route').map(e => e.phase), approved ? ['enter', 'exit'] : []);
      assert.equal(new Set(nodes.map(e => e.threadId)).size, 1);
      if (approved) {
        const passed = contexts[0] as { bus: unknown; tools?: unknown; costTracker: unknown; signal: unknown };
        assert.equal(passed.bus, ctx.bus); assert.equal(passed.costTracker, ctx.costTracker);
        assert.equal(passed.signal, ctx.signal);
        if (route !== 'answer') assert.equal(passed.tools, ctx.tools);
      } else assert.match(result.text, /Đã dừng theo yêu cầu/);
      assert.equal(requests.some(r => r.model === 'embed-model'), approved && route === 'answer');
      if (approved && route === 'answer') assert.equal(ctx.costTracker.getSessionSummary().byModel['embed-model'].promptTokens, 7);
    });
  }
}

for (const route of ['ask_user', 'reject'] as const) {
  test(`${route} returns schema fields without a second model or a confirmation`, async () => {
    selected = route;
    const ctx = context(false);
    ctx.ui.confirm = async () => { throw new Error('Unexpected confirmation'); };
    const result = await triageCommand.run('issue', ctx);
    assert.ok(result); assert.match(result.text, /P2 - test/);
    assert.match(result.text, route === 'ask_user' ? /Which version\?/ : /invalid/);
    assert.deepEqual(calls, []); assert.equal(requests.length, 1);
  });
}

test('answer resolves an embedding role alias before identifying the index', async () => {
  selected = 'answer';
  const ctx = context(true);
  ctx.config = { ...config, modelRoles: { ...config.modelRoles, embed: '@task', task: 'test-a2/embed-model' } };
  await triageCommand.run('issue', ctx);
  assert.deepEqual(calls, ['answer']);
  assert.ok(requests.some(r => r.model === 'embed-model'));
});

test('answer changes index identity when the endpoint changes under the same selector', async () => {
  selected = 'answer';
  const ctx = context(true);
  await triageCommand.run('issue', ctx);
  const firstIdentity = (contexts[0] as { embedModel: string }).embedModel;
  // Cùng provider/model và số chiều, nhưng endpoint mới có thể tạo vector khác nghĩa.
  // Route phải truyền identity mới để RepoIndex có thể dựng lại thay vì tái sử dụng index.
  writeProvider('http://127.0.0.1:2/v1');
  await triageCommand.run('issue', ctx);
  const secondIdentity = (contexts[1] as { embedModel: string }).embedModel;
  assert.notEqual(firstIdentity, secondIdentity);
  assert.equal(ctx.config.modelRoles?.embed, 'test-a2/embed-model');
  assert.deepEqual(calls, ['answer', 'answer']);
  assert.equal(requests.filter(r => r.model === 'embed-model').length, 2);
});

test('missing embed configuration errors before invoking answer workflow', async () => {
  selected = 'answer';
  const ctx = context(true); ctx.config = { ...config, modelRoles: { smol: config.modelRoles.smol } };
  await assert.rejects(triageCommand.run('issue', ctx), /modelRoles.embed/);
  assert.deepEqual(calls, []);
});

test('a failed workflow propagates once and does not emit a success exit', async () => {
  failWorkflow = true;
  const ctx = context(true); const phases: string[] = [];
  ctx.bus.on('node', e => { if (e.node === 'route') phases.push(e.phase); });
  await assert.rejects(triageCommand.run('issue', ctx), /workflow failed/);
  assert.deepEqual(calls, ['fix']); assert.deepEqual(phases, ['enter']);
});

test('cancelling while confirmation is pending never starts the workflow', async () => {
  const ctx = context(true);
  const controller = new AbortController();
  ctx.signal = controller.signal;
  ctx.ui.confirm = async () => { controller.abort(); return true; };
  await assert.rejects(triageCommand.run('issue', ctx), /abort|cancel/i);
  assert.deepEqual(calls, []);
});

// Chạy entry point headless thật để kiểm --yes và mặc định từ chối khi không có TTY.
for (const yes of [false, true]) {
  test(`headless CLI ${yes ? '--yes' : 'without TTY'} uses the command approval gate`, async t => {
    const output: string[] = [];
    t.mock.method(console, 'log', (text: string) => output.push(text));
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      await runCli(['triage', 'issue', ...(yes ? ['--yes'] : [])]);
      assert.deepEqual(calls, yes ? ['fix'] : []);
      assert.match(output.join('\n'), yes ? /Fixed once/ : /Đã dừng theo yêu cầu/);
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
}

// Slash command là lượt đầu tiên: TUI phải có approver dù chưa từng chạy chat tự do.
for (const reply of ['y', 'n']) {
  test(`first TUI /triage command waits for ${reply} and preserves session context`, { timeout: 5000 }, async () => {
    const store = new TuiStore();
    const controller = new TuiController(store, { workspaceRoot: root, mock: true });
    let questions = 0;
    const unsubscribe = store.subscribe(() => {
      if (store.getSnapshot().pendingApproval?.name === 'confirm') {
        questions++;
        store.resolveApproval(reply === 'y' ? 'approve' : 'deny');
      }
    });
    try {
      await controller.submit('/triage issue'); store.flush();
      assert.equal(questions, 1); assert.deepEqual(calls, reply === 'y' ? ['fix'] : []);
      assert.equal(store.getSnapshot().error, null);
      if (reply === 'y') assert.ok((contexts[0] as { tools: { approver?: unknown } }).tools.approver);
    } finally { unsubscribe(); store.dispose(); }
  });
}
