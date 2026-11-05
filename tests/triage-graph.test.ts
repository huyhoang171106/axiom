// tests/triage-graph.test.ts - Kiểm checkpoint duyệt và dispatch route không lặp workflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTriageGraph, type TriageGraphState, type IssueTicket } from '../src/agents/triage.js';
import { runGraph } from '../src/core/human-gate.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { createExecutionContext } from '../src/core/execution-context.js';
import { runRoute } from '../src/agents/route.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

process.env.AXIOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-a2-'));
const ticket = (route: IssueTicket['route']): IssueTicket => ({ type: 'bug', priority: 'P1 - crash',
  affected_files: [], reproduction_steps: [], acceptance_criteria: ['works'], missing_info: [], route });

// Mỗi route được thử cả yes/no: route thụ động không hỏi, route chủ động chỉ hỏi một lần.
// Số lần gọi provider giúp phát hiện node triage bị chạy lại khi confirm resume.
for (const route of ['fix', 'implement', 'answer', 'ask_user', 'reject'] as const) {
  for (const approved of [true, false]) {
    test(`${route}: confirm ${approved}, triage does not replay on resume`, async () => {
      const ctx = createExecutionContext();
      let questions = 0;
      const ui = { print() {}, ask: async () => '', confirm: async () => { questions++; return approved; } };
      const provider = new MockProvider('mock', [{ content: '', toolCalls: [
        { id: 'submit', name: 'submit_issue_ticket', arguments: { ticket: ticket(route) } },
      ] }]);
      const nodes: string[] = [];
      ctx.bus.on('node', e => { if (e.phase === 'exit') nodes.push(e.node); });
      const graph = buildTriageGraph({ issue: 'crash', workspaceRoot: process.cwd(), provider, ...ctx });
      const result = await runGraph<TriageGraphState>(graph, { issue: 'crash' }, { threadId: `${route}-${approved}`, ui });
      const passive = route === 'ask_user' || route === 'reject';
      assert.equal(result.confirmed, passive || approved);
      assert.equal(questions, passive ? 0 : 1);
      assert.equal(provider.callHistory.length, 1);
      assert.deepEqual(nodes, ['triage', 'confirm']);
    });
  }
}

// Không cấu hình @embed để chứng minh route sửa/code không phụ thuộc RAG.
for (const route of ['fix', 'implement'] as const) {
  test(`${route} calls workflow once with resolved model and session context, without embedding config`, async () => {
    const execution = createExecutionContext();
    const ctx = { ...execution, workspaceRoot: process.cwd(), config: { ...DEFAULT_CONFIG, activeProvider: 'mock' },
      ui: { print() {}, ask: async () => '', confirm: async () => true }, signal: new AbortController().signal };
    let calls = 0;
    const check = (opts: { model: string; tools: unknown; costTracker?: unknown }) => {
      calls++; assert.ok(!opts.model.startsWith('@')); assert.equal(opts.tools, ctx.tools);
      assert.equal(opts.costTracker, ctx.costTracker);
    };
    const result = await runRoute(ticket(route), 'crash', ctx, {
      answer: async () => { throw new Error('wrong route'); },
      fix: async opts => { check(opts); return { status: 'fixed', rounds: [], filesChanged: [], diffStat: { files: 0, added: 0, removed: 0 }, summary: 'fixed' }; },
      feature: async (_issue, opts) => { check(opts); return { threadId: 'feature', status: 'completed', steps: [], filesChanged: [], summary: 'built' }; },
    });
    assert.equal(calls, 1); assert.equal(result.route, route);
  });
}
