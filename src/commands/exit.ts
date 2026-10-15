// src/commands/exit.ts - `exit` command; TUI and headless act on kind 'exit'

import type { Command } from './types.js';

export const exitCommand: Command = {
  name: 'exit',
  summary: 'Quit Axiom',
  usage: '/exit',
  async run() {
    return { kind: 'exit', data: null, text: '' };
  },
};
