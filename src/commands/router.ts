// src/commands/router.ts - Parse `/name args` and look commands up; stubs until D2

import type { Command } from './types.js';

// TODO(D2): `/name  args` -> { name, args }, null when the input does not start with '/'.
export function parseCommand(input: string): { name: string; args: string } | null {
  return null;
}

// TODO(D2): fill register/get/list/complete.
export class CommandRouter {
  register(c: Command): void {}
  get(name: string): Command | undefined {
    return undefined;
  }
  list(): Command[] {
    return [];
  }
  complete(prefix: string): Command[] {
    return [];
  }
}

/** The router TUI and headless share; `index.ts` registers every command on it. */
export const defaultCommandRouter = new CommandRouter();
