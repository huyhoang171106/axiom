// evals/uc01/run.ts - Runner UC-01 và kiểm ngưỡng từ fixture, độc lập với entry point CLI.
import { runTriage, TriageSchemaError } from '../../src/agents/triage.js';
import { loadCatalog } from '../../src/llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../../src/llm/model-resolver.js';
import type { BaseLLMProvider } from '../../src/llm/base-provider.js';
import { measureCase } from '../measure.js';
import { hasProvider, loadCases, mockProvider, passesThresholds, summarize,
  UC01_CASES_DIR, UC01_WORKSPACE, type CaseResult, type EvalCase } from './cases.js';
import type { UcCaseResult, UcResult, UcRunner } from '../types.js';
import type { CaseProvenance, EvidencedUcResult } from '../evidence.js';

// Seam nội bộ UC-01 giúp test case/provider lỗi mà không sửa fixture thật hay gọi mạng.
export async function runUc01Cases(fixtures: readonly EvalCase[], opts: {
  workspaceRoot: string;
  createCaseProvider: () => Promise<{ provider: BaseLLMProvider; model?: string }>;
}): Promise<UcResult> {
  const cases: UcCaseResult[] = [];
  for (const fixture of fixtures) {
    let hasSchemaFailure = false;
    let unexpectedToolCalls = 0;
    const { value: ticket, error, ...usage } = await measureCase(fixture.id, async tracker => {
      try {
        const { provider, model } = await opts.createCaseProvider();
        const result = await runTriage({ issue: fixture.input, workspaceRoot: opts.workspaceRoot,
          provider, model, costTracker: tracker,
          // Đếm cả lệnh model định gọi dù registry đã chặn; injection không được coi là đạt chỉ vì policy cứu lại.
          onToolCall: name => { if (!['read_file', 'search_code', 'submit_issue_ticket'].includes(name)) unexpectedToolCalls++; },
        });
        return result.ticket;
      } catch (cause) {
        // Phân biệt ticket sai schema với lỗi provider trước khi helper chuyển lỗi thành text.
        hasSchemaFailure = cause instanceof TriageSchemaError;
        throw cause;
      }
    });
    const typeCorrect = ticket?.type === fixture.expected.type;
    const routeCorrect = ticket?.route === fixture.expected.route;
    cases.push({ id: fixture.id,
      passed: typeCorrect && routeCorrect && (!fixture.mustPass || unexpectedToolCalls === 0),
      // Dùng metrics mở rộng sẵn có; không thêm field vào contract UcCaseResult của các làn khác.
      metrics: { schemaValid: ticket ? true : hasSchemaFailure ? false : null, typeCorrect, routeCorrect, unexpectedToolCalls },
      ...usage, ...(error === undefined ? {} : { error }) });
  }
  const rate = (key: string) => cases.length ? cases.filter(c => c.metrics[key] === true).length / cases.length : null;
  return { uc: '01', cases,
    summary: { schemaValidRate: rate('schemaValid'), typeAccuracy: rate('typeCorrect'), routeAccuracy: rate('routeCorrect') } };
}

// Mock chỉ kiểm pipeline; accuracy của mock không phải số đo model thật.
export const runUc01: UcRunner = async ({ mock, config }) => {
  const catalog = loadCatalog();
  const info = mock ? undefined : resolveModel('@smol', catalog, config);
  if (info && !hasProvider(config, info, catalog)) {
    throw new Error(`UC 01: provider ${info.provider} is not set up; run /login or pass --mock`);
  }
  const fixtures = loadCases(UC01_CASES_DIR);
  const result = await runUc01Cases(fixtures, {
    workspaceRoot: UC01_WORKSPACE,
    // Provider mới mỗi case để mock không hết canned response sau fixture đầu.
    createCaseProvider: async () => ({ provider: info ? await createProviderFor(info) : mockProvider(), model: info?.id }),
  });
  // Provenance lấy từ model đã resolve, không suy đoán provider từ tracker hoặc ghi config chứa credential.
  const provenance: CaseProvenance = { mock, models: [{ provider: info?.provider ?? 'mock',
    model: info?.id ?? 'mock', role: 'smol' }] };
  const evidenced: EvidencedUcResult = { ...result,
    cases: result.cases.map(c => ({ ...c, provenance })),
    expectedCaseIds: fixtures.map(c => c.id),
    gates: [{ id: mock ? 'uc01-pipeline-smoke' : 'uc01-acceptance', passed: passesUc01(result, mock, fixtures) }],
  };
  return evidenced;
};

// Giữ gate UC-01 khi bỏ CLI triage cũ: tính lại từ case, không tin summary do runner khai báo.
export function passesUc01(result: UcResult, mock: boolean, fixtures: readonly EvalCase[] = loadCases(UC01_CASES_DIR)): boolean {
  const ids = new Set(fixtures.map(c => c.id));
  const actualIds = new Set(result.cases.map(c => c.id));
  if (result.uc !== '01' || !fixtures.length || ids.size !== fixtures.length || actualIds.size !== result.cases.length ||
    result.cases.length !== fixtures.length || result.cases.some(c => !ids.has(c.id))) return false;
  const checked: CaseResult[] = [];
  for (const fixture of fixtures) {
    const c = result.cases.find(c => c.id === fixture.id)!;
    const count = c.metrics.unexpectedToolCalls;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return false;
    checked.push({ id: c.id, expected: fixture.expected, mustPass: fixture.mustPass,
      schemaValid: c.metrics.schemaValid === null ? null : c.metrics.schemaValid === true,
      typeCorrect: c.metrics.typeCorrect === true, routeCorrect: c.metrics.routeCorrect === true,
      unexpectedToolCalls: count > 0 ? ['unexpected tool calls'] : [], error: c.error });
  }
  return passesThresholds('01', summarize(checked), mock, checked);
}
