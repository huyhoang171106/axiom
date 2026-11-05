// src/commands/feature.ts - `feature` command (UC-04)

import { runFeature } from '../agents/feature.js';
import { loadCatalog } from '../llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../llm/model-resolver.js';
import type { Command, CommandResult } from './types.js';

export const featureCommand: Command = {
  name: 'feature',
  summary: 'Plan a feature, approve the plan, build it step by step',
  usage: '/feature <request>',
  async run(args, ctx): Promise<CommandResult> {
    const request = args.trim() || (await ctx.ui.ask('Feature request: ')).trim();
    if (!request) throw new Error('Feature request cannot be empty. Usage: /feature <request>');
    const info = resolveModel('@code', loadCatalog(), ctx.config);
    const provider = await createProviderFor(info);
    const report = await runFeature(request, {
      workspaceRoot: ctx.workspaceRoot,
      provider,
      model: info.id,
      bus: ctx.bus,
      tools: ctx.tools,
      costTracker: ctx.costTracker,
      ui: ctx.ui,
      signal: ctx.signal,
    });
    return {
      kind: 'feature-report',
      data: report,
      text: report.summary,
    };
  },
};
