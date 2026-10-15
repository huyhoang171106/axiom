// src/commands/router.ts - Parse `/name args` and look commands up; shared by TUI and headless

import type { Command } from './types.js';

export function parseCommand(input: string): { name: string; args: string } | null {
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(input);
  return match ? { name: match[1].toLowerCase(), args: match[2].trim() } : null;
}

export class CommandRouter {
  private readonly commands = new Map<string, Command>();

  register(c: Command): void {
    // Two lanes picking the same name would otherwise make one command silently unreachable.
    if (this.commands.has(c.name)) throw new Error(`Command /${c.name} is already registered`);
    this.commands.set(c.name, c);
  }

  get(name: string): Command | undefined {
    return this.commands.get(name.toLowerCase());
  }

  list(): Command[] {
    return [...this.commands.values()];
  }

  /** Commands whose name starts with `prefix`; a leading '/' is ignored. */
  complete(prefix: string): Command[] {
    const wanted = prefix.replace(/^\//, '').toLowerCase();
    return this.list().filter((c) => c.name.startsWith(wanted));
  }
}

/** Error text for an unknown name, suggesting the commands that share its longest prefix. */
export function unknownCommandMessage(router: CommandRouter, name: string): string {
  for (let n = name.length; n > 0; n--) {
    const near = router.complete(name.slice(0, n));
    if (near.length > 0) return `Unknown command /${name}. Did you mean ${near.map((c) => `/${c.name}`).join(', ')}?`;
  }
  return `Unknown command /${name}. Type /help to list commands.`;
}

/** The router TUI and headless share; `index.ts` registers every command on it. */
export const defaultCommandRouter = new CommandRouter();
