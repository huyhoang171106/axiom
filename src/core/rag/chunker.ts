// src/core/rag/chunker.ts - Split the target repo into chunks: Python by `ast`, Markdown by heading

import type { Chunk } from './types.js';

export async function chunkRepo(root: string): Promise<Chunk[]> {
  // TODO(B1): python -I with the ast module via pythonBin(), Markdown by heading.
  return [];
}
