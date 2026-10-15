// src/commands/login.ts - `login` command; stub until B3

import type { Command } from './types.js';

export const loginCommand: Command = {
  name: 'login',
  summary: 'Connect a provider',
  usage: '/login [provider]',
  // TODO(B3): implement.
  async run() {
    throw new Error('/login is not implemented yet (B3)');
  },
};
