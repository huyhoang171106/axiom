// src/commands/models.ts - `models` command; stub until B3

import type { Command } from './types.js';

export const modelsCommand: Command = {
  name: 'models',
  summary: 'List available models',
  usage: '/models [provider]',
  // TODO(B3): implement.
  async run() {
    throw new Error('/models is not implemented yet (B3)');
  },
};
