// evals/run.ts - Eval runner: run evals/uc<NN>/ cases through runTriage and write results.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { issueTicketSchema, runTriage } from '../src/agents/triage.js';
import { loadConfig } from '../src/core/config.js';
import type { AxiomConfig } from '../src/core/types.js';
import { loadCatalog } from '../src/llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../src/llm/model-resolver.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import type { BaseLLMProvider } from '../src/llm/base-provider.js';

const caseSchema = z.object({
  id: z.string().min(1),
  input: z.string().min(1),
  expected: z.object({ type: issueTicketSchema.shape.type, route: issueTicketSchema.shape.route }),
});

export type EvalCase = z.infer<typeof caseSchema>;

export interface CaseResult {
  id: string;
  expected: { type: string; route: string };
  actual?: { type: string; route: string };
  schemaValid: boolean;
  typeCorrect: boolean;
  routeCorrect: boolean;
  error?: string;
}

export interface EvalSummary {
  cases: number;
  schemaValidRate: number;
  typeAccuracy: number;
  routeAccuracy: number;
}

export function parseArgs(argv: string[]): { uc?: string; mock: boolean } {
  const mock = argv.includes('--mock');
  const flag = argv.indexOf('--uc');
  if (flag === -1) {
    if (argv.some((a) => a.startsWith('--uc'))) throw new Error('Usage: --uc <NN>, e.g. --uc 01');
    return { mock };
  }
  const uc = argv[flag + 1];
  if (!uc || uc.startsWith('-')) throw new Error('Usage: --uc <NN>, e.g. --uc 01');
  if (!/^\d{2}$/.test(uc)) throw new Error(`--uc expects a two-digit number, got "${uc}"`);
  return { uc, mock };
}

export function loadCases(dir: string): EvalCase[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'results.json').sort();
  return files.map((file) => {
    const full = path.join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (error) {
      throw new Error(`${full}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const parsed = caseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${full}: bad case file (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
    }
    return parsed.data;
  });
}

export function summarize(results: CaseResult[]): EvalSummary {
  if (results.length === 0) return { cases: 0, schemaValidRate: 0, typeAccuracy: 0, routeAccuracy: 0 };
  const rate = (pick: (r: CaseResult) => boolean): number => results.filter(pick).length / results.length;
  return {
    cases: results.length,
    schemaValidRate: rate((r) => r.schemaValid),
    typeAccuracy: rate((r) => r.typeCorrect),
    routeAccuracy: rate((r) => r.routeCorrect),
  };
}

export function passesThresholds(uc: string, summary: EvalSummary, useMock: boolean): boolean {
  return useMock || uc !== '01' || (summary.cases > 0 && summary.schemaValidRate === 1 && summary.typeAccuracy >= 0.8);
}

/** Any API-looking env var or a configured provider key counts as "a key is available". */
function hasProviderKey(config: AxiomConfig): boolean {
  if (Object.values(config.providers).some((provider) => provider?.apiKey)) return true;
  return Object.entries(process.env).some(([name, value]) => !!value && /API_KEY$/.test(name));
}

/** Pipeline smoke ticket: mock mode exercises the full loop; its metrics are not meaningful. */
function mockProvider(): MockProvider {
  return new MockProvider('mock', [
    {
      content: '',
      toolCalls: [
        {
          id: 'mock-1',
          name: 'submit_issue_ticket',
          arguments: {
            ticket: {
              type: 'question',
              priority: 'P3 - mock pipeline smoke',
              affected_files: [],
              reproduction_steps: [],
              acceptance_criteria: ['pipeline completes'],
              missing_info: [],
              route: 'answer',
            },
          },
        },
      ],
    },
  ]);
}

async function realProvider(config: AxiomConfig): Promise<BaseLLMProvider> {
  return createProviderFor(resolveModel('@default', loadCatalog(), config));
}

function workspaceRoot(): string {
  const bundled = path.join(process.cwd(), 'workspace');
  return fs.existsSync(bundled) ? bundled : fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-eval-'));
}

async function runUc(ucDir: string, useMock: boolean, config: AxiomConfig, root: string): Promise<boolean> {
  const uc = path.basename(ucDir).replace(/^uc/, '');
  const cases = loadCases(ucDir);
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    const provider = useMock ? mockProvider() : await realProvider(config);
    try {
      const { ticket } = await runTriage({ issue: evalCase.input, workspaceRoot: root, provider });
      const actual = { type: ticket.type, route: ticket.route };
      const result: CaseResult = {
        id: evalCase.id,
        expected: evalCase.expected,
        actual,
        schemaValid: true,
        typeCorrect: actual.type === evalCase.expected.type,
        routeCorrect: actual.route === evalCase.expected.route,
      };
      results.push(result);
      console.log(`${result.typeCorrect && result.routeCorrect ? 'ok  ' : 'FAIL'} ${evalCase.id} -> ${actual.type}/${actual.route} (expected ${evalCase.expected.type}/${evalCase.expected.route})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ id: evalCase.id, expected: evalCase.expected, schemaValid: false, typeCorrect: false, routeCorrect: false, error: message });
      console.log(`FAIL ${evalCase.id} ${message}`);
    }
  }
  const summary = summarize(results);
  const output = { uc, mock: useMock, ...summary, results };
  fs.writeFileSync(path.join(ucDir, 'results.json'), `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `uc${uc}${useMock ? ' (mock)' : ''}: ${summary.cases} cases, schema ${summary.schemaValidRate.toFixed(3)}, ` +
      `type ${summary.typeAccuracy.toFixed(3)}, route ${summary.routeAccuracy.toFixed(3)} -> ${path.join(ucDir, 'results.json')}`
  );
  if (useMock) console.log('Mock metrics are not representative; this run is a pipeline smoke check.');
  const passed = passesThresholds(uc, summary, useMock);
  if (!passed) console.error(`uc${uc} failed: requires 100% schema validity and at least 80% type accuracy.`);
  return passed;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { uc, mock } = parseArgs(argv);
  const evalsDir = path.dirname(fileURLToPath(import.meta.url));
  const ucDirs = uc
    ? [path.join(evalsDir, `uc${uc}`)]
    : fs.readdirSync(evalsDir).filter((d) => /^uc\d+$/.test(d)).sort().map((d) => path.join(evalsDir, d));
  if (ucDirs.length === 0) throw new Error(`No eval case directories under ${evalsDir}`);
  for (const dir of ucDirs) {
    if (!fs.existsSync(dir)) throw new Error(`No eval cases for --uc ${uc}: ${dir} does not exist`);
  }
  const config = loadConfig();
  const useMock = mock || !hasProviderKey(config);
  if (useMock && !mock) console.log('No provider key found; running in mock mode (metrics are not meaningful).');
  const root = workspaceRoot();
  for (const dir of ucDirs) {
    if (!(await runUc(dir, useMock, config, root))) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
