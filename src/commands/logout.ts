// src/commands/logout.ts - `logout` command: delete a stored credential (env vars are left alone)

import { readAuth, removeCredential } from '../llm/auth/store.js';
import type { Command } from './types.js';

export const logoutCommand: Command = {
  name: 'logout',
  summary: 'Remove a stored credential',
  usage: '/logout [provider]',
  async run(args) {
    const id = args.trim();
    if (!id) {
      const stored = Object.keys(readAuth());
      const text = stored.length > 0 ? `Logged in: ${stored.join(', ')}. Usage: /logout <provider>` : 'No stored credentials.';
      return { kind: 'logout', data: { stored }, text };
    }
    const removed = removeCredential(id);
    return { kind: 'logout', data: { provider: id, removed }, text: removed ? `Removed the stored credential for ${id}.` : `Nothing stored for ${id}.` };
  },
};
