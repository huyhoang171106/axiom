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
import { createExecutionContext, type ExecutionContext } from '../core/execution-context.js';
import { loadCatalog, type ModelInfo } from '../llm/catalog/index.js';
import { resolveModel } from '../llm/model-resolver.js';

export function parseCliArgs(argv: string[]): {
  model?: string;
  isPrompt: boolean;
  mock: boolean;
  yes: boolean;
  json: boolean;
  words: string[];
} {
  let model: string | undefined;
  let isPrompt = false;
  let mock = false;
  let yes = false;
  let json = false;
  const words: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-p' || arg === '--prompt') {
      isPrompt = true;
    } else if (arg === '--mock') {
      mock = true;
    } else if (arg === '--yes') {
      yes = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '-m' || arg === '--model') {
      if (i + 1 < argv.length) {
        model = argv[++i];
      }
    } else if (arg.startsWith('--model=')) {
      model = arg.slice('--model='.length);
    } else if (arg.startsWith('-m=')) {
      model = arg.slice('-m='.length);
    } else {
      words.push(arg);
    }
  }
  return { model, isPrompt, mock, yes, json, words };
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { model, isPrompt, mock, yes, json, words } = parseCliArgs(argv);
  const fromArgs = words.join(' ').trim();
  const named = words[0] && defaultCommandRouter.get(words[0]) ? { name: words[0], args: words.slice(1).join(' ') } : null;
  if (!named && !fromArgs.startsWith('/') && process.stdout.isTTY && !isPrompt) return startTui(argv);

  // Piped input is the task, so `echo "..." | axiom -p` works like `axiom -p "..."`.
  const input = fromArgs || (process.stdin.isTTY ? '' : (await text(process.stdin)).trim());
  const command = named ?? parseCommand(input);
  if (command) return runCommand(command.name, command.args, argv, model);
  if (!input) throw new Error('No task. Usage: axiom -p "<task>" or axiom <command>; axiom help lists commands');

  const ui = createHeadlessUI({ yes });
  const exec = createHeadlessExecution(ui, yes);
  const agent = await createAgent({ workspaceRoot: process.cwd(), mock, model, exec });
  let isThinking = false;
  agent.eventBus.on('thinking', ({ delta }) => {
    if (!isThinking) {
      isThinking = true;
      process.stderr.write(pc.dim('~ think: '));
    }
    process.stderr.write(pc.dim(delta));
  });
  agent.eventBus.on('stream_token', ({ delta }) => {
    if (isThinking) {
      isThinking = false;
      process.stderr.write('\n');
    }
    process.stdout.write(delta);
  });
  agent.eventBus.on('tool_call_start', (tc) => {
    if (isThinking) {
      isThinking = false;
      process.stderr.write('\n');
    }
    console.error(pc.dim(`\n> ${tc.name} ${JSON.stringify(tc.arguments).slice(0, 120)}`));
  });


  const r = await agent.runTask(input);
  if (isThinking) {
    isThinking = false;
    process.stderr.write('\n');
  }
  console.log(`\n${pc.dim(`[${r.status}] $${r.totalCostDollars.toFixed(4)} · ${r.filesChanged.length} file(s) changed`)}${r.error ? pc.red(` ${r.error}`) : ''}`);
}

/** Same `router.get(name).run(...)` call the TUI makes for `/name`. */
async function runCommand(name: string, args: string, argv: string[], modelSelector?: string): Promise<void> {
  const command = defaultCommandRouter.get(name);
  if (!command) throw new Error(unknownCommandMessage(defaultCommandRouter, name));
  const config = loadConfig();
  let model: ModelInfo | undefined;
  const yes = argv.includes('--yes');
  const ui = createHeadlessUI({ yes });
  const ctx: CommandContext = {
    ...createHeadlessExecution(ui, yes),
    config,
    workspaceRoot: process.cwd(),
    ui,
    signal: new AbortController().signal,
    session: {
      // Resolved on first use, so commands that need no model (login, help) work before any provider is set up.
      get model() {
        return (model ??= argv.includes('--mock') ? MOCK_MODEL : resolveModel(modelSelector ?? '@default', loadCatalog(), config));
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

/**
 * Risky calls need a yes. `--yes` runs them unattended (a policy deny still blocks); otherwise a terminal asks,
 * and with no terminal the registry refuses them. Chat and commands share this one session.
 */
function createHeadlessExecution(ui: CommandUI, yes: boolean): ExecutionContext {
  const exec = createExecutionContext();
  if (yes) exec.tools.allowWithoutApprover = true;
  else if (process.stdin.isTTY) exec.tools.approver = async ({ name, reason }) => ((await ui.confirm(`Allow ${name}? (${reason})`)) ? 'approve' : 'deny');
  return exec;
}

/**
 * Questions go to stderr so stdout stays clean for piping; without a terminal nothing can be asked.
 * `yes` answers every confirm (workflow gates such as "Run the suggested route?") with yes.
 */
export function createHeadlessUI(opts: { yes?: boolean } = {}): CommandUI {
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
    confirm: async (question) => opts.yes === true || (process.stdin.isTTY === true && /^y/i.test(await ask(pc.yellow(`${question} [y/N]`)))),
  };
}
