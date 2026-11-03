// src/core/rag/citations.ts - Parse `path:Lx-Ly` citations and check them against the repo and retrieved chunks

import type { Chunk, Citation } from './types.js';

export function parseCitations(text: string): Citation[] {
  // TODO(B4)
  return [];
}

/** null = valid; otherwise why the citation is wrong. */
export function validateCitation(c: Citation, root: string, retrieved: readonly Chunk[]): string | null {
  // TODO(B4)
  return null;
}
