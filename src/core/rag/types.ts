// src/core/rag/types.ts - Shared RAG types (phase-2.md section 5.3)

/** 'repo': the target repo. 'team': the team's own conventions (topic section 2.3), trusted docs that live outside the repo. */
export type ChunkSource = 'repo' | 'team';

export interface Chunk {
  id: string;                 // `${path}:${startLine}-${endLine}`, prefixed `team:` for team docs
  path: string;               // relative to workspaceRoot (or the team docs dir), '/' separators
  source?: ChunkSource;       // absent = 'repo'
  symbol: string | null;      // 'TinyDB.insert', 'Query.search', null for docs
  kind: 'function' | 'class' | 'method' | 'module' | 'doc';
  startLine: number;          // 1-based, decorators included
  endLine: number;            // 1-based, inclusive
  fileType: 'python' | 'markdown' | 'text';
  text: string;
}
export interface ScoredChunk extends Chunk { score: number }
export interface Citation { path: string; startLine: number; endLine: number; source?: ChunkSource }
export interface IndexDiff { added: string[]; changed: string[]; removed: string[] }
export type Embedder = (texts: readonly string[]) => Promise<number[][]>;
