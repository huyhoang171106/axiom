// evals/run.ts - Điều phối registry UC, xuất artifact và không tự fallback sang mock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig } from '../src/core/config.js';
import { redact } from '../src/core/secrets.js';
import type { AxiomConfig } from '../src/core/types.js';
import { parseArgs, type EvalArgs } from './args.js';
import { UC_RUNNERS } from './registry.js';
import { evidenceSchema, gateSchema, provenanceSchema, releaseEvidenceErrors } from './evidence.js';
import { passesUc01 } from './uc01/run.js';
import { classificationEvidenceSchema } from './uc01/cases.js';
import type { UcResult, UcRunner } from './types.js';

const REQUIRED_UCS = ['01', '02', '03', '04', '05'];
// Chỉ full real mới xét release; metadata được giữ nguyên trong artifact để D0 đối chiếu.

// Kiểm đúng shape hiện hành trước khi tính trung bình; NaN/âm không được biến thành số 0 thành công.
const resultSchema = z.object({
  uc: z.string(),
  cases: z.array(z.object({
    id: z.string().min(1), passed: z.boolean(),
    metrics: z.record(z.string(), z.union([z.number(), z.boolean(), z.null()])),
    tokens: z.number().int().nonnegative(), costDollars: z.number().nonnegative(), latencyMs: z.number().nonnegative(),
    error: z.string().optional(),
    // Giữ bằng chứng riêng UC-01 qua zod; không passthrough payload tùy ý hoặc đổi contract các làn.
    classification: classificationEvidenceSchema.optional(),
    provenance: provenanceSchema.optional(), skipped: z.string().optional(),
  })),
  summary: z.record(z.string(), z.number().nullable()),
  gates: z.array(gateSchema).optional(), expectedCaseIds: evidenceSchema.shape.expectedCaseIds.optional(),
});

// Artifact thuộc bộ điều phối A3; không đổi UcResult/UcRunner dùng chung khi chưa chốt API.
export interface EvalReport {
  runAt: string;
  mock: boolean;
  scope: 'all' | 'selected';
  partial: boolean;
  requestedUcs: string[];
  missingUcs: string[];
  ucs: UcResult[];
  errors: string[];
  passed: boolean;
  releaseEligible: boolean;
  releaseBlockers: string[];
}

export async function runEvaluation(args: EvalArgs, opts: {
  config: AxiomConfig;
  runners: Readonly<Record<string, UcRunner>>;
  workDir: string;
  outputFile: string;
}): Promise<EvalReport> {
  const requestedUcs = args.all ? [...new Set([...REQUIRED_UCS, ...Object.keys(opts.runners)])].sort() : args.ucs;
  const missingUcs = requestedUcs.filter(uc => !opts.runners[uc]);
  const report: EvalReport = {
    runAt: new Date().toISOString(), mock: args.mock, scope: args.all ? 'all' : 'selected', partial: args.partial,
    requestedUcs: [...requestedUcs], missingUcs, ucs: [], errors: [], passed: false, releaseEligible: false,
    releaseBlockers: [],
  };
  if (args.mock) report.releaseBlockers.push('Mock smoke is not a real eval');
  if (!args.all) report.releaseBlockers.push('Selected run is not a full release');
  if (args.partial) report.releaseBlockers.push('Partial run is development only');
  for (const uc of requestedUcs) {
    const runner = opts.runners[uc];
    if (!runner) {
      if (!args.partial) report.errors.push(`UC ${uc}: missing runner`);
      continue;
    }
    try {
      // Mỗi UC có thư mục riêng dưới workDir của run, không làm bẩn fixture hoặc repo gốc.
      if (!/^\d{2}$/.test(uc)) throw new Error('UC id must be a two-digit number');
      const workDir = path.join(opts.workDir, `uc${uc}`);
      fs.mkdirSync(workDir, { recursive: true });
      const parsed = resultSchema.safeParse(await runner({ mock: args.mock, config: opts.config, workDir }));
      if (!parsed.success) throw new Error(`invalid runner result (${parsed.error.issues.map(i => i.path.join('.')).join(', ')})`);
      const result = parsed.data;
      if (result.uc !== uc) throw new Error(`runner returned UC ${result.uc}`);
      if (!result.cases.length) throw new Error('runner returned zero cases');
      if (new Set(result.cases.map(c => c.id)).size !== result.cases.length) throw new Error('runner returned duplicate case ids');
      const average = (pick: (c: UcResult['cases'][number]) => number) => result.cases.reduce((sum, c) => sum + pick(c), 0) / result.cases.length;
      result.summary = { ...result.summary, avgTokens: average(c => c.tokens),
        avgCostDollars: average(c => c.costDollars), avgLatencyMs: average(c => c.latencyMs) };
      // Error trong artifact cũng phải redact, không chỉ thông báo runner throw ở catch.
      for (const c of result.cases) if (c.error !== undefined) c.error = redact(c.error);
      report.ucs.push(result);
      const evidenceErrors = releaseEvidenceErrors(result, args.mock).map(error => `UC ${uc}: ${error}`);
      report.releaseBlockers.push(...evidenceErrors);
      // Development vẫn hỗ trợ runner cũ; bằng chứng đã khai báo mà sai thì không được bỏ qua.
      if (result.gates !== undefined || result.expectedCaseIds !== undefined) report.errors.push(...evidenceErrors);
      const isMockMismatch = (c: { provenance?: CaseProvenance }) => {
        if (!c.provenance) return false;
        if (uc === '05' && c.provenance.mock === true) return false;
        return c.provenance.mock !== args.mock;
      };
      if (result.gates?.some(g => !g.passed) || result.cases.some(c => c.skipped !== undefined || isMockMismatch(c))) {
        report.errors.push(`UC ${uc}: failed gate, skipped case or mock provenance mismatch`);
      }
      // Gate của chủ UC chấm ngưỡng tổng thể (ví dụ UC-03 >= 4/10), không ép mọi case thành công.
      // Chỉ tin gate khi đủ bằng chứng; runner cũ chưa khai báo vẫn phải pass từng case ở development.
      const passed = uc === '01' ? passesUc01(result, args.mock)
        : evidenceErrors.length === 0 || result.cases.every(c => c.passed);
      if (!passed || result.cases.some(c => c.error !== undefined)) report.errors.push(`UC ${uc}: case errors or acceptance checks failed`);
    } catch (error) {
      // Runner khác vẫn được chạy để artifact giữ bằng chứng phần đã hoàn thành, không bịa case có usage 0.
      report.errors.push(redact(`UC ${uc}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (!report.ucs.length) report.errors.push('No UC results were produced');
  // Thiếu runner và lỗi execution luôn chặn release, kể cả partial đang cho phép tiếp tục smoke.
  for (const uc of missingUcs) report.releaseBlockers.push(`UC ${uc}: missing runner`);
  if (args.all && !args.mock && !args.partial) report.errors.push(...report.releaseBlockers);
  report.passed = report.errors.length === 0;
  report.releaseBlockers = [...new Set([...report.releaseBlockers, ...report.errors])];
  report.releaseEligible = args.all && !args.mock && !args.partial && report.passed && report.releaseBlockers.length === 0;
  fs.mkdirSync(path.dirname(opts.outputFile), { recursive: true });
  fs.writeFileSync(opts.outputFile, `${redact(JSON.stringify(report, null, 2))}\n`);
  return report;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  // Parse trước khi đọc config để thiếu flag không vô tình khởi động model/provider thật.
  const args = parseArgs(argv);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-eval-run-'));
  const outputFile = path.resolve('evals/results.json');
  try {
    const report = await runEvaluation(args, { config: loadConfig(), runners: UC_RUNNERS, workDir, outputFile });
    for (const uc of report.missingUcs) console.log(`UC ${uc}: chưa có runner${args.partial ? ' (development partial)' : ''}`);
    for (const result of report.ucs) console.log(`UC ${result.uc}: ${result.cases.length} cases`);
    if (args.mock) console.log('Mock pipeline smoke only; metrics are not evidence of real model accuracy.');
    if (args.partial || !args.all) console.log('Development run; not a full release evaluation.');
    for (const error of report.errors) console.error(redact(error));
    console.log(`Results: ${outputFile}`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
