// src/commands/triage.ts - `triage` command: free-form issue in, formatted IssueTicket out (UC-01)

import { runTriage, type IssueTicket } from '../agents/triage.js';
import { loadCatalog } from '../llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../llm/model-resolver.js';
import type { Command, CommandResult } from './types.js';

/** The IssueTicket as plain text; headless prints this, a TUI renderer for `kind` may draw it later (tui.md). */
export function formatIssueTicket(ticket: IssueTicket, warnings: string[]): string {
  const lines: string[] = [`[${ticket.type}] ${ticket.priority}`, `Route: ${ticket.route}`];
  const section = (title: string, items: string[], numbered = false) => {
    if (items.length === 0) return;
    lines.push('', `${title}:`);
    items.forEach((item, i) => lines.push(numbered ? `${i + 1}. ${item}` : `- ${item}`));
  };
  section('Affected files', ticket.affected_files);
  section('Reproduction steps', ticket.reproduction_steps, true);
  section('Acceptance criteria', ticket.acceptance_criteria);
  section('Missing info', ticket.missing_info);
  for (const warning of warnings) lines.push('', `Warning: ${warning}`);
  return lines.join('\n');
}

export const triageCommand: Command = {
  name: 'triage',
  summary: 'Turn an issue into an IssueTicket',
  usage: '/triage <issue text>',
  async run(args, ctx): Promise<CommandResult> {
    const issue = args.trim() || (await ctx.ui.ask('Issue: ')).trim();
    if (!issue) throw new Error('Issue cannot be empty. Provide issue text to /triage.');
    const info = resolveModel('@smol', loadCatalog(), ctx.config);
    const provider = await createProviderFor(info);
    const { ticket, warnings } = await runTriage({
      issue,
      workspaceRoot: ctx.workspaceRoot,
      provider,
      model: info.id,
      signal: ctx.signal,
      bus: ctx.bus,
      costTracker: ctx.costTracker,
    });
    return {
      kind: 'issue-ticket',
      data: { ticket, warnings },
      text: formatIssueTicket(ticket, warnings),
    };
  },
};
