// evals/uc01/run.ts - Runner UC-01 dùng contract hiện hành và phép đo độc lập từng fixture.
import { fileURLToPath } from 'node:url';
import { runTriage, TriageSchemaError } from '../../src/agents/triage.js';
import { loadCatalog } from '../../src/llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../../src/llm/model-resolver.js';
import { measureCase } from '../measure.js';
import { hasProvider, loadCases, mockProvider, workspaceRoot } from '../run.js';
import type { UcCaseResult, UcRunner } from '../types.js';

// Tách cơ học khỏi registry, chưa thêm field/gate mới khi D0 chưa chốt contract.
// Mock chỉ kiểm pipeline; passed/typeAccuracy của mock không phải số đo model thật.
export const runUc01: UcRunner = async ({ mock, config }) => {
  const catalog = loadCatalog();
  const info = mock ? undefined : resolveModel('@smol', catalog, config);
  if (info && !hasProvider(config, info, catalog)) {
    throw new Error(`UC 01: provider ${info.provider} is not set up; run /login or pass --mock`);
  }
  const root = workspaceRoot('01');
  const cases: UcCaseResult[] = [];
  // Đường dẫn theo module để chạy từ thư mục nào vẫn dùng đúng bộ fixture cố định.
  for (const evalCase of loadCases(fileURLToPath(new URL('./', import.meta.url)))) {
    let hasSchemaFailure = false;
    const { value: ticket, error, ...usage } = await measureCase(evalCase.id, async tracker => {
      try {
        // Mỗi case có provider mới để mock không hết canned response sau case đầu.
        const provider = info ? await createProviderFor(info) : mockProvider();
        const result = await runTriage({ issue: evalCase.input, workspaceRoot: root,
          provider, model: info?.id, costTracker: tracker });
        return result.ticket;
      } catch (cause) {
        // Giữ phân biệt ticket sai schema với lỗi provider trước khi helper chuyển lỗi thành text.
        hasSchemaFailure = cause instanceof TriageSchemaError;
        throw cause;
      }
    });
    const typeCorrect = ticket?.type === evalCase.expected.type;
    const routeCorrect = ticket?.route === evalCase.expected.route;
    cases.push({ id: evalCase.id, passed: typeCorrect && routeCorrect,
      metrics: { schemaValid: ticket ? true : hasSchemaFailure ? false : null, typeCorrect, routeCorrect },
      ...usage, ...(error === undefined ? {} : { error }) });
  }
  // Giữ nguyên cách tính summary của registry cũ; acceptance gates thuộc bước sau khi chốt API.
  const rate = (key: string) => cases.length ? cases.filter(c => c.metrics[key] === true).length / cases.length : null;
  return { uc: '01', cases,
    summary: { schemaValidRate: rate('schemaValid'), typeAccuracy: rate('typeCorrect'), routeAccuracy: rate('routeCorrect') } };
};
