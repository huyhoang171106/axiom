// src/tui/index.tsx - Interactive entry; until E4 it is the old line-based REPL

import readline from 'node:readline/promises';
import pc from 'picocolors';
import { createAgent } from '../cli/agent.js';

// TODO(E4): replace with the Ink app.
export async function startTui(argv: string[]): Promise<void> {
  const task = argv.filter((a) => !a.startsWith('-')).join(' ').trim();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const agent = await createAgent({ workspaceRoot: process.cwd(), mock: argv.includes('--mock') });
  agent.eventBus.on('stream_token', ({ delta }) => process.stdout.write(delta));
  agent.eventBus.on('tool_call_start', (tc) => process.stderr.write(pc.dim(`\n> ${tc.name} ${JSON.stringify(tc.arguments).slice(0, 120)}\n`)));
  if (argv.includes('--yes')) agent.toolRegistry.allowWithoutApprover = true;
  else agent.toolRegistry.approver = async ({ name, reason }) =>
    /^y/i.test(await rl.question(pc.yellow(`\nAllow ${name}? (${reason}) [y/N] `))) ? 'approve' : 'deny';

  const run = async (prompt: string) => {
    const r = await agent.runTask(prompt);
    process.stdout.write(`\n${pc.dim(`[${r.status}] $${r.totalCostDollars.toFixed(4)} · ${r.filesChanged.length} file(s) changed`)}${r.error ? pc.red(` ${r.error}`) : ''}\n`);
  };

  if (task) await run(task);
  else {
    for (;;) {
      const line = (await rl.question(pc.cyan('axiom> '))).trim();
      if (!line || line === 'exit' || line === '/exit') break;
      await run(line);
    }
  }
  rl.close();
}
