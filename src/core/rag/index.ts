// src/core/rag/index.ts - Hybrid BM25 + vector index of one repo, updated incrementally by file hash

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { axiomHome, pythonBin } from '../paths.js';
import { Bm25, tokenize } from './bm25.js';
import { chunkFile, listRepoFiles } from './chunker.js';
import type { Chunk, Embedder, IndexDiff, ScoredChunk } from './types.js';

/** Final score = cosine * vector + normalized BM25 * bm25 + symbol hit * symbol. Tuned in B5 (docs/uc-02.md). */
export const SEARCH_WEIGHTS = { vector: 0.5, bm25: 0.3, symbol: 0.2 } as const;
const DEFAULT_K = 5;

interface Meta { embedModel: string; dim: number }

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** What is embedded and BM25-scored: path and symbol help a question that names a file or function. */
function searchText(c: Chunk): string {
  return `${c.path} ${c.symbol ?? ''}\n${c.text}`;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    // Missing or unreadable index file: start from empty, the next update rebuilds it.
    return fallback;
  }
}

export class RepoIndex {
  private chunks: Chunk[] = [];
  private vectors: Record<string, number[]> = {};
  private files: Record<string, string> = {};
  private meta: Meta | null = null;
  private bm25: Bm25 | null = null;
  private isBuilt = false;

  private constructor(
    readonly root: string,
    private readonly embedder: Embedder,
    readonly dir: string,
    private readonly embedModel: string,
    private readonly python: string
  ) {}

  /**
   * `embedModel` names the model behind `embedder` (the `modelRoles.embed` selector); a different one than the stored
   * index was built with discards every vector, since vectors of two models are not comparable.
   */
  static async open(root: string, embedder: Embedder, opts?: { dir?: string; embedModel?: string; python?: string }): Promise<RepoIndex> {
    const real = fs.realpathSync(root);
    const dir = opts?.dir ?? path.join(axiomHome(), 'index', sha256(real).slice(0, 12));
    const index = new RepoIndex(real, embedder, dir, opts?.embedModel ?? 'unknown', opts?.python ?? pythonBin());
    index.load();
    return index;
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private load(): void {
    const meta = readJson<Meta | null>(this.file('meta.json'), null);
    if (!meta || meta.embedModel !== this.embedModel) return;
    this.meta = meta;
    this.chunks = readJson<Chunk[]>(this.file('chunks.json'), []);
    this.vectors = readJson<Record<string, number[]>>(this.file('vectors.json'), {});
    this.files = readJson<Record<string, string>>(this.file('files.json'), {});
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const entries: [string, unknown][] = [['chunks.json', this.chunks], ['vectors.json', this.vectors], ['files.json', this.files], ['meta.json', this.meta]];
    for (const [name, value] of entries) fs.writeFileSync(this.file(name), JSON.stringify(value));
  }

  async update(): Promise<IndexDiff> {
    const current: Record<string, string> = {};
    const sources: Record<string, string> = {};
    for (const rel of listRepoFiles(this.root)) {
      const buf = fs.readFileSync(path.join(this.root, rel));
      current[rel] = sha256(buf);
      sources[rel] = buf.toString('utf8');
    }
    const diff: IndexDiff = {
      added: Object.keys(current).filter((p) => !(p in this.files)),
      changed: Object.keys(current).filter((p) => p in this.files && this.files[p] !== current[p]),
      removed: Object.keys(this.files).filter((p) => !(p in current)),
    };
    const chunks: Chunk[] = [];
    for (const rel of Object.keys(current)) chunks.push(...(await chunkFile(rel, sources[rel], this.python)));
    const embedded = chunks.length ? await this.embedder(chunks.map(searchText)) : [];
    this.chunks = chunks;
    this.vectors = Object.fromEntries(chunks.map((c, i) => [c.id, embedded[i]]));
    this.files = current;
    this.meta = { embedModel: this.embedModel, dim: embedded[0]?.length ?? this.meta?.dim ?? 0 };
    this.bm25 = null;
    this.isBuilt = true;
    this.save();
    return diff;
  }

  async search(query: string, k = DEFAULT_K): Promise<ScoredChunk[]> {
    if (!this.isBuilt) await this.update();
    if (this.chunks.length === 0) return [];
    this.bm25 ??= new Bm25(this.chunks.map((c) => ({ id: c.id, text: searchText(c) })));
    const [queryVector] = await this.embedder([query]);
    const keyword = this.bm25.score(query);
    const maxKeyword = Math.max(0, ...keyword.values());
    const words = new Set([...(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []), ...tokenize(query)]);
    const scored = this.chunks.map((c) => {
      const symbolTail = c.symbol?.split('.').pop()?.toLowerCase();
      const score =
        SEARCH_WEIGHTS.vector * cosine(queryVector, this.vectors[c.id] ?? []) +
        SEARCH_WEIGHTS.bm25 * (maxKeyword > 0 ? (keyword.get(c.id) ?? 0) / maxKeyword : 0) +
        SEARCH_WEIGHTS.symbol * (symbolTail && words.has(symbolTail) ? 1 : 0);
      return { ...c, score };
    });
    scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.startLine - b.startLine);
    return scored.slice(0, k);
  }
}
