// src/agents/ask.ts - UC-02: answer a question about the repo with `path:Lx-Ly` citations

import type { EventBus } from '../core/event-bus.js';
import { parseCitations, validateCitation } from '../core/rag/citations.js';
import { RepoIndex } from '../core/rag/index.js';
import type { Chunk, Citation, Embedder } from '../core/rag/types.js';
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
}

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
  'Do not cite files or lines that are not in the excerpts. Do not use outside knowledge about the project.',
  `If the excerpts do not contain the answer, reply with exactly: ${NOT_FOUND_TEXT}`,
  'Answer in the language of the question.',
].join('\n');

function contextBlock(chunks: readonly Chunk[]): string {
  return chunks.map((c) => `### ${c.path}:L${c.startLine}-L${c.endLine} (${c.symbol ?? c.kind})\n${c.text}`).join('\n\n');
}

function check(text: string, root: string, retrieved: readonly Chunk[]): { valid: Citation[]; errors: string[] } {
  const valid: Citation[] = [];
  const errors: string[] = [];
  for (const c of parseCitations(text)) {
    const reason = validateCitation(c, root, retrieved);
    if (reason) errors.push(`${c.path}:L${c.startLine}-L${c.endLine}: ${reason}`);
    else valid.push(c);
  }
  return { valid, errors };
}

export async function answerQuestion(question: string, opts: AskOptions): Promise<AskAnswer> {
  const notFound: AskAnswer = { text: NOT_FOUND_TEXT, citations: [], found: false };
  const index = await RepoIndex.open(opts.workspaceRoot, opts.embedder, { dir: opts.indexDir, embedModel: opts.embedModel });
  const retrieved = await index.search(question, TOP_K);
  if (!retrieved.some((c) => c.score >= MIN_SCORE)) return notFound;

  const tracker = opts.costTracker ?? defaultCostTracker;
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Excerpts:\n\n${contextBlock(retrieved)}\n\nQuestion: ${question}` },
  ];
  const chat = async (): Promise<string> => {
    const result = await opts.provider.chat({ model: opts.model, messages, signal: opts.signal });
    tracker.record(opts.model, result.usage);
    opts.bus?.emit('cost_update', result.usage);
    return result.content.trim();
  };

  let text = await chat();
  let { valid, errors } = check(text, index.root, retrieved);
  if (errors.length > 0) {
    // One retry with the reasons: a model usually fixes an off-by-some line range when told which one is wrong.
    messages.push(
      { role: 'assistant', content: text },
      { role: 'user', content: `These citations are invalid:\n${errors.map((e) => `- ${e}`).join('\n')}\nRewrite the answer citing only lines inside the excerpts.` }
    );
    text = await chat();
    ({ valid, errors } = check(text, index.root, retrieved));
    if (errors.length > 0) text = `${text}\n\n(Đã bỏ ${errors.length} trích dẫn không hợp lệ: ${errors.join('; ')})`;
  }
  if (valid.length === 0) return notFound;
  return { text, citations: valid, found: true };
}
