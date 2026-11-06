// src/commands/audit.ts - `audit` command (UC-05)

import type { Command } from './types.js';
import { readAudit } from '../core/audit.js';

export const auditCommand: Command = {
  name: 'audit',
  summary: 'Show recent policy and approval decisions',
  usage: '/audit [n]',
  async run(args) {
    const value = args.trim();
    if (value && !/^[1-9]\d*$/.test(value)) throw new Error('Audit limit must be a positive integer');
    const entries = readAudit(value ? Number(value) : undefined).reverse();
    const rows = entries.map((entry) => [entry.at, entry.tool,
      JSON.stringify(entry.args).replace(/[\r\n]+/g, ' '), entry.risk, entry.decision, entry.approver].join(' | '));
    return { kind: 'audit', data: entries,
      text: ['at | tool | args | risk | decision | approver', ...rows].join('\n') };
  },
};
