// src/commands/help.ts - `help` command; stub until D2

import type { Command } from './types.js';

export const helpCommand: Command = {
  name: 'help',
  summary: 'Show commands and how to use them',
  usage: '/help',
  // TODO(D2): implement.
  async run() {
    throw new Error('/help is not implemented yet (D2)');
  },
};
