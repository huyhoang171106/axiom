// src/core/memory.ts - Long-term per-repo memory, added to the system prompt of later sessions (UC-04)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { axiomHome } from './paths.js';

/** Basename plus a hash of the real path, so two repos with the same name never share memory. */
export function memoryPath(workspaceRoot: string): string {
  const root = fs.realpathSync(workspaceRoot);
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
  return path.join(axiomHome(), 'memory', `${path.basename(root)}-${hash}.md`);
}

export function loadMemory(workspaceRoot: string): string {
  // TODO(D4)
  return '';
}

export function addMemory(workspaceRoot: string, note: string): void {
  // TODO(D4): append "- <note>" through redact.
}

export function clearMemory(workspaceRoot: string): void {
  // TODO(D4)
}
