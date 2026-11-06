// src/core/audit.ts - Append-only log of policy and human decisions (UC-05)

import type { Risk } from '../tools/permissions.js';
import fs from 'node:fs';
import path from 'node:path';
import { axiomHome } from './paths.js';
import { redact } from './secrets.js';

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

export function auditPath(): string {
  return path.join(axiomHome(), 'audit.jsonl');
}

function safeEntry(entry: AuditEntry): AuditEntry {
  // Redact trước khi cắt để không lưu một phần đầu của secret dài.
  const args: Record<string, unknown> = JSON.parse(JSON.stringify(entry.args,
    (_key, value: unknown) => typeof value === 'string' ? redact(value).slice(0, 500) : value));
  return JSON.parse(JSON.stringify({ ...entry, args },
    (_key, value: unknown) => typeof value === 'string' ? redact(value) : value)) as AuditEntry;
}

export function recordDecision(entry: AuditEntry): void {
  const file = auditPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const line = JSON.stringify(safeEntry(entry)) + '\n';
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    // Sửa cả quyền file tồn tại từ trước; Windows dùng ACL của nền tảng.
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.appendFileSync(fd, line, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Newest last; default the last 50 lines. */
export function readAudit(limit?: number): AuditEntry[] {
  const count = limit ?? 50;
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Audit limit must be a positive integer');
  const file = auditPath();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim())
    .slice(-count).map((line) => safeEntry(JSON.parse(line) as AuditEntry));
}
