// evals/uc02/run.ts - UC-02 eval: Recall@5 and citation validity of /ask on workspace/tinydb

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { answerQuestion, type AskAnswer } from '../../src/agents/ask.js';
import { parseCitations, validateCitation } from '../../src/core/rag/citations.js';
import { embedderFromConfig, fakeEmbedder } from '../../src/core/rag/embedder.js';
import { RepoIndex } from '../../src/core/rag/index.js';
import type { Embedder, ScoredChunk } from '../../src/core/rag/types.js';
import type { BaseLLMProvider } from '../../src/llm/base-provider.js';
import { loadCatalog } from '../../src/llm/catalog/index.js';
import { CostTracker } from '../../src/llm/cost-tracker.js';
import { createProviderFor, resolveModel } from '../../src/llm/model-resolver.js';
import { MockProvider } from '../../src/llm/providers/mock.js';
import type { UcCaseResult, UcRunner } from '../types.js';

const rangeSchema = z.object({ path: z.string().min(1), startLine: z.number().int().min(1), endLine: z.number().int().min(1) });
export const questionSchema = z.object({
  id: z.string().regex(/^uc02-\d{2}$/),
  kind: z.enum(['locate', 'flow', 'howto', 'absent', 'after-edit']),
  question: z.string().min(1),
  expected: z.array(rangeSchema),
  edit: z.object({ file: z.string().min(1), find: z.string().min(1), replace: z.string() }).nullable(),
});
export type Uc02Question = z.infer<typeof questionSchema>;

export const QUESTIONS_FILE = fileURLToPath(new URL('./questions.json', import.meta.url));
export const TINYDB_ROOT = fileURLToPath(new URL('../../workspace/tinydb/', import.meta.url));
const COPY_SKIPPED = new Set(['.venv', '__pycache__', '.git', 'node_modules', '.pytest_cache', '.mypy_cache']);

export function loadQuestions(file = QUESTIONS_FILE): Uc02Question[] {
  return z.array(questionSchema).parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function copyRepo(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, filter: (src) => !COPY_SKIPPED.has(path.basename(src)) });
}

function applyEdit(root: string, edit: NonNullable<Uc02Question['edit']>): void {
  const file = path.join(root, edit.file);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(edit.find)) throw new Error(`edit: "${edit.find}" not found in ${edit.file}`);
  fs.writeFileSync(file, text.replace(edit.find, edit.replace));
}

/** Mock answer: cites the first excerpt it was given, so only the pipeline (retrieval, prompt, validation) is exercised. */
export function mockAskProvider(): MockProvider {
  const provider = new MockProvider('mock');
  provider.setHandler((params) => {
    const header = /^### (\S+):L(\d+)-L(\d+)/m.exec(params.messages.at(-1)?.content ?? '');
    return header ? `Mock: ${header[1]}:L${header[2]}-L${header[3]}` : 'Mock: no excerpt';
  });
  return provider;
}

function overlapsExpected(hits: readonly ScoredChunk[], q: Uc02Question): boolean {
  return hits.some((h) => q.expected.some((e) => e.path === h.path && h.startLine <= e.endLine && e.startLine <= h.endLine));
}

/** Share of citations in the final text that are valid; the warning line names dropped ones, so they count against it. */
function citationValidity(answer: AskAnswer, root: string, hits: readonly ScoredChunk[]): number {
  const cited = parseCitations(answer.text);
  if (cited.length === 0) return 1;
  return cited.filter((c) => validateCitation(c, root, hits) === null).length / cited.length;
}

export const runUc02: UcRunner = async ({ mock, config, workDir }) => {
  const questions = loadQuestions();
  const info = mock ? undefined : resolveModel('@default', loadCatalog(), config);
  const base = path.join(workDir, 'uc02-base');
  const baseIndex = path.join(workDir, 'uc02-base.index');
  copyRepo(TINYDB_ROOT, base);

  const cases: UcCaseResult[] = [];
  for (const q of questions) {
    // TODO(A3): replace this inline measurement with measureCase from evals/measure.ts.
    const tracker = new CostTracker();
    const started = performance.now();
    const measured = () => {
      const s = tracker.getSessionSummary();
      return { tokens: s.totalPromptTokens + s.totalCompletionTokens, costDollars: s.totalCostDollars, latencyMs: performance.now() - started };
    };
    try {
      let root = base;
      let indexDir = baseIndex;
      if (q.edit) {
        // A copy of the built base index, so the update re-embeds only the edited file, as after a real edit.
        root = path.join(workDir, q.id);
        indexDir = path.join(workDir, `${q.id}.index`);
        copyRepo(base, root);
        if (fs.existsSync(baseIndex)) fs.cpSync(baseIndex, indexDir, { recursive: true });
        applyEdit(root, q.edit);
      }
      const embedder: Embedder = mock ? fakeEmbedder() : embedderFromConfig(config, { costTracker: tracker });
      const embedModel = mock ? 'fake' : config.modelRoles?.embed;
      const provider: BaseLLMProvider = info ? await createProviderFor(info) : mockAskProvider();
      const hits = await (await RepoIndex.open(root, embedder, { dir: indexDir, embedModel })).search(q.question, 5);
      const answer = await answerQuestion(q.question, { workspaceRoot: root, provider, model: info?.id ?? 'mock', embedder, embedModel, costTracker: tracker, indexDir });
      const recallAt5 = q.kind === 'absent' ? (answer.found ? 0 : 1) : overlapsExpected(hits, q) ? 1 : 0;
      const citationsValid = citationValidity(answer, fs.realpathSync(root), hits);
      const passed = recallAt5 === 1 && citationsValid === 1 && answer.found === (q.kind !== 'absent');
      cases.push({ id: q.id, passed, metrics: { recallAt5, citationsValid, found: answer.found }, ...measured() });
    } catch (error) {
      cases.push({ id: q.id, passed: false, metrics: { recallAt5: 0, citationsValid: null, found: null }, ...measured(), error: error instanceof Error ? error.message : String(error) });
    }
  }
  const mean = (key: string) => {
    const values = cases.map((c) => c.metrics[key]).filter((v): v is number => typeof v === 'number');
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  };
  return {
    uc: '02',
    cases,
    summary: {
      recallAt5: mean('recallAt5'),
      citationsValid: mean('citationsValid'),
      passRate: cases.length ? cases.filter((c) => c.passed).length / cases.length : null,
    },
  };
};
