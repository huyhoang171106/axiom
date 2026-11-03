// src/commands/mode.ts - `mode` command (UC-05)

import type { Command } from './types.js';

export const modeCommand: Command = {
  name: 'mode',
  summary: 'Set the permission mode',
  usage: '/mode read-only|edit',
  async run() {
    throw new Error('chưa làm (E5)');
  },
};
