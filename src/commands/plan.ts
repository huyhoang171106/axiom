// src/commands/plan.ts - `plan` command (UC-05)

import type { Command } from './types.js';
import { permissionSession } from './permission-session.js';

export const planCommand: Command = {
  name: 'plan',
  summary: 'Plan mode: read-only tools until you leave it',
  usage: '/plan [off]',
  async run(args, ctx) {
    const action = args.trim();
    if (action && action !== 'off') throw new Error('Usage: /plan [off]');
    const session = permissionSession(ctx);
    session.setPlan(action !== 'off');
    return session.result();
  },
};
