// src/agents/ask.ts - UC-02: answer a question about the repo with `path:Lx-Ly` citations

import type { EventBus } from '../core/event-bus.js';
import { checkSupport, citationKey, findCitations, validateCitation, type CitationInText } from '../core/rag/citations.js';
import { RepoIndex } from '../core/rag/index.js';
import type { Chunk, Citation, Embedder, ScoredChunk } from '../core/rag/types.js';
import type { Message } from '../core/types.js';
import type { BaseLLMProvider } from '../llm/base-provider.js';
import { defaultCostTracker, type CostTracker } from '../llm/cost-tracker.js';

export interface AskOptions {
  workspaceRoot: string;
  provider: BaseLLMProvider;
  model: string;
  embedder: Embedder;
  signal?: AbortSignal;
  bus?: EventBus;
  /** Records every chat call (eval tokens and cost per case); defaults to defaultCostTracker. */
  costTracker?: CostTracker;
  /** Identity of the embedder (`embedIdentity`: provider, wire, endpoint, model tag); a different one than the stored index rebuilds it. */
  embedModel?: string;
  /** Where the index lives; default `~/.axiom/index/<hash of root>`. Eval keeps it inside its temp dir. */
  indexDir?: string;
  /** The team's conventions to index as source 'team' (`TEAM_DOCS_DIR` for /ask); without it only the repo is searched. */
  teamDir?: string;
  /** Picks the excerpts the answer may use (/ask: `rerankedSearch`); default the top 5 of a single search. */
  retrieve?: (question: string, index: RepoIndex) => Promise<ScoredChunk[]>;
}

/** What a retrieval step needs to call the model and account for it. */
export type ModelCall = Pick<AskOptions, 'provider' | 'model' | 'signal' | 'bus' | 'costTracker'>;

export interface AskAnswer {
  text: string;
  citations: Citation[];
  found: boolean;
}

export const NOT_FOUND_TEXT = 'Không tìm thấy trong repo.';
/** Below this best hybrid score nothing retrieved is about the question, so the model is not asked. Tuned in B5. */
export const MIN_SCORE = 0.25;
const TOP_K = 5;

const SYSTEM_PROMPT = [
  'You answer questions about a code repository using ONLY the excerpts given in the user message.',
  'Every claim must cite its source as path:Lx-Ly (for example tinydb/table.py:L10-L25), using line numbers inside the excerpt it comes from.',
  'Put each citation in the same sentence as its claim, and name in that sentence the function, class or term the cited lines contain.',
  'Excerpts headed team:<path> are the team conventions; cite them with the same prefix, for example team:team-conventions.md:L3-L5.',
  'Do not cite files or lines that are not in the excerpts. Do not use outside knowledge about the project.',
  `If the excerpts do not contain the answer, reply with exactly: ${NOT_FOUND_TEXT}`,
  'Answer in the language of the question.',
].join('\n');

/** Each candidate searched per query in `rerankedSearch`. */
export const POOL_PER_QUERY = 16;
/** Lines of each candidate the reranker sees; enough for the signature and docstring. */
const RERANK_PREVIEW_LINES = 14;

export const REWRITE_PROMPT = [
  'You turn a question about a code repository into search queries for a code search engine.',
  'Write 1 to 3 short English queries, one per line, nothing else.',
  'If answering needs several parts of the code (a call path across files, or both documentation examples and implementation for how-to questions), give one query per part.',
  'Use likely function, class, file or module names.',
].join('\n');

export const RERANK_PROMPT = [
  'You pick code and documentation excerpts that a developer needs to answer a question about a repository.',
  'Candidates are numbered. Reply with the numbers of the 5 most useful candidates, most useful first, comma-separated, nothing else.',
  'Prefer the code and documentation that actually show and implement what the question asks about, including every file on the path the question describes, over tests and broad class overviews.',
].join('\n');

const label = (c: Chunk): string => `${c.source === 'team' ? 'team:' : ''}${c.path}`;

const STOP_WORDS = new Set(['field', 'fields', 'document', 'documents', 'database', 'tinydb', 'every', 'when', 'what', 'does', 'call', 'reach', 'from', 'with', 'this', 'that', 'have', 'user']);

function previewChunk(c: Chunk, query: string, lines = RERANK_PREVIEW_LINES): string {
  const allLines = c.text.split('\n');
  if (allLines.length <= lines) return c.text;
  const terms = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  const matchIdx = allLines.findIndex((line) => terms.some((t) => line.toLowerCase().includes(t)));
  if (matchIdx > 0) {
    const start = Math.max(0, matchIdx - 2);
    return allLines.slice(start, start + lines).join('\n');
  }
  return allLines.slice(0, lines).join('\n');
}

function contextBlock(chunks: readonly Chunk[]): string {
  return chunks.map((c) => `### ${label(c)}:L${c.startLine}-L${c.endLine} (${c.symbol ?? c.kind})\n${c.text}`).join('\n\n');
}

async function chatOnce(call: ModelCall, messages: Message[]): Promise<string> {
  const result = await call.provider.chat({ model: call.model, messages, signal: call.signal });
  (call.costTracker ?? defaultCostTracker).record(call.model, result.usage);
  call.bus?.emit('cost_update', result.usage);
  return result.content.trim();
}

/**
 * Top 5 for questions whose answer spans several files, where one hybrid search keeps only the main file: the model
 * rewrites the question into up to 3 queries, the candidates of all queries are pooled, and the model picks 5.
 * A question with no relevant chunk costs no model call; an unreadable pick falls back to the first search's order.
 */
export async function rerankedSearch(question: string, index: RepoIndex, call: ModelCall): Promise<ScoredChunk[]> {
  const first = await index.search(question, POOL_PER_QUERY);
  if (!first.some((c) => c.score >= MIN_SCORE)) return first.slice(0, TOP_K);
  const ask = (system: string, user: string) => chatOnce(call, [{ role: 'system', content: system }, { role: 'user', content: user }]);
  const queries = (await ask(REWRITE_PROMPT, question))
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
  const rawPool = [...first];
  for (const query of queries) {
    for (const c of await index.search(query, POOL_PER_QUERY)) if (!rawPool.some((p) => p.id === c.id)) rawPool.push(c);
  }
  const pool = [
    ...rawPool.filter((c) => !c.path.startsWith('tests/')),
    ...rawPool.filter((c) => c.path.startsWith('tests/')),
  ];
  const listing = pool
    .map((c, i) => `[${i + 1}] ${label(c)}:L${c.startLine}-L${c.endLine} (${c.symbol ?? c.kind})\n${previewChunk(c, question)}`)
    .join('\n\n');
  const picked = [...(await ask(RERANK_PROMPT, `Question: ${question}\n\nCandidates:\n\n${listing}`)).matchAll(/\d+/g)]
    .map((m) => Number(m[0]))
    .filter((n) => n >= 1 && n <= pool.length)
    .map((n) => pool[n - 1]);
  const top: ScoredChunk[] = [];
  for (const c of [...picked, ...first]) if (top.length < TOP_K && !top.includes(c)) top.push(c);
  return top;
}

interface Checked extends CitationInText { reason: string | null }

/** Each citation in the text with why it fails (null = valid): the source and range, then whether its lines back its sentence. */
function check(text: string, root: string, retrieved: readonly Chunk[], teamDir: string | undefined): Checked[] {
  return findCitations(text).map((found) => ({
    ...found,
    reason: validateCitation(found.citation, root, retrieved, teamDir) ?? checkSupport(found.claim, found.citation, retrieved),
  }));
}

/** Valid citations, once each. */
function validCitations(checked: readonly Checked[]): Citation[] {
  const byKey = new Map<string, Citation>();
  for (const c of checked) if (!c.reason) byKey.set(citationKey(c.citation), c.citation);
  return [...byKey.values()];
}

function describeErrors(checked: readonly Checked[], text: string): string[] {
  return checked.filter((c) => c.reason).map((c) => `${text.slice(c.start, c.end)}: ${c.reason}`);
}

/**
 * Removes every failed citation from the text so none is shown. A line whose citations all failed goes with them: its claim
 * has no checked source left. A line that keeps a valid citation loses only the failed ones.
 */
function stripInvalid(text: string, checked: readonly Checked[]): string {
  const kept: string[] = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const lineEnd = lineStart + line.length;
    const here = checked.filter((c) => c.start >= lineStart && c.end <= lineEnd);
    const failed = here.filter((c) => c.reason).sort((a, b) => b.start - a.start);
    if (failed.length === 0) kept.push(line);
    else if (failed.length < here.length) {
      let rest = line;
      for (const c of failed) rest = rest.slice(0, c.start - lineStart) + rest.slice(c.end - lineStart);
      kept.push(rest.replace(/\(\s*\)|\[\s*\]/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1'));
    }
    lineStart = lineEnd + 1;
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function answerQuestion(question: string, opts: AskOptions): Promise<AskAnswer> {
  const notFound: AskAnswer = { text: NOT_FOUND_TEXT, citations: [], found: false };
  const index = await RepoIndex.open(opts.workspaceRoot, opts.embedder, { dir: opts.indexDir, embedModel: opts.embedModel, teamDir: opts.teamDir });
  const retrieved = opts.retrieve ? await opts.retrieve(question, index) : await index.search(question, TOP_K);
  if (!retrieved.some((c) => c.score >= MIN_SCORE)) return notFound;

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Excerpts:\n\n${contextBlock(retrieved)}\n\nQuestion: ${question}` },
  ];
  const chat = (): Promise<string> => chatOnce(opts, messages);

  let text = await chat();
  let checked = check(text, index.root, retrieved, opts.teamDir);
  if (checked.some((c) => c.reason)) {
    // One retry with the reasons: a model usually fixes an off-by-some line range when told which one is wrong.
    messages.push(
      { role: 'assistant', content: text },
      { role: 'user', content: `These citations are invalid:\n${describeErrors(checked, text).map((e) => `- ${e}`).join('\n')}\nRewrite the answer citing only lines inside the excerpts that contain what each sentence says.` }
    );
    text = await chat();
    checked = check(text, index.root, retrieved, opts.teamDir);
    const failed = checked.filter((c) => c.reason).length;
    if (failed > 0) {
      text = stripInvalid(text, checked);
      checked = check(text, index.root, retrieved, opts.teamDir);
      if (checked.some((c) => c.reason)) return notFound;
      text = `${text}\n\n(Đã bỏ ${failed} trích dẫn không hợp lệ cùng câu không còn nguồn.)`;
    }
  }
  const valid = validCitations(checked);
  if (valid.length === 0) return notFound;
  return { text, citations: valid, found: true };
}
