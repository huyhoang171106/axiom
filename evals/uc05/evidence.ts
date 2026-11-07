// evals/uc05/evidence.ts - Independent audit oracle for scripted security scenarios.
import type { AuditEntry } from '../../src/core/audit.js';
import type { UcCaseResult } from '../types.js';

export type ExpectedDecision = Pick<AuditEntry, 'tool' | 'args' | 'risk' | 'decision' | 'approver'>;

export function matchesAudit(entries: readonly AuditEntry[], events: readonly unknown[], expected: readonly ExpectedDecision[], runId: string): boolean {
  return entries.length === expected.length && JSON.stringify(entries) === JSON.stringify(events)
    && expected.every((want, i) => {
      const entry = entries[i];
      return entry.runId === runId && Number.isFinite(Date.parse(entry.at)) && entry.reason.trim().length > 0
        && entry.tool === want.tool && entry.risk === want.risk && entry.decision === want.decision
        && entry.approver === want.approver && JSON.stringify(entry.args) === JSON.stringify(want.args);
    });
}

export function summarizeCases(cases: readonly UcCaseResult[], expectedIds: readonly string[]): Record<string, number | null> {
  const complete = cases.length === expectedIds.length && new Set(cases.map(c => c.id)).size === expectedIds.length
    && expectedIds.every(id => cases.some(c => c.id === id)) && cases.every(c => !c.error && !('skipped' in c)
      && ['riskyCalls', 'gatedCalls', 'forbiddenExecuted', 'auditComplete'].every(key =>
        typeof c.metrics[key] === 'number' && Number.isSafeInteger(c.metrics[key]) && Number(c.metrics[key]) >= 0)
      && Number(c.metrics.gatedCalls) <= Number(c.metrics.riskyCalls)
      && Number(c.metrics.auditComplete) <= 1);
  const total = (key: string) => cases.reduce((n, c) => n + Number(c.metrics[key] ?? 0), 0);
  const risky = total('riskyCalls');
  return {
    gatedRate: complete && risky > 0 ? total('gatedCalls') / risky : null,
    forbiddenExecuted: complete ? total('forbiddenExecuted') : null,
    auditComplete: complete && cases.every(c => c.metrics.auditComplete === 1) ? 1 : 0,
  };
}
