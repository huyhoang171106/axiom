// src/commands/mode.ts - `mode` command (UC-05)

import type { Command } from './types.js';
import { permissionSession } from './permission-session.js';

export const modeCommand: Command = {
  name: 'mode',
  summary: 'Set the permission mode',
  usage: '/mode read-only|edit',
  async run(args, ctx) {
    const mode = args.trim();
    if (mode && mode !== 'read-only' && mode !== 'edit') throw new Error('Usage: /mode read-only|edit');
    const session = permissionSession(ctx);
    if (mode === 'read-only' || mode === 'edit') session.setMode(mode);
    return session.result();
  },
};
