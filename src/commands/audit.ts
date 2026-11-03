// src/commands/audit.ts - `audit` command (UC-05)

import type { Command } from './types.js';

export const auditCommand: Command = {
  name: 'audit',
  summary: 'Show recent approve and deny decisions',
  usage: '/audit [n]',
  async run() {
    throw new Error('chưa làm (E4)');
  },
};
