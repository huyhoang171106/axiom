// src/commands/clear.ts - `clear` command; TUI and headless act on kind 'clear'

import type { Command } from './types.js';

export const clearCommand: Command = {
  name: 'clear',
  summary: 'Clear the conversation',
  usage: '/clear',
  async run() {
    return { kind: 'clear', data: null, text: '' };
  },
};
