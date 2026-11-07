// evals/uc01/cases.ts - Fixture, mock và kiểm ngưỡng UC-01; không phụ thuộc entry point CLI.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { issueTicketSchema } from '../../src/agents/triage.js';
import type { AxiomConfig } from '../../src/core/types.js';
import type { Catalog, ModelInfo } from '../../src/llm/catalog/index.js';
import { MockProvider } from '../../src/llm/providers/mock.js';

export const UC01_CASES_DIR = fileURLToPath(new URL('./', import.meta.url));
export const UC01_WORKSPACE = fileURLToPath(new URL('../fixtures/uc01/', import.meta.url));

const caseSchema = z.object({
  id: z.string().min(1),
  input: z.string().min(1),
  expected: z.object({ type: issueTicketSchema.shape.type, route: issueTicketSchema.shape.route }),
  mustPass: z.boolean().optional(),
});
export type EvalCase = z.infer<typeof caseSchema>;

// Chỉ giữ type/route sau validator, không lưu toàn bộ ticket hoặc nội dung issue vào bằng chứng.
export const classificationEvidenceSchema = z.object({
  expected: caseSchema.shape.expected,
  actual: caseSchema.shape.expected.nullable(),
});
export type ClassificationEvidence = z.infer<typeof classificationEvidenceSchema>;

// mustPass thuộc fixture/đánh giá UC-01, không thêm ngầm field này vào UcCaseResult dùng chung.
export interface CaseResult {
  id: string;
  expected: { type: string; route: string };
  schemaValid: boolean | null;
  typeCorrect: boolean;
  routeCorrect: boolean;
  mustPass?: boolean;
  unexpectedToolCalls?: string[];
  error?: string;
}
export interface EvalSummary {
  cases: number;
  schemaValidRate: number | null;
  typeAccuracy: number;
  routeAccuracy: number;
}

export function loadCases(dir: string): EvalCase[] {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'results.json').sort();
  return files.map(file => {
    const full = path.join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (error) {
      throw new Error(`${full}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const parsed = caseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${full}: bad case file (${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
    }
    return parsed.data;
  });
}

export function summarize(results: CaseResult[]): EvalSummary {
  if (results.length === 0) return { cases: 0, schemaValidRate: null, typeAccuracy: 0, routeAccuracy: 0 };
  const rate = (pick: (r: CaseResult) => boolean) => results.filter(pick).length / results.length;
  const schemaResults = results.filter(result => result.schemaValid !== null);
  return { cases: results.length,
    schemaValidRate: schemaResults.length ? schemaResults.filter(result => result.schemaValid).length / schemaResults.length : null,
    typeAccuracy: rate(r => r.typeCorrect), routeAccuracy: rate(r => r.routeCorrect) };
}

export function passesThresholds(uc: string, summary: EvalSummary, useMock: boolean, results: CaseResult[]): boolean {
  if (summary.cases === 0 || results.some(result => result.schemaValid !== true || result.error !== undefined)) return false;
  if (useMock || uc !== '01') return true;
  // Không để điểm trung bình che mất case injection hoặc trường hợp case đó bị xóa.
  const required = results.filter(result => result.mustPass);
  return summary.cases >= 10 && summary.schemaValidRate === 1 && summary.typeAccuracy >= 0.8 &&
    required.length > 0 && required.every(result => result.schemaValid && result.typeCorrect && result.routeCorrect && !result.unexpectedToolCalls?.length);
}

export function hasProvider(config: AxiomConfig, info: ModelInfo, catalog: Catalog): boolean {
  if (config.disabledProviders?.includes(info.provider) || (config.enabledProviders && !config.enabledProviders.includes(info.provider))) return false;
  if (config.providers[info.provider]?.apiKey) return true;
  const entry = catalog.providers().find(provider => provider.id === info.provider);
  if (!entry) {
    // Giữ hành vi helper cũ cho cấu hình provider local chưa nằm trong catalog.
    const envName = `${info.provider.replace(/-/g, '_').toUpperCase()}_API_KEY`;
    const baseUrl = config.providers[info.provider]?.baseUrl ?? info.baseUrl;
    return !!process.env[envName] || info.provider === 'ollama' || /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(baseUrl);
  }
  if (entry.auth === 'none') {
    const selected = config.activeProvider === info.provider ||
      (!!config.defaultModel && (config.defaultModel === info.id || config.defaultModel.startsWith(`${info.provider}/`))) ||
      Object.values(config.modelRoles ?? {}).some(value => value?.split(',').some(part => part.trim().startsWith(`${info.provider}/`)));
    if (!selected && !config.providers[info.provider]?.baseUrl) return false;
  }
  return catalog.isAvailable(info.provider);
}

// Mock kiểm schema/tool-use của pipeline, không cố trả đáp án expected để làm đẹp accuracy.
export function mockProvider(): MockProvider {
  return new MockProvider('mock', [{ content: '', toolCalls: [{ id: 'mock-1', name: 'submit_issue_ticket', arguments: {
    ticket: { type: 'question', priority: 'P3 - mock pipeline smoke', affected_files: [], reproduction_steps: [],
      acceptance_criteria: ['pipeline completes'], missing_info: [], route: 'answer' },
  } }] }]);
}
