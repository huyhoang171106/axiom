// src/commands/help.ts - `help` command: every registered command with its usage

import { defaultCommandRouter } from './router.js';
import type { Command } from './types.js';

export const helpCommand: Command = {
  name: 'help',
  summary: 'Show commands and how to use them',
  usage: '/help',
  async run() {
    const commands = defaultCommandRouter.list().map(({ name, summary, usage }) => ({ name, summary, usage }));
    const width = Math.max(...commands.map((c) => c.usage.length));
    return { kind: 'help', data: commands, text: commands.map((c) => `${c.usage.padEnd(width)}  ${c.summary}`).join('\n') };
  },
};
