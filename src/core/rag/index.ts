// src/core/rag/index.ts - Hybrid BM25 + vector index of one repo, updated incrementally by file hash

import type { Embedder, IndexDiff, ScoredChunk } from './types.js';

export class RepoIndex {
  private constructor(
    readonly root: string,
    private readonly embedder: Embedder
  ) {}

  static async open(root: string, embedder: Embedder, opts?: { dir?: string }): Promise<RepoIndex> {
    // TODO(B2): load or build the index under opts.dir.
    return new RepoIndex(root, embedder);
  }

  async update(): Promise<IndexDiff> {
    // TODO(B3)
    return { added: [], changed: [], removed: [] };
  }

  async search(query: string, k?: number): Promise<ScoredChunk[]> {
    // TODO(B2)
    return [];
  }
}
