// src/commands/ask.ts - `ask` command (UC-02)

import type { Command } from './types.js';

export const askCommand: Command = {
  name: 'ask',
  summary: 'Answer a question about the repo with citations',
  usage: '/ask <question>',
  async run() {
    throw new Error('chưa làm (B4)');
  },
};
