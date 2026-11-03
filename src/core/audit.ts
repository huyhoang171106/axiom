// src/core/audit.ts - Append-only log of policy and human decisions (UC-05)

import type { Risk } from '../tools/permissions.js';

export interface AuditEntry {
  at: string;                    // ISO
  runId?: string;
  tool: string;
  args: Record<string, unknown>; // redacted, strings over 500 chars cut
  reason: string;
  risk: Risk;
  decision: 'allow' | 'deny' | 'approve' | 'reject' | 'edited' | 'auto-deny';
  approver: 'policy' | 'user' | 'headless' | 'eval';
}

export function recordDecision(entry: AuditEntry): void {
  // TODO(E4)
}

/** Newest last; default the last 50 lines. */
export function readAudit(limit?: number): AuditEntry[] {
  // TODO(E4)
  return [];
}
