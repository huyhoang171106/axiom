// src/core/rag/index.ts - Hybrid BM25 + vector index of one repo, updated incrementally by file hash

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { axiomHome, pythonBin } from '../paths.js';
import { Bm25, tokenize } from './bm25.js';
import { chunkFile, listRepoFiles, listTeamDocs } from './chunker.js';
import type { Chunk, ChunkSource, Embedder, IndexDiff, ScoredChunk } from './types.js';

/** Final score = cosine * vector + normalized BM25 * bm25 + symbol hit * symbol. Tuned in B5 (docs/uc-02.md). */
export const SEARCH_WEIGHTS = { vector: 0.5, bm25: 0.3, symbol: 0.2 } as const;
const DEFAULT_K = 5;
/** A search later than this after the last update re-hashes the repo first, so an answer after an edit sees the edit (UC-02 case 5). */
const STALE_AFTER_MS = 2000;

/**
 * How files become embedded text: chunker rules (ast spans, 120-line split, headings) and `searchText`.
 * Bump it when either changes, so stored vectors of the old text are rebuilt instead of mixed with new ones.
 */
export const PREPROCESSING_VERSION = 'chunk-ast-120+search-text-path-symbol/1';

/** The whole index is one file, so publishing it is one rename. */
const INDEX_FILE = 'index.json';
/** Layout before #13: four files renamed one by one, which a crash between renames could leave mixed. Deleted on publish. */
const LEGACY_FILES = ['chunks.json', 'vectors.json', 'files.json', 'meta.json'];

/** Index identity: embedder identity (`embedIdentity`), preprocessing and vector dimension. Any difference rebuilds. */
const MetaSchema = z.object({ embedModel: z.string(), preprocessing: z.string(), dim: z.number().int().nonnegative() });
type Meta = z.infer<typeof MetaSchema>;

const ChunkSchema = z.object({
  id: z.string(),
  path: z.string(),
  source: z.enum(['repo', 'team']).optional(),
  symbol: z.string().nullable(),
  kind: z.enum(['function', 'class', 'method', 'module', 'doc']),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  fileType: z.enum(['python', 'markdown', 'text']),
  text: z.string(),
});

const IndexFileSchema = z.object({
  meta: MetaSchema,
  files: z.record(z.string(), z.string()),
  chunks: z.array(ChunkSchema),
  vectors: z.record(z.string(), z.array(z.number())),
});
type IndexFile = z.infer<typeof IndexFileSchema>;

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

/** Key in `files` and diffs: a team doc and a repo file may share a path. */
function fileKey(c: { path: string; source?: ChunkSource }): string {
  return c.source === 'team' ? `team:${c.path}` : c.path;
}

/** Why a parsed index cannot be trusted, or null. `save` only publishes consistent indexes, so anything else is damage. */
function findInconsistency(index: IndexFile): string | null {
  const ids = new Set<string>();
  for (const c of index.chunks) {
    if (ids.has(c.id)) return `duplicate chunk ${c.id}`;
    ids.add(c.id);
    if (!(fileKey(c) in index.files)) return `chunk ${c.id} has no file hash`;
    if (index.vectors[c.id]?.length !== index.meta.dim) return `chunk ${c.id} has no vector of dimension ${index.meta.dim}`;
  }
  return Object.keys(index.vectors).length === ids.size ? null : 'vectors without a chunk';
}

/** The stored index, or null when it is missing, unparsable or inconsistent: then nothing is trusted and update rebuilds all. */
function readIndexFile(file: string): IndexFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing or truncated file: same as no index.
    return null;
  }
  const parsed = IndexFileSchema.safeParse(raw);
  return parsed.success && findInconsistency(parsed.data) === null ? parsed.data : null;
}

export class RepoIndex {
  private chunks: Chunk[] = [];
  private vectors: Record<string, number[]> = {};
  private files: Record<string, string> = {};
  private meta: Meta | null = null;
  private bm25: Bm25 | null = null;
  private lastUpdate = 0;

  private constructor(
    readonly root: string,
    private readonly embedder: Embedder,
    readonly dir: string,
    private readonly embedModel: string,
    private readonly python: string,
    private readonly teamDir: string | undefined
  ) {}

  /**
   * `embedModel` identifies the embedder (`embedIdentity`: provider, wire, endpoint, model tag); a different one than the
   * stored index was built with discards every vector, since vectors of two models are not comparable.
   * `teamDir` adds the team's conventions (e.g. TEAM_DOCS_DIR) as source 'team'; without it only the repo is indexed.
   */
  static async open(root: string, embedder: Embedder, opts?: { dir?: string; embedModel?: string; python?: string; teamDir?: string }): Promise<RepoIndex> {
    const real = fs.realpathSync(root);
    const dir = opts?.dir ?? path.join(axiomHome(), 'index', sha256(real).slice(0, 12));
    const index = new RepoIndex(real, embedder, dir, opts?.embedModel ?? 'unknown', opts?.python ?? pythonBin(), opts?.teamDir);
    index.load();
    return index;
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private load(): void {
    const stored = readIndexFile(this.file(INDEX_FILE));
    if (!stored || stored.meta.embedModel !== this.embedModel || stored.meta.preprocessing !== PREPROCESSING_VERSION) return;
    this.meta = stored.meta;
    this.chunks = stored.chunks;
    this.vectors = stored.vectors;
    this.files = stored.files;
  }

  /**
   * Publishes the whole index with one rename, so a reader sees the previous generation or this one, never a mix.
   * A crash before the rename leaves the previous index.json untouched; fsync first so the rename never points at unwritten data.
   */
  private save(meta: Meta): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.file(INDEX_FILE);
    const tmp = `${target}.${process.pid}.tmp`;
    const body: IndexFile = { meta, files: this.files, chunks: this.chunks, vectors: this.vectors };
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(body));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, target);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
    for (const name of LEGACY_FILES) fs.rmSync(this.file(name), { force: true });
  }

  /** Re-chunks and re-embeds only files whose sha256 changed; chunks of changed and removed files go first. */
  async update(): Promise<IndexDiff> {
    const current: Record<string, string> = {};
    const sources: Record<string, { path: string; source: ChunkSource; text: string }> = {};
    const read = (dir: string, rel: string, source: ChunkSource): void => {
      const buf = fs.readFileSync(path.join(dir, rel));
      const key = fileKey({ path: rel, source });
      current[key] = sha256(buf);
      sources[key] = { path: rel, source, text: buf.toString('utf8') };
    };
    for (const rel of listRepoFiles(this.root)) read(this.root, rel, 'repo');
    if (this.teamDir) for (const rel of listTeamDocs(this.teamDir)) read(this.teamDir, rel, 'team');
    const diff: IndexDiff = {
      added: Object.keys(current).filter((p) => !(p in this.files)),
      changed: Object.keys(current).filter((p) => p in this.files && this.files[p] !== current[p]),
      removed: Object.keys(this.files).filter((p) => !(p in current)),
    };
    this.lastUpdate = Date.now();
    if (diff.added.length + diff.changed.length + diff.removed.length === 0 && this.meta) return diff;

    const stale = new Set([...diff.changed, ...diff.removed]);
    for (const c of this.chunks) if (stale.has(fileKey(c))) delete this.vectors[c.id];
    const fresh: Chunk[] = [];
    for (const key of [...diff.added, ...diff.changed]) {
      const f = sources[key];
      fresh.push(...(await chunkFile(f.path, f.text, this.python, f.source)));
    }
    const embedded = fresh.length ? await this.embedder(fresh.map(searchText)) : [];
    fresh.forEach((c, i) => (this.vectors[c.id] = embedded[i]));
    this.chunks = [...this.chunks.filter((c) => !stale.has(fileKey(c))), ...fresh].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.startLine - b.startLine);
    this.files = current;
    const meta: Meta = { embedModel: this.embedModel, preprocessing: PREPROCESSING_VERSION, dim: embedded[0]?.length ?? this.meta?.dim ?? 0 };
    this.meta = meta;
    this.bm25 = null;
    this.save(meta);
    return diff;
  }

  async search(query: string, k = DEFAULT_K): Promise<ScoredChunk[]> {
    if (Date.now() - this.lastUpdate > STALE_AFTER_MS) await this.update();
    if (this.chunks.length === 0) return [];
    const [queryVector] = await this.embedder([query]);
    if (this.meta?.dim && queryVector.length !== this.meta.dim) {
      // The model behind an unchanged selector changed (or no embedModel was given): stored vectors no longer compare.
      this.files = {};
      this.chunks = [];
      this.vectors = {};
      await this.update();
    }
    this.bm25 ??= new Bm25(this.chunks.map((c) => ({ id: c.id, text: searchText(c) })));
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
