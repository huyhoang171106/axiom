// src/commands/fix.ts - `fix` command (UC-03)

import type { Command } from './types.js';

export const fixCommand: Command = {
  name: 'fix',
  summary: 'Reproduce, locate and fix a bug in up to 5 rounds',
  usage: '/fix <issue dir | issue text>',
  async run() {
    throw new Error('chưa làm (C5)');
  },
};
