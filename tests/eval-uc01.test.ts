// tests/eval-uc01.test.ts - Kiểm runner UC-01 tách riêng, giữ contract hiện hành và phép đo từng case.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUc01, runUc01Cases } from '../evals/uc01/run.js';
import { runEvaluation } from '../evals/run.js';
import { parseArgs } from '../evals/args.js';
import { UC_RUNNERS } from '../evals/registry.js';
import { loadCases } from '../evals/uc01/cases.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { registerSecret } from '../src/core/secrets.js';
import { loadCatalog } from '../src/llm/catalog/index.js';
import type { ChatParams, ChatResult } from '../src/llm/base-provider.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { evidenceSchema, provenanceSchema, releaseEvidenceErrors } from '../evals/evidence.js';

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
  const evidence = evidenceSchema.parse(result);
  assert.deepEqual(evidence.expectedCaseIds, fixtures.map(c => c.id));
  assert.deepEqual(evidence.gates, [{ id: 'uc01-pipeline-smoke', passed: true }]);
  assert.deepEqual(releaseEvidenceErrors(result, true), []);
  for (const c of result.cases) {
    const parsed = provenanceSchema.parse('provenance' in c ? c.provenance : undefined);
    assert.deepEqual(parsed, { mock: true, models: [{ provider: 'mock', model: 'mock', role: 'smol' }] });
  }
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
    assert.deepEqual(c.metrics, { schemaValid: true, typeCorrect: true, routeCorrect: true, unexpectedToolCalls: 0 });
    assert.deepEqual('classification' in c ? c.classification : undefined,
      { expected: fixtures[i].expected, actual: fixtures[i].expected });
  });
});

test('schema failures preserve all retry usage and are not marked as provider failures', async t => {
  t.mock.method(MockProvider.prototype, 'chat', async () => reply({}));
  const result = await runUc01(options);
  assert.equal(result.cases.length, 10);
  for (const c of result.cases) {
    assert.equal(c.passed, false);
    assert.equal(c.metrics.schemaValid, false);
    assert.deepEqual('classification' in c ? c.classification : undefined,
      { expected: fixtures.find(f => f.id === c.id)!.expected, actual: null });
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
    assert.deepEqual('classification' in c ? c.classification : undefined,
      { expected: fixtures.find(f => f.id === c.id)!.expected, actual: null });
    assert.equal(c.tokens, 7);
    assert.equal(c.costDollars, 0.001);
    assert.ok(c.error?.includes(c.id));
    assert.match(c.error!, /provider unavailable/);
  }
});

test('wrong predictions survive artifact parsing without copying fixture answers', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  const outputFile = path.join(root, 'wrong-predictions.json');
  const report = await runEvaluation(parseArgs(['--uc', '01', '--mock']), {
    config: DEFAULT_CONFIG, runners: { '01': runUc01 }, workDir: root, outputFile,
  });
  assert.equal(report.passed, true); // Mock chỉ kiểm pipeline, không giả vờ đạt accuracy thật.
  const artifact = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  const actual = { type: 'question', route: 'answer' };
  for (const [i, c] of artifact.ucs[0].cases.entries()) {
    assert.deepEqual(c.classification, { expected: fixtures[i].expected, actual });
    assert.equal(c.metrics.typeCorrect, fixtures[i].expected.type === actual.type);
    assert.equal(c.metrics.routeCorrect, fixtures[i].expected.route === actual.route);
    assert.ok(c.tokens > 0);
  }
  assert.equal(artifact.ucs[0].cases[0].metrics.typeCorrect, false);
  assert.equal(artifact.releaseEligible, false);
});

test('failed prediction artifacts retain null actual and usage while redacting errors', async t => {
  // Giá trị giả đăng ký cục bộ chỉ kiểm đường redaction, không dùng credential thật.
  const sensitive = `uc01-fake-${process.pid}-${Date.now()}`;
  registerSecret(sensitive);
  let calls = 0;
  t.mock.method(MockProvider.prototype, 'chat', async () => {
    if (++calls % 2 === 1) return reply({});
    throw new Error(`provider unavailable ${sensitive}`);
  });
  const outputFile = path.join(root, 'failed-predictions.json');
  const report = await runEvaluation(parseArgs(['--uc', '01', '--mock']), {
    config: DEFAULT_CONFIG, runners: { '01': runUc01 }, workDir: root, outputFile,
  });
  assert.equal(report.passed, false);
  const serialized = fs.readFileSync(outputFile, 'utf8');
  assert.equal(serialized.includes(sensitive), false);
  const artifact = JSON.parse(serialized);
  for (const [i, c] of artifact.ucs[0].cases.entries()) {
    assert.deepEqual(c.classification, { expected: fixtures[i].expected, actual: null });
    assert.equal(c.metrics.schemaValid, null);
    assert.equal(c.tokens, 7);
    assert.equal(c.costDollars, 0.001);
    assert.match(c.error, /provider unavailable/);
  }
});

test('actual route records the validated ticket rather than the raw model route', async () => {
  const expected = { type: 'bug' as const, route: 'ask_user' as const };
  const result = await runUc01Cases([{ id: 'validated-route', input: 'The application is slow', expected }], {
    workspaceRoot: root,
    createCaseProvider: async () => ({ provider: new MockProvider('mock', [reply({
      type: 'bug', route: 'fix', priority: 'P2 - needs clarification', affected_files: [], reproduction_steps: [],
      acceptance_criteria: ['Specify the slow operation'], missing_info: ['Which operation is slow?'],
    })]) }),
  });
  assert.deepEqual('classification' in result.cases[0] ? result.cases[0].classification : undefined,
    { expected, actual: expected });
  assert.equal(result.cases[0].metrics.routeCorrect, true);
  assert.equal(result.cases[0].tokens, 7);
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
