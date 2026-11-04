// src/core/rag/chunker.ts - Split the target repo into chunks: Python by `ast`, Markdown by heading

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSecretPath } from '../../tools/permissions.js';
import { pythonBin } from '../paths.js';
import { scrubEnv } from '../secrets.js';
import type { Chunk, ChunkSource } from './types.js';

export const DOC_FILES = /^(README|CONTRIBUTING|CHANGELOG|AGENTS)(\.\w+)?$|^docs\/.+\.(md|rst|txt)$/i;

/** The team's conventions (topic section 2.3), shipped with Axiom; indexed as source 'team', never as a repo path. */
export const TEAM_DOCS_DIR = fileURLToPath(new URL('../../../knowledge/', import.meta.url));
const TEAM_DOC_FILES = /\.(md|rst|txt)$/i;

const SKIPPED_DIRS = new Set(['.venv', '__pycache__', '.git', 'node_modules']);
const MAX_FILE_BYTES = 200 * 1024;
const MAX_CHUNK_LINES = 120;

// Reads bytes so ast honours the file's own encoding; `-I` ignores PYTHONIOENCODING, so stdin text would use the locale.
const SCRIPT = String.raw`
import ast, json, sys
src = sys.stdin.buffer.read()
try:
    tree = ast.parse(src)
except (SyntaxError, ValueError):
    print("null")
    sys.exit(0)
out = []
def start(n):
    return min([d.lineno for d in n.decorator_list] + [n.lineno])
FUNCS = (ast.FunctionDef, ast.AsyncFunctionDef)
for n in tree.body:
    if isinstance(n, FUNCS):
        out.append({"symbol": n.name, "kind": "function", "startLine": start(n), "endLine": n.end_lineno})
    elif isinstance(n, ast.ClassDef):
        methods = [m for m in n.body if isinstance(m, FUNCS)]
        end = start(methods[0]) - 1 if methods else n.end_lineno
        out.append({"symbol": n.name, "kind": "class", "startLine": start(n), "endLine": max(end, n.lineno)})
        for m in methods:
            out.append({"symbol": n.name + "." + m.name, "kind": "method", "startLine": start(m), "endLine": m.end_lineno})
print(json.dumps(out))
`;

interface PySpan { symbol: string; kind: 'function' | 'class' | 'method'; startLine: number; endLine: number }

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function splitLines(source: string): string[] {
  const lines = source.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function makeChunk(relPath: string, lines: readonly string[], span: Omit<Chunk, 'id' | 'path' | 'text'>): Chunk {
  return {
    id: `${relPath}:${span.startLine}-${span.endLine}`,
    path: relPath,
    ...span,
    text: lines.slice(span.startLine - 1, span.endLine).join('\n'),
  };
}

/** Chunks longer than MAX_CHUNK_LINES become consecutive pieces that keep the symbol, so one huge function cannot crowd the context. */
function splitLong(relPath: string, lines: readonly string[], span: Omit<Chunk, 'id' | 'path' | 'text'>): Chunk[] {
  const chunks: Chunk[] = [];
  for (let s = span.startLine; s <= span.endLine; s += MAX_CHUNK_LINES) {
    chunks.push(makeChunk(relPath, lines, { ...span, startLine: s, endLine: Math.min(s + MAX_CHUNK_LINES - 1, span.endLine) }));
  }
  return chunks;
}

/** Inclusive line runs of `[from, to]` that are not blank, after removing blank lines at both ends. */
function trimmedRun(lines: readonly string[], from: number, to: number): [number, number] | null {
  while (from <= to && !lines[from - 1].trim()) from++;
  while (to >= from && !lines[to - 1].trim()) to--;
  return from <= to ? [from, to] : null;
}

function runPython(python: string, source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-c', SCRIPT], { env: scrubEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${python} exited with ${code}: ${stderr.trim().slice(0, 300)}`))));
    child.stdin.end(source, 'utf8');
  });
}

export async function chunkPython(relPath: string, source: string, python: string): Promise<Chunk[]> {
  const lines = splitLines(source);
  if (lines.every((l) => !l.trim())) return [];
  const parsed: unknown = JSON.parse(await runPython(python, source));
  const base = { fileType: 'python' as const };
  if (parsed === null) return splitLong(relPath, lines, { ...base, symbol: null, kind: 'module', startLine: 1, endLine: lines.length });
  if (!Array.isArray(parsed)) throw new Error(`ast chunker returned no list for ${relPath}`);
  const spans = parsed as PySpan[];
  const chunks: Chunk[] = spans.flatMap((s) => splitLong(relPath, lines, { ...base, symbol: s.symbol, kind: s.kind, startLine: s.startLine, endLine: s.endLine }));

  // Module-level code (imports, constants, `if __name__` blocks) is every line no def/class covers; each contiguous run is one chunk.
  const covered = new Array<boolean>(lines.length + 2).fill(false);
  for (const s of spans) for (let i = s.startLine; i <= s.endLine; i++) covered[i] = true;
  let runStart = 0;
  for (let i = 1; i <= lines.length + 1; i++) {
    const free = i <= lines.length && !covered[i];
    if (free && !runStart) runStart = i;
    if (!free && runStart) {
      const run = trimmedRun(lines, runStart, i - 1);
      if (run) chunks.push(...splitLong(relPath, lines, { ...base, symbol: null, kind: 'module', startLine: run[0], endLine: run[1] }));
      runStart = 0;
    }
  }
  return chunks.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

const HEADING = /^#{1,3}\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function chunkMarkdown(relPath: string, source: string): Chunk[] {
  const lines = splitLines(source);
  const starts: { line: number; symbol: string | null }[] = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) inFence = !inFence;
    const m = !inFence && HEADING.exec(line);
    if (m) starts.push({ line: i + 1, symbol: m[1] });
  });
  if (starts.length === 0 || starts[0].line > 1) starts.unshift({ line: 1, symbol: null });
  return starts.flatMap((s, i) => {
    const run = trimmedRun(lines, s.line, (starts[i + 1]?.line ?? lines.length + 1) - 1);
    return run ? splitLong(relPath, lines, { symbol: s.symbol, kind: 'doc', fileType: 'markdown', startLine: run[0], endLine: run[1] }) : [];
  });
}

function chunkText(relPath: string, source: string): Chunk[] {
  const lines = splitLines(source);
  const run = trimmedRun(lines, 1, lines.length);
  return run ? splitLong(relPath, lines, { symbol: null, kind: 'doc', fileType: 'text', startLine: run[0], endLine: run[1] }) : [];
}

function isSkipped(relPath: string): boolean {
  return relPath.split('/').some((part) => SKIPPED_DIRS.has(part)) || isSecretPath(relPath);
}

function isIndexed(relPath: string): boolean {
  return relPath.endsWith('.py') || DOC_FILES.test(relPath);
}

function walk(root: string, dir = ''): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : walk(root, rel);
    return entry.isFile() ? [rel] : [];
  });
}

/** Files the index covers, relative to `root` with '/' separators: tracked plus untracked-but-not-ignored when `root` is in a git repo. */
export function listRepoFiles(root: string): string[] {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const candidates = git.status === 0 && !git.error ? git.stdout.split('\0').filter(Boolean) : walk(root);
  return [...new Set(candidates.map(toPosix))]
    .filter((rel) => isIndexed(rel) && !isSkipped(rel))
    .filter((rel) => {
      // `--cached` still lists a tracked file deleted from the working tree.
      const stat = fs.statSync(path.join(root, rel), { throwIfNoEntry: false });
      return stat?.isFile() === true && stat.size <= MAX_FILE_BYTES;
    })
    .sort();
}

/** Team doc files under `dir`, relative with '/' separators; same secret and size limits as the repo. */
export function listTeamDocs(dir: string): string[] {
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return walk(dir)
    .filter((rel) => TEAM_DOC_FILES.test(rel) && !isSkipped(rel))
    .filter((rel) => fs.statSync(path.join(dir, rel)).size <= MAX_FILE_BYTES)
    .sort();
}

/** Chunks of one file by type; the caller has already checked it is indexed. Team chunks get a `team:` id so they never collide with a repo file of the same path. */
export async function chunkFile(relPath: string, source: string, python: string, from: ChunkSource = 'repo'): Promise<Chunk[]> {
  const chunks = relPath.endsWith('.py')
    ? await chunkPython(relPath, source, python)
    : /\.md$/i.test(relPath)
      ? chunkMarkdown(relPath, source)
      : chunkText(relPath, source);
  return from === 'team' ? chunks.map((c) => ({ ...c, id: `team:${c.id}`, source: 'team' })) : chunks;
}

export async function chunkRepo(root: string, opts?: { python?: string }): Promise<Chunk[]> {
  const python = opts?.python ?? pythonBin();
  const chunks: Chunk[] = [];
  for (const rel of listRepoFiles(root)) chunks.push(...(await chunkFile(rel, fs.readFileSync(path.join(root, rel), 'utf8'), python)));
  return chunks;
}
