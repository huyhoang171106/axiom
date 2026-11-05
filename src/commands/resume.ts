// src/commands/resume.ts - `resume` command (UC-04)

import { resumeTask } from '../agents/feature.js';
import { listTasks } from '../core/task-state.js';
import { loadCatalog } from '../llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../llm/model-resolver.js';
import type { Command, CommandResult } from './types.js';

export const resumeCommand: Command = {
  name: 'resume',
  summary: 'Continue an unfinished /feature task',
  usage: '/resume [threadId]',
  async run(args, ctx): Promise<CommandResult> {
    let targetThreadId = args.trim();

    if (!targetThreadId) {
      const candidates = listTasks(ctx.workspaceRoot).filter((t) =>
        t.steps.some((st) => st.status === 'todo' || st.status === 'doing')
      );

      if (candidates.length === 0) {
        return {
          kind: 'message',
          data: null,
          text: 'No unfinished tasks found in this workspace.',
        };
      }

      if (candidates.length === 1) {
        targetThreadId = candidates[0].threadId;
      } else {
        // In bảng danh sách các task dở dang, mới nhất trước
        const lines: string[] = ['Unfinished tasks:'];
        candidates.forEach((task, idx) => {
          const doneSteps = task.steps.filter((s) => s.status === 'done').length;
          const totalSteps = task.steps.length;
          const goalOneLine = task.goal.replace(/\s+/g, ' ').slice(0, 50);
          lines.push(`  ${idx + 1}. [${task.threadId}] (${doneSteps}/${totalSteps}) ${goalOneLine} (${task.updatedAt})`);
        });
        ctx.ui.print(lines.join('\n'));

        const choiceStr = await ctx.ui.ask(`Select task to resume (1-${candidates.length}): `);
        const choiceNum = parseInt(choiceStr.trim(), 10);
        if (isNaN(choiceNum) || choiceNum < 1 || choiceNum > candidates.length) {
          throw new Error(`Invalid selection: "${choiceStr}". Must be between 1 and ${candidates.length}.`);
        }
        targetThreadId = candidates[choiceNum - 1].threadId;
      }
    }

    const info = resolveModel('@code', loadCatalog(), ctx.config);
    const provider = await createProviderFor(info);

    const report = await resumeTask(targetThreadId, {
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
