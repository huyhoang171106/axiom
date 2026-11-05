// src/commands/memory.ts - `memory` command (UC-04)

import { addMemory, clearMemory, loadMemory, memoryPath } from '../core/memory.js';
import type { Command, CommandResult } from './types.js';

export const memoryCommand: Command = {
  name: 'memory',
  summary: 'Show, add to or clear long-term memory for this repo',
  usage: '/memory [add <note> | clear]',
  async run(args, ctx): Promise<CommandResult> {
    const trimmed = args.trim();
    const words = trimmed.split(/\s+/).filter(Boolean);
    const sub = words[0];

    if (sub === 'clear') {
      const confirmed = await ctx.ui.confirm('Clear all project memory for this repository?');
      if (confirmed) {
        clearMemory(ctx.workspaceRoot);
        return { kind: 'memory', data: { cleared: true }, text: 'Project memory cleared.' };
      }
      return { kind: 'memory', data: { cleared: false }, text: 'Memory clear cancelled.' };
    }

    if (sub === 'add') {
      const note = trimmed.slice(sub.length).trim();
      if (!note) {
        throw new Error('Usage: /memory add <note>');
      }
      addMemory(ctx.workspaceRoot, note);
      return { kind: 'memory', data: { added: note }, text: `Added to project memory: ${note}` };
    }

    const currentMemory = loadMemory(ctx.workspaceRoot);
    const pathOnDisk = memoryPath(ctx.workspaceRoot);
    if (!currentMemory) {
      return {
        kind: 'memory',
        data: { memory: '', path: pathOnDisk },
        text: `Project memory is empty (${pathOnDisk}).\nUse /memory add <note> to save conventions.`,
      };
    }

    return {
      kind: 'memory',
      data: { memory: currentMemory, path: pathOnDisk },
      text: `# Project memory (${pathOnDisk})\n\n${currentMemory}`,
    };
  },
};
