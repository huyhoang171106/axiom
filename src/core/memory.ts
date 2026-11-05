// src/core/memory.ts - Long-term per-repo memory, added to the system prompt of later sessions (UC-04)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { axiomHome } from './paths.js';
import { redact } from './secrets.js';

/** Basename plus a hash of the real path, so two repos with the same name never share memory. */
export function memoryPath(workspaceRoot: string): string {
  const root = fs.realpathSync(workspaceRoot);
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
  return path.join(axiomHome(), 'memory', `${path.basename(root)}-${hash}.md`);
}

/** Reads saved memory for this workspace, returning empty string if nonexistent. */
export function loadMemory(workspaceRoot: string): string {
  try {
    const file = memoryPath(workspaceRoot);
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Appends a single note line ("- <note>") to this workspace's memory, redacting secrets. */
export function addMemory(workspaceRoot: string, note: string): void {
  const file = memoryPath(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rawNote = note.trim().replace(/^[-*]\s*/, '');
  const cleanNote = redact(rawNote);
  if (!cleanNote) return;
  const line = `- ${cleanNote}\n`;
  fs.appendFileSync(file, line, 'utf8');
}

/** Deletes the memory file for this workspace. */
export function clearMemory(workspaceRoot: string): void {
  try {
    const file = memoryPath(workspaceRoot);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {
    // ignore
  }
}
