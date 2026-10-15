// src/commands/model.ts - `model` command; stub until B3

import type { Command } from './types.js';

export const modelCommand: Command = {
  name: 'model',
  summary: 'Pick the model for this session',
  usage: '/model [selector]',
  // TODO(B3): implement.
  async run() {
    throw new Error('/model is not implemented yet (B3)');
  },
};
