// src/commands/triage.ts - `triage` command; stub until A5

import type { Command } from './types.js';

export const triageCommand: Command = {
  name: 'triage',
  summary: 'Turn an issue into an IssueTicket',
  usage: '/triage <issue text>',
  // TODO(A5): implement.
  async run() {
    throw new Error('/triage is not implemented yet (A5)');
  },
};
