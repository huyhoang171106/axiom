// src/commands/ask.ts - `ask` command (UC-02)

import { answerQuestion } from '../agents/ask.js';
import { TEAM_DOCS_DIR } from '../core/rag/chunker.js';
import { createEmbedder, embedIdentity, embedModelFromConfig } from '../core/rag/embedder.js';
import { loadCatalog } from '../llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../llm/model-resolver.js';
import type { Command, CommandResult } from './types.js';

export const askCommand: Command = {
  name: 'ask',
  summary: 'Answer a question about the repo with citations',
  usage: '/ask <question>',
  async run(args, ctx): Promise<CommandResult> {
    const question = args.trim() || (await ctx.ui.ask('Question: ')).trim();
    if (!question) throw new Error('Question cannot be empty. Usage: /ask <question>');
    // Before the chat model, so a missing @embed role fails without resolving or logging in anything else.
    const embedInfo = embedModelFromConfig(ctx.config);
    const info = resolveModel('@default', loadCatalog(), ctx.config);
    const answer = await answerQuestion(question, {
      workspaceRoot: ctx.workspaceRoot,
      provider: await createProviderFor(info),
      model: info.id,
      embedder: createEmbedder(embedInfo, { costTracker: ctx.costTracker }),
      embedModel: embedIdentity(embedInfo),
      teamDir: TEAM_DOCS_DIR,
      signal: ctx.signal,
      bus: ctx.bus,
      costTracker: ctx.costTracker,
    });
    // Plain `path:Lx-Ly` here; the TUI renderer for `ask-answer` turns them into links.
    return { kind: 'ask-answer', data: answer, text: answer.text };
  },
};
