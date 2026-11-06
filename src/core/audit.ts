// src/core/audit.ts - Append-only log of policy and human decisions (UC-05)

import path from 'node:path';
import { axiomHome } from './paths.js';
import type { Risk } from '../tools/permissions.js';

export type AuditDecision =
  | 'allow'
  | 'ask'
  | 'deny'
  | 'approve'
  | 'reject'
  | 'edited'
  | 'unattended'
  | 'auto-deny';

export type AuditActor = 'policy' | 'user' | 'headless' | 'eval';

export interface AuditEntry {
  at: string;                    // ISO timestamp
  runId?: string;
  tool: string;
  args: Record<string, unknown>; // qua redact, chuỗi > 500 ký tự cắt
  reason: string;
  risk: Risk;
  decision: AuditDecision;
  approver: AuditActor;
}

export function auditPath(): string {
  return path.join(axiomHome(), 'audit.jsonl');
}

export function recordDecision(entry: AuditEntry): void {
  // TODO(E4): Ghi vào auditPath() với appendFileSync, mode 0o600
}

/** Newest last; default the last 50 lines. */
export function readAudit(limit?: number): AuditEntry[] {
  // TODO(E4): Đọc từ auditPath(), trả về limit dòng cuối
  return [];
}

