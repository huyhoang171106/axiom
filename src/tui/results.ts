// src/tui/results.ts - Validate structured results before formatting transcript output.
import { z } from 'zod';
const report = z.object({ status: z.string(), summary: z.string(), filesChanged: z.array(z.string()) });
const feature = report.extend({ threadId: z.string(), steps: z.array(z.object({ id: z.number(), title: z.string(), status: z.string() })) });
const fix = report.extend({ rounds: z.array(z.object({ round: z.number(), hypothesis: z.string(), testsPassed: z.number(), testsFailed: z.number() })), diffStat: z.object({ files: z.number(), added: z.number(), removed: z.number() }), explanation: z.string().optional() });
const usage = z.object({ promptTokens: z.number(), completionTokens: z.number(), cost: z.number() });
const cost = z.object({ byModel: z.record(z.string(), usage), totalPromptTokens: z.number(), totalCompletionTokens: z.number(), totalCost: z.number() });
const audit = z.array(z.object({ at: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()), risk: z.string(), decision: z.string(), approver: z.string() }));
export function resultText(kind: string | undefined, data: unknown): string | undefined {
  if (kind === 'feature-report') {
    const parsed = feature.safeParse(data); if (!parsed.success) return;
    const r = parsed.data;
    return [`[${r.status}] ${r.summary}`, `Thread: ${r.threadId}`, ...r.steps.map(s => `${s.id}. [${s.status}] ${s.title}`), ...r.filesChanged].join('\n');
  }
  if (kind === 'fix-report') {
    const parsed = fix.safeParse(data); if (!parsed.success) return;
    const r = parsed.data;
    return [`[${r.status}] ${r.summary}`, ...r.rounds.map(s => `Round ${s.round}: passed ${s.testsPassed}, failed ${s.testsFailed}\n${s.hypothesis}`), `Diff: ${r.diffStat.files} files, +${r.diffStat.added} -${r.diffStat.removed}`, r.explanation ?? '', ...r.filesChanged].join('\n');
  }
  if (kind === 'cost') {
    const parsed = cost.safeParse(data); if (!parsed.success) return;
    const r = parsed.data;
    return [...Object.entries(r.byModel).map(([name,s]) => `${name}\nInput ${s.promptTokens}, output ${s.completionTokens}, $${s.cost.toFixed(6)}`), `Session: input ${r.totalPromptTokens}, output ${r.totalCompletionTokens}\nTotal $${r.totalCost.toFixed(6)}`].join('\n');
  }
  if (kind === 'audit') {
    const parsed = audit.safeParse(data); if (!parsed.success) return;
    return parsed.data.map(e => `${e.at} ${e.tool}\n${e.risk} | ${e.decision} | ${e.approver}\n${JSON.stringify(e.args)}`).join('\n');
  }
}
