// src/core/rag/citations.ts - Parse `path:Lx-Ly` citations and check them against the repo and retrieved chunks

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { escapesWorkspace } from '../../tools/permissions.js';
import type { Chunk, Citation } from './types.js';

export const CITATION_RE = /([\w./-]+\.\w+):L(\d+)(?:-L?(\d+))?/g;

export function parseCitations(text: string): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    const startLine = Number(m[2]);
    const c = { path: m[1].replace(/^\.\//, ''), startLine, endLine: m[3] ? Number(m[3]) : startLine };
    const key = `${c.path}:${c.startLine}-${c.endLine}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push(c);
    }
  }
  return citations;
}

function lineCount(file: string): number {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r\n|\r|\n/);
  return lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** null = valid; otherwise why the citation is wrong. */
export function validateCitation(c: Citation, root: string, retrieved: readonly Chunk[]): string | null {
  const abs = path.resolve(root, c.path);
  if (path.isAbsolute(c.path) || escapesWorkspace(c.path, root) || !fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) return 'file not found';
  if (c.startLine < 1 || c.startLine > c.endLine || c.endLine > lineCount(abs)) return 'line out of range';
  const overlaps = retrieved.some((chunk) => chunk.path === c.path && chunk.startLine <= c.endLine && c.startLine <= chunk.endLine);
  return overlaps ? null : 'not from retrieved context';
}

/** OSC 8 hyperlink: terminals that support it open the file at the line, others show the plain label. */
export function fileLink(root: string, c: Citation): string {
  const url = `${pathToFileURL(path.resolve(root, c.path)).href}#L${c.startLine}`;
  return `\x1b]8;;${url}\x1b\\${c.path}:L${c.startLine}-L${c.endLine}\x1b]8;;\x1b\\`;
}
