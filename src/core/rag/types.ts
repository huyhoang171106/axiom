// src/core/rag/types.ts - Shared RAG types (phase-2.md section 5.3)

export interface Chunk {
  id: string;                 // `${path}:${startLine}-${endLine}`
  path: string;               // relative to workspaceRoot, '/' separators
  symbol: string | null;      // 'TinyDB.insert', 'Query.search', null for docs
  kind: 'function' | 'class' | 'method' | 'module' | 'doc';
  startLine: number;          // 1-based, decorators included
  endLine: number;            // 1-based, inclusive
  fileType: 'python' | 'markdown' | 'text';
  text: string;
}
export interface ScoredChunk extends Chunk { score: number }
export interface Citation { path: string; startLine: number; endLine: number }
export interface IndexDiff { added: string[]; changed: string[]; removed: string[] }
export type Embedder = (texts: readonly string[]) => Promise<number[][]>;
