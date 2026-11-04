// src/commands/cost.ts - `cost` command (session)

import type { Command } from './types.js';

export const costCommand: Command = {
  name: 'cost',
  summary: 'Show tokens and cost of this session',
  usage: '/cost',
  async run(_args, ctx) {
    const summary = ctx.costTracker.getSessionSummary();
    const rows = Object.entries(summary.byModel).map(([model, usage]) =>
      `${model}: input ${usage.promptTokens}, output ${usage.completionTokens}, $${usage.cost.toFixed(6)}`);
    rows.push(`Session: input ${summary.totalPromptTokens}, output ${summary.totalCompletionTokens}, total ${summary.totalTokens}, $${summary.totalCost.toFixed(6)}`);
    return { kind: 'cost', data: summary, text: rows.join('\n') };
  },
};
