// src/commands/memory.ts - `memory` command (UC-04)

import type { Command } from './types.js';

export const memoryCommand: Command = {
  name: 'memory',
  summary: 'Show, add to or clear long-term memory for this repo',
  usage: '/memory [add <note> | clear]',
  async run() {
    throw new Error('chưa làm (D4)');
  },
};
