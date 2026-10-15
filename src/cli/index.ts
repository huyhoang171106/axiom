// src/cli/index.ts - Entry: `axiom <command>`, `/command` and -p run headless; a bare TTY opens the TUI

import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { text } from 'node:stream/consumers';
import pc from 'picocolors';
import { createAgent, MOCK_MODEL } from './agent.js';
import { startTui } from '../tui/index.js';
import { defaultCommandRouter } from '../commands/index.js';
import { parseCommand, unknownCommandMessage } from '../commands/router.js';
import type { CommandContext, CommandUI } from '../commands/types.js';
import { loadConfig } from '../core/config.js';
import { loadCatalog, type ModelInfo } from '../llm/catalog/index.js';
import { resolveModel } from '../llm/model-resolver.js';

const GLOBAL_FLAGS = ['-p', '--mock', '--yes', '--json'];

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const words = argv.filter((a) => !GLOBAL_FLAGS.includes(a));
  const fromArgs = words.join(' ').trim();
  const named = words[0] && defaultCommandRouter.get(words[0]) ? { name: words[0], args: words.slice(1).join(' ') } : null;
  if (!named && !fromArgs.startsWith('/') && process.stdout.isTTY && !argv.includes('-p')) return startTui(argv);

  // Piped input is the task, so `echo "..." | axiom -p` works like `axiom -p "..."`.
  const input = fromArgs || (process.stdin.isTTY ? '' : (await text(process.stdin)).trim());
  const command = named ?? parseCommand(input);
  if (command) return runCommand(command.name, command.args, argv);
  if (!input) throw new Error('No task. Usage: axiom -p "<task>" or axiom <command>; axiom help lists commands');

  const agent = await createAgent({ workspaceRoot: process.cwd(), mock: argv.includes('--mock') });
  agent.eventBus.on('stream_token', ({ delta }) => process.stdout.write(delta));
  agent.eventBus.on('tool_call_start', (tc) => console.error(pc.dim(`\n> ${tc.name} ${JSON.stringify(tc.arguments).slice(0, 120)}`)));

  // Risky calls need a yes. With no terminal to ask on, the registry refuses them unless --yes was given.
  const ui = createHeadlessUI();
  if (argv.includes('--yes')) agent.toolRegistry.allowWithoutApprover = true;
  else if (process.stdin.isTTY) agent.toolRegistry.approver = async ({ name, reason }) => ((await ui.confirm(`Allow ${name}? (${reason})`)) ? 'approve' : 'deny');

  const r = await agent.runTask(input);
  console.log(`\n${pc.dim(`[${r.status}] $${r.totalCostDollars.toFixed(4)} · ${r.filesChanged.length} file(s) changed`)}${r.error ? pc.red(` ${r.error}`) : ''}`);
}

/** Same `router.get(name).run(...)` call the TUI makes for `/name`. */
async function runCommand(name: string, args: string, argv: string[]): Promise<void> {
  const command = defaultCommandRouter.get(name);
  if (!command) throw new Error(unknownCommandMessage(defaultCommandRouter, name));
  const config = loadConfig();
  let model: ModelInfo | undefined;
  const ctx: CommandContext = {
    config,
    workspaceRoot: process.cwd(),
    ui: createHeadlessUI(),
    signal: new AbortController().signal,
    session: {
      // Resolved on first use, so commands that need no model (login, help) work before any provider is set up.
      get model() {
        return (model ??= argv.includes('--mock') ? MOCK_MODEL : resolveModel('@default', loadCatalog(), config));
      },
      setModel(info) {
        model = info;
      },
    },
  };
  const result = await command.run(args, ctx);
  // Nothing to clear or leave in a one-shot run.
  if (!result || result.kind === 'clear' || result.kind === 'exit') return;
  console.log(argv.includes('--json') ? JSON.stringify(result.data, null, 2) : result.text);
}

/** Questions go to stderr so stdout stays clean for piping; without a terminal nothing can be asked. */
export function createHeadlessUI(): CommandUI {
  const ask = async (question: string, opts?: { secret?: boolean }): Promise<string> => {
    if (!process.stdin.isTTY) throw new Error(`Cannot ask "${question}": no terminal. Run it in a terminal or pass the value another way.`);
    const secret = !!opts?.secret;
    if (secret) process.stderr.write(`${question} `);
    // readline echoes typed keys through `output`; dropping that output hides a secret as it is typed.
    const output = new Writable({ write: (chunk, encoding, done) => (secret ? done() : process.stderr.write(chunk, encoding, done)) });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
    try {
      return (await rl.question(secret ? '' : `${question} `)).trim();
    } finally {
      rl.close();
      if (secret) process.stderr.write('\n');
    }
  };
  return {
    print: (line) => console.log(line),
    ask,
    confirm: async (question) => process.stdin.isTTY === true && /^y/i.test(await ask(pc.yellow(`${question} [y/N]`))),
  };
}
