// src/commands/fix.ts - `fix` command (UC-03)

import fs from 'node:fs';
import path from 'node:path';
import { fixIssue, type FixReport } from '../agents/fix.js';
import { loadCatalog } from '../llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../llm/model-resolver.js';
import type { Command, CommandResult } from './types.js';

/** A directory with issue.md (evals/issues/bug-NN), an .md file, or the issue text itself. */
export function readIssueArg(arg: string, cwd: string): string {
  const trimmed = arg.trim();
  if (!trimmed) return '';
  const candidate = path.resolve(cwd, trimmed);
  try {
    const stat = fs.statSync(candidate);
    if (stat.isDirectory()) {
      const issue = path.join(candidate, 'issue.md');
      if (!fs.existsSync(issue)) throw new Error(`${trimmed} has no issue.md. Usage: /fix <issue dir | issue text>`);
      return fs.readFileSync(issue, 'utf8');
    }
    if (stat.isFile() && /\.(md|txt)$/i.test(candidate)) return fs.readFileSync(candidate, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // Not a path: the argument is the issue text.
  }
  return trimmed;
}

/** Plain-text report: headless prints it; the TUI draws `fix-report` with FixReportView (src/tui/components/fix-report.tsx). */
export function formatFixReport(report: FixReport): string {
  const lines = [`[${report.status}] ${report.summary}`];
  if (report.rounds.length) {
    lines.push('', 'Rounds:');
    for (const r of report.rounds) {
      lines.push(`- ${r.round}: ${r.hypothesis} (${r.patchApplied ? `passed ${r.testsPassed}, failed ${r.testsFailed}, regressions ${r.regressions.length}` : 'no patch'})`);
    }
  }
  lines.push('', `Diff: ${report.diffStat.files} files, +${report.diffStat.added} -${report.diffStat.removed}`);
  if (report.explanation) lines.push('', `Why this many changes: ${report.explanation}`);
  return lines.join('\n');
}

export const fixCommand: Command = {
  name: 'fix',
  summary: 'Reproduce, locate and fix a bug in up to 5 rounds',
  usage: '/fix <issue dir | issue text>',
  async run(args, ctx): Promise<CommandResult> {
    const issue = readIssueArg(args, ctx.workspaceRoot) || (await ctx.ui.ask('Issue: ')).trim();
    if (!issue) throw new Error('Issue cannot be empty. Usage: /fix <issue dir | issue text>');
    const info = resolveModel('@code', loadCatalog(), ctx.config);
    const provider = await createProviderFor(info);
    const report = await fixIssue({
      issue,
      workspaceRoot: ctx.workspaceRoot,
      provider,
      model: info.id,
      bus: ctx.bus,
      tools: ctx.tools,
      costTracker: ctx.costTracker,
      ui: ctx.ui,
      signal: ctx.signal,
    });
    return { kind: 'fix-report', data: report, text: formatFixReport(report) };
  },
};
