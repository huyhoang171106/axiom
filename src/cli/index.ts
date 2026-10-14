// src/cli/index.ts - Minimal CLI: `axiom "<task>"` runs one task, `axiom` alone opens a line-based REPL

import readline from 'node:readline/promises';
import pc from 'picocolors';
import { AgentLoop } from '../core/agent-loop.js';
import { loadConfig } from '../core/config.js';
import { MockProvider } from '../llm/providers/mock.js';
import type { Approver } from '../tools/permissions.js';

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const yes = argv.includes('--yes');
  const mock = argv.includes('--mock');
  const task = argv.filter((a) => !a.startsWith('--')).join(' ').trim();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const agent = new AgentLoop({
    config: loadConfig(),
    provider: mock ? new MockProvider('mock', ['mock reply']) : undefined,
  });
  agent.eventBus.on('stream_token', ({ delta }) => process.stdout.write(delta));
  agent.eventBus.on('tool_call_start', (tc) => console.error(pc.dim(`\n> ${tc.name} ${JSON.stringify(tc.arguments).slice(0, 120)}`)));

  // Risky calls (writes outside the workspace, destructive shell, ...) need a yes unless --yes was given.
  const approver: Approver = async ({ name, reason }) => /^y/i.test(await rl.question(pc.yellow(`\nAllow ${name}? (${reason}) [y/N] `)));
  agent.toolRegistry.approver = yes ? undefined : approver;
  agent.toolRegistry.allowWithoutApprover = yes;

  const run = async (prompt: string) => {
    const r = await agent.runTask(prompt);
    console.log(`\n${pc.dim(`[${r.status}] $${r.totalCostDollars.toFixed(4)} · ${r.filesChanged.length} file(s) changed`)}${r.error ? pc.red(` ${r.error}`) : ''}`);
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
