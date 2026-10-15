// src/cli/index.ts - Entry: a TTY without -p opens the TUI; anything else runs one task headless

import readline from 'node:readline/promises';
import { text } from 'node:stream/consumers';
import pc from 'picocolors';
import { createAgent } from './agent.js';
import { startTui } from '../tui/index.js';

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  if (process.stdout.isTTY && !argv.includes('-p')) return startTui(argv);

  // Piped input is the task, so `echo "..." | axiom -p` works like `axiom -p "..."`.
  const task = argv.filter((a) => !a.startsWith('-')).join(' ').trim() || (process.stdin.isTTY ? '' : (await text(process.stdin)).trim());
  if (!task) throw new Error('No task. Usage: axiom -p "<task>"');

  const agent = await createAgent({ workspaceRoot: process.cwd(), mock: argv.includes('--mock') });
  agent.eventBus.on('stream_token', ({ delta }) => process.stdout.write(delta));
  agent.eventBus.on('tool_call_start', (tc) => console.error(pc.dim(`\n> ${tc.name} ${JSON.stringify(tc.arguments).slice(0, 120)}`)));

  // Risky calls need a yes. With no terminal to ask on, the registry refuses them unless --yes was given.
  const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  if (argv.includes('--yes')) agent.toolRegistry.allowWithoutApprover = true;
  else if (rl) agent.toolRegistry.approver = async ({ name, reason }) =>
    /^y/i.test(await rl.question(pc.yellow(`\nAllow ${name}? (${reason}) [y/N] `))) ? 'approve' : 'deny';

  const r = await agent.runTask(task);
  rl?.close();
  console.log(`\n${pc.dim(`[${r.status}] $${r.totalCostDollars.toFixed(4)} · ${r.filesChanged.length} file(s) changed`)}${r.error ? pc.red(` ${r.error}`) : ''}`);
}
