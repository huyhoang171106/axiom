// tests/eval-uc01.test.ts - Kiểm runner UC-01 tách riêng, giữ contract hiện hành và phép đo từng case.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUc01 } from '../evals/uc01/run.js';
import { UC_RUNNERS } from '../evals/registry.js';
import { loadCases } from '../evals/run.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { loadCatalog } from '../src/llm/catalog/index.js';
import type { ChatParams, ChatResult } from '../src/llm/base-provider.js';
import { MockProvider } from '../src/llm/providers/mock.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-eval-uc01-'));
const previousHome = process.env.AXIOM_HOME;
process.env.AXIOM_HOME = root;
after(() => {
  if (previousHome === undefined) delete process.env.AXIOM_HOME;
  else process.env.AXIOM_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});
const fixtures = loadCases(fileURLToPath(new URL('../evals/uc01/', import.meta.url)));
const options = { mock: true, config: DEFAULT_CONFIG, workDir: root };

// Chỉ giả response của model; runner, AgentLoop, submit tool và tracker chạy code thật.
// Số đo dưới đây kiểm plumbing, không được dùng làm độ chính xác eval với model thật.
function reply(ticket: unknown, turn = 1): ChatResult {
  return { content: '', toolCalls: [{ id: `submit-${turn}`, name: 'submit_issue_ticket', arguments: { ticket } }],
    usage: { promptTokens: 5 * turn, completionTokens: 2 * turn, totalTokens: 7 * turn, costEstimate: turn / 1000 } };
}
function issue(params: ChatParams): string {
  return params.messages.find(m => m.role === 'user')!.content;
}

test('registry points to the extracted UC-01 runner and preserves all ten fixture results', async t => {
  // Chặn mạng để mock smoke không vô tình gọi provider thật khi tách module.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  assert.equal(UC_RUNNERS['01'], runUc01);
  const result = await runUc01(options);
  assert.equal(result.uc, '01');
  assert.equal(result.cases.length, 10);
  assert.deepEqual(result.cases.map(c => c.id), fixtures.map(c => c.id));
  assert.equal(result.summary.schemaValidRate, 1);
  const rate = (key: string) => result.cases.filter(c => c.metrics[key] === true).length / 10;
  assert.equal(result.summary.typeAccuracy, rate('typeCorrect'));
  assert.equal(result.summary.routeAccuracy, rate('routeCorrect'));
  assert.ok(result.cases.every(c => c.metrics.schemaValid === true && c.tokens > 0 && c.latencyMs >= 0 && !c.error));
});

test('each fixture gets a fresh provider and isolated usage with the existing result shape', async t => {
  const providers = new Set<MockProvider>();
  let turns = 0;
  t.mock.method(MockProvider.prototype, 'chat', async function(this: MockProvider, params: ChatParams) {
    providers.add(this);
    const fixture = fixtures.find(c => c.input === issue(params))!;
    assert.ok(fixture);
    return reply({ ...fixture.expected, priority: 'P2 - deterministic test', affected_files: [], reproduction_steps: [],
      acceptance_criteria: ['Check the expected classification'], missing_info: [] }, ++turns);
  });
  const result = await runUc01(options);
  assert.equal(providers.size, 10);
  assert.deepEqual(result.summary, { schemaValidRate: 1, typeAccuracy: 1, routeAccuracy: 1 });
  result.cases.forEach((c, i) => {
    assert.equal(c.passed, true);
    assert.equal(c.tokens, 7 * (i + 1));
    assert.equal(c.costDollars, (i + 1) / 1000);
    assert.deepEqual(c.metrics, { schemaValid: true, typeCorrect: true, routeCorrect: true });
  });
});

test('schema failures preserve all retry usage and are not marked as provider failures', async t => {
  t.mock.method(MockProvider.prototype, 'chat', async () => reply({}));
  const result = await runUc01(options);
  assert.equal(result.cases.length, 10);
  for (const c of result.cases) {
    assert.equal(c.passed, false);
    assert.equal(c.metrics.schemaValid, false);
    assert.equal(c.tokens, 21);
    assert.equal(c.costDollars, 0.003);
    assert.ok(c.error?.includes(c.id));
    assert.match(c.error!, /schema after 3 attempts/);
  }
});

test('provider failure after a retry preserves usage and unknown schema validity', async t => {
  const attempts = new Map<string, number>();
  t.mock.method(MockProvider.prototype, 'chat', async (params: ChatParams) => {
    const count = (attempts.get(issue(params)) ?? 0) + 1;
    attempts.set(issue(params), count);
    // Lượt đầu tốn token nhưng ticket sai; lượt sau provider lỗi trước khi có ticket hợp lệ.
    if (count === 1) return reply({});
    throw new Error('provider unavailable');
  });
  const result = await runUc01(options);
  for (const c of result.cases) {
    assert.equal(c.passed, false);
    assert.equal(c.metrics.schemaValid, null);
    assert.equal(c.tokens, 7);
    assert.equal(c.costDollars, 0.001);
    assert.ok(c.error?.includes(c.id));
    assert.match(c.error!, /provider unavailable/);
  }
});

test('real runner rejects a disabled configured provider instead of falling back to mock', async t => {
  const model = loadCatalog().models('ollama')[0];
  assert.ok(model);
  let mockCalls = 0;
  t.mock.method(MockProvider.prototype, 'chat', async () => { mockCalls++; return reply({}); });
  const config = { ...DEFAULT_CONFIG, modelRoles: { smol: `${model.provider}/${model.id}` }, disabledProviders: [model.provider] };
  await assert.rejects(runUc01({ ...options, mock: false, config }), /turned off/);
  assert.equal(mockCalls, 0);
});
