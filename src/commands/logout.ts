// src/commands/logout.ts - `logout` command; stub until B3

import type { Command } from './types.js';

export const logoutCommand: Command = {
  name: 'logout',
  summary: 'Remove a stored credential',
  usage: '/logout [provider]',
  // TODO(B3): implement.
  async run() {
    throw new Error('/logout is not implemented yet (B3)');
  },
};
