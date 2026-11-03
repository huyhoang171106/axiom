// src/commands/plan.ts - `plan` command (UC-05)

import type { Command } from './types.js';

export const planCommand: Command = {
  name: 'plan',
  summary: 'Plan mode: read-only tools until you leave it',
  usage: '/plan',
  async run() {
    throw new Error('chưa làm (E5)');
  },
};
