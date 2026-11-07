// evals/uc02/run.ts - UC-02 eval: Recall@5, citation validity and abstention of /ask on workspace/tinydb

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { answerQuestion } from '../../src/agents/ask.js';
import { TEAM_DOCS_DIR } from '../../src/core/rag/chunker.js';
import { checkSupport, findCitations, validateCitation } from '../../src/core/rag/citations.js';
import { createEmbedder, embedIdentity, embedModelFromConfig, fakeEmbedder } from '../../src/core/rag/embedder.js';
import { RepoIndex } from '../../src/core/rag/index.js';
import type { Embedder, ScoredChunk } from '../../src/core/rag/types.js';
import type { BaseLLMProvider, ChatParams } from '../../src/llm/base-provider.js';
import { loadCatalog } from '../../src/llm/catalog/index.js';
import type { CostTracker } from '../../src/llm/cost-tracker.js';
import { createProviderFor, resolveModel } from '../../src/llm/model-resolver.js';
import { MockProvider } from '../../src/llm/providers/mock.js';
import type { CaseProvenance, EvidencedUcResult } from '../evidence.js';
import { measureCase } from '../measure.js';
import type { UcCaseResult, UcResult, UcRunner } from '../types.js';
import { hasProvider } from '../uc01/cases.js';

/** Topic threshold for UC-02 (phase-2.md section 10). */
export const MIN_RECALL_AT_5 = 0.8;

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

/**
 * Mock answer: one sentence citing the first excerpt and naming a word from it, so it passes the same
 * validation as a real answer. Exercises retrieval, prompt and validation only, never answer quality.
 */
export function mockAskProvider(): MockProvider {
  const provider = new MockProvider('mock');
  provider.callLimit = 100;
  provider.setHandler((params) => {
    const excerpt = /^### (\S+:L\d+-L\d+) \(.*\)\n(.*)/m.exec(params.messages.at(-1)?.content ?? '');
    const word = excerpt && /[A-Za-z_]\w{3,}/.exec(excerpt[2])?.[0];
    return excerpt && word ? `The excerpt ${excerpt[1]} defines ${word}.` : 'No excerpt was given.';
  });
  return provider;
}

/** Keeps every reply of the wrapped provider, so the eval can grade the model's own last answer before /ask strips it. */
function recordReplies(provider: BaseLLMProvider): { provider: BaseLLMProvider; replies: string[] } {
  const replies: string[] = [];
  const recording: BaseLLMProvider = Object.create(provider);
  recording.chat = async (params: ChatParams) => {
    const result = await provider.chat(params);
    replies.push(result.content.trim());
    return result;
  };
  return { provider: recording, replies };
}

/** Gold units of the question that appear in the top 5; team docs never count as a repo file. */
function goldFound(hits: readonly ScoredChunk[], q: Uc02Question): number {
  return q.expected.filter((e) => hits.some((h) => (h.source ?? 'repo') === 'repo' && h.path === e.path && h.startLine <= e.endLine && e.startLine <= h.endLine)).length;
}

export interface Uc02CaseOptions {
  workDir: string;
  createProvider: () => Promise<BaseLLMProvider>;
  model: string;
  /** Built per case with that case's tracker, so embedding usage lands on the case. */
  embedder: (tracker: CostTracker) => Embedder;
  embedModel: string;
  /** Team conventions indexed beside the repo, as /ask does; undefined searches the repo only. */
  teamDir?: string;
}

/** Runs every question; a case error is recorded on the case, never thrown. */
export async function runUc02Cases(questions: readonly Uc02Question[], opts: Uc02CaseOptions): Promise<UcResult> {
  const base = path.join(opts.workDir, 'uc02-base');
  const baseIndex = path.join(opts.workDir, 'uc02-base.index');
  copyRepo(TINYDB_ROOT, base);

  const cases: UcCaseResult[] = [];
  for (const q of questions) {
    // The first case also pays for embedding the base index; later ones reuse it.
    const measured = await measureCase(q.id, async (tracker) => {
      let root = base;
      let indexDir = baseIndex;
      if (q.edit) {
        // A copy of the built base index, so the update re-embeds only the edited file, as after a real edit.
        root = path.join(opts.workDir, q.id);
        indexDir = path.join(opts.workDir, `${q.id}.index`);
        copyRepo(base, root);
        if (fs.existsSync(baseIndex)) fs.cpSync(baseIndex, indexDir, { recursive: true });
        applyEdit(root, q.edit);
      }
      const embedder = opts.embedder(tracker);
      const index = await RepoIndex.open(root, embedder, { dir: indexDir, embedModel: opts.embedModel, teamDir: opts.teamDir });
      const hits = await index.search(q.question, 5);
      const { provider, replies } = recordReplies(await opts.createProvider());
      const answer = await answerQuestion(q.question, {
        workspaceRoot: root, provider, model: opts.model, embedder, embedModel: opts.embedModel, indexDir, teamDir: opts.teamDir, costTracker: tracker,
      });
      const last = replies.at(-1) ?? '';
      const cited = findCitations(last);
      const validCited = cited.filter((c) => (validateCitation(c.citation, index.root, hits, opts.teamDir) ?? checkSupport(c.claim, c.citation, hits)) === null).length;
      const found = goldFound(hits, q);
      return {
        answered: answer.found,
        goldFound: q.kind === 'absent' ? null : found,
        goldTotal: q.kind === 'absent' ? null : q.expected.length,
        recallAt5: q.kind === 'absent' ? null : found / q.expected.length,
        citations: cited.length,
        validCitations: validCited,
        citationsValid: cited.length ? validCited / cited.length : null,
        abstained: q.kind === 'absent' ? !answer.found : null,
        // After an edit the top 5 must hold the new text, not the stale chunk.
        freshAfterEdit: q.edit ? hits.some((h) => h.path === q.edit!.file && h.text.includes(q.edit!.replace.trim())) : null,
      };
    });
    const m = measured.value;
    const passed = !!m && (q.kind === 'absent'
      ? m.abstained === true && m.validCitations === m.citations
      : m.answered && m.recallAt5 === 1 && m.citations > 0 && m.validCitations === m.citations && m.freshAfterEdit !== false);
    cases.push({
      id: q.id,
      passed,
      metrics: m ?? { answered: null, goldFound: null, goldTotal: q.kind === 'absent' ? null : q.expected.length, recallAt5: null, citations: null, validCitations: null, citationsValid: null, abstained: null, freshAfterEdit: null },
      tokens: measured.tokens,
      costDollars: measured.costDollars,
      latencyMs: measured.latencyMs,
      ...(measured.error !== undefined ? { error: measured.error } : {}),
    });
  }
  return { uc: '02', cases, summary: summarizeUc02(cases) };
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * Recall@5 = gold units found / gold units over the answerable questions (a crashed case counts its gold as missed).
 * citationsValid = valid / all citations in the model's last answers. Abstention is reported on its own.
 */
export function summarizeUc02(cases: readonly UcCaseResult[]): UcResult['summary'] {
  const answerable = cases.filter((c) => c.metrics.goldTotal !== null);
  const absent = cases.filter((c) => c.metrics.goldTotal === null);
  const goldTotal = answerable.reduce((s, c) => s + num(c.metrics.goldTotal), 0);
  const citations = cases.reduce((s, c) => s + num(c.metrics.citations), 0);
  const fresh = cases.filter((c) => c.metrics.freshAfterEdit === true).length;
  const afterEdit = cases.filter((c) => typeof c.metrics.freshAfterEdit === 'boolean').length;
  return {
    recallAt5: goldTotal ? answerable.reduce((s, c) => s + num(c.metrics.goldFound), 0) / goldTotal : null,
    citationsValid: citations ? cases.reduce((s, c) => s + num(c.metrics.validCitations), 0) / citations : null,
    abstentionRate: absent.length ? absent.filter((c) => c.metrics.abstained === true).length / absent.length : null,
    answeredRate: answerable.length ? answerable.filter((c) => c.metrics.answered === true).length / answerable.length : null,
    freshAfterEditRate: afterEdit ? fresh / afterEdit : null,
    passRate: cases.length ? cases.filter((c) => c.passed).length / cases.length : null,
  };
}

/**
 * Recomputed from the cases. Real run: every expected case without error, Recall@5 >= 0.8, every citation valid,
 * and every after-edit question sees the new text. Mock: the pipeline ran every case and every citation validated.
 */
export function passesUc02(result: UcResult, mock: boolean, expected: readonly string[]): boolean {
  const ids = result.cases.map((c) => c.id);
  if (result.uc !== '02' || ids.length !== expected.length || new Set(ids).size !== ids.length || !expected.every((id) => ids.includes(id))) return false;
  if (result.cases.some((c) => c.error !== undefined)) return false;
  const s = summarizeUc02(result.cases);
  if (s.citationsValid !== 1) return false;
  if (mock) return true;
  // null freshness means no after-edit question in the set; a crashed one already failed on its error above.
  return (s.recallAt5 ?? 0) >= MIN_RECALL_AT_5 && (s.freshAfterEditRate ?? 1) === 1;
}

export const runUc02: UcRunner = async ({ mock, config, workDir }) => {
  const questions = loadQuestions();
  const catalog = loadCatalog();
  const info = mock ? undefined : resolveModel('@default', catalog, config);
  if (info && !hasProvider(config, info, catalog)) throw new Error(`UC 02: provider ${info.provider} is not set up; run /login or pass --mock`);
  // Same models and sources as /ask (src/commands/ask.ts), so the eval measures the command users run.
  const embedInfo = mock ? undefined : embedModelFromConfig(config);
  const result = await runUc02Cases(questions, {
    workDir,
    createProvider: async () => (info ? createProviderFor(info) : mockAskProvider()),
    model: info?.id ?? 'mock',
    embedder: (tracker) => (embedInfo ? createEmbedder(embedInfo, { costTracker: tracker }) : fakeEmbedder()),
    embedModel: embedInfo ? embedIdentity(embedInfo) : 'fake',
    teamDir: TEAM_DOCS_DIR,
  });
  const provenance: CaseProvenance = {
    mock,
    models: [
      { provider: info?.provider ?? 'mock', model: info?.id ?? 'mock', role: 'default' },
      { provider: embedInfo?.provider ?? 'mock', model: embedInfo?.id ?? 'fake-embedder', role: 'embed' },
    ],
  };
  const expectedCaseIds = questions.map((q) => q.id);
  const evidenced: EvidencedUcResult = {
    ...result,
    cases: result.cases.map((c) => ({ ...c, provenance })),
    expectedCaseIds,
    gates: [{ id: mock ? 'uc02-pipeline-smoke' : 'uc02-acceptance', passed: passesUc02(result, mock, expectedCaseIds) }],
  };
  return evidenced;
};
