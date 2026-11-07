// evals/evidence.ts - Bằng chứng release bổ sung, không đổi chữ ký runner dùng chung trước khi D0 kiểm tra.
import { z } from 'zod';
import { MODEL_ROLES } from '../src/core/types.js';
import type { UcResult } from './types.js';

export const provenanceSchema = z.object({
  mock: z.boolean(),
  models: z.array(z.object({
    provider: z.string().trim().min(1), model: z.string().trim().min(1), role: z.enum(MODEL_ROLES),
  })).min(1),
});
export const gateSchema = z.object({ id: z.string().trim().min(1), passed: z.boolean(), reason: z.string().optional() });
export const evidenceSchema = z.object({
  gates: z.array(gateSchema).min(1),
  expectedCaseIds: z.array(z.string().trim().min(1)).min(1),
});
export type CaseProvenance = z.infer<typeof provenanceSchema>;
export type EvidencedUcResult = UcResult & z.infer<typeof evidenceSchema> & {
  cases: Array<UcResult['cases'][number] & { provenance: CaseProvenance; skipped?: string }>;
};

// Thiếu metadata không phải pass: runner cũ vẫn chạy development nhưng chưa chứng minh đủ điều kiện release.
export function releaseEvidenceErrors(result: UcResult & {
  gates?: z.infer<typeof gateSchema>[]; expectedCaseIds?: string[];
  cases: Array<UcResult['cases'][number] & { provenance?: CaseProvenance; skipped?: string }>;
}, mock: boolean): string[] {
  const errors: string[] = [];
  const evidence = evidenceSchema.safeParse(result);
  if (!evidence.success) errors.push('missing release acceptance/provenance contract evidence');
  else {
    const { gates, expectedCaseIds } = evidence.data;
    if (new Set(gates.map(g => g.id)).size !== gates.length) errors.push('duplicate gate ids');
    for (const gate of gates) if (!gate.passed) errors.push(`gate ${gate.id} failed`);
    const expected = new Set(expectedCaseIds);
    if (expected.size !== expectedCaseIds.length) errors.push('duplicate expected case ids');
    if (result.cases.length !== expected.size || result.cases.some(c => !expected.has(c.id)) ||
      new Set(result.cases.map(c => c.id)).size !== result.cases.length) errors.push('missing, duplicate or unexpected cases');
  }
  for (const c of result.cases) {
    if (c.skipped !== undefined) errors.push(`case ${c.id} was skipped`);
    const provenance = provenanceSchema.safeParse(c.provenance);
    if (!provenance.success) errors.push(`case ${c.id} missing model provenance`);
    else {
      // UC-05 kiểm tra cổng an toàn và phê duyệt rủi ro bằng kịch bản model tất định (scripted model),
      // nên được phép giữ provenance.mock: true trong full release mà không bị coi là giả mạo.
      const allowScriptedMock = result.uc === '05' && provenance.data.mock === true;
      if (!allowScriptedMock && provenance.data.mock !== mock) {
        errors.push(`case ${c.id} mock provenance mismatch`);
      }
    }
  }
  return errors;
}
