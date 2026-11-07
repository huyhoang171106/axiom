// src/tui/approval-preview.ts - Presentation-only patch and replacement previews.
import { redact } from '../core/secrets.js';

export function approvalPreview(name: string, args: Record<string, unknown>): string | undefined {
  if (name === 'apply_patch' && typeof args.patch === 'string') return redact(args.patch);
  if (name !== 'edit' || typeof args.oldText !== 'string' || typeof args.newText !== 'string') return;
  // Đây là đoạn thay thế, không giả lập vị trí dòng hoặc nội dung toàn file.
  return redact([
    `Replacement snippet: ${String(args.path ?? '')}`,
    `replaceAll=${args.replaceAll === true}; range=${String(args.lineRange ?? `${args.startLine ?? '?'}-${args.endLine ?? '?'}`)}`,
    ...args.oldText.split(/\r?\n/).map(line => `-${line}`),
    ...args.newText.split(/\r?\n/).map(line => `+${line}`),
  ].join('\n'));
}
