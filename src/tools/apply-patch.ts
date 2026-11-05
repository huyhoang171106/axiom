// src/tools/apply-patch.ts - `apply_patch`: apply a unified diff to workspace files, all files or none
//
// Every file's new content is computed in memory before anything is written, so a bad path, a test
// tamper, a context mismatch or an unreadable file leaves the workspace untouched. A write that fails
// part way restores the files already written.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BaseTool, type ToolExecutionContext } from './base-tool.js';
import { escapesWorkspace, isSecretPath } from './permissions.js';
import { findTestTampering, type TestGuardOptions } from './test-guard.js';
import { lineEndingOf, splitLines } from './text-lines.js';

export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] } // lines keep their ' ', '-', '+' prefix
export interface FilePatch { oldPath: string | null; newPath: string | null; hunks: Hunk[] } // null = /dev/null (file created or deleted)

/** A hunk whose context or removed lines are not in the file where the diff says. */
export class PatchConflict extends Error {
  constructor(readonly path: string, readonly hunkIndex: number, readonly expected: string, readonly actual: string, readonly actualRange: string) {
    super(`hunk ${hunkIndex + 1} of ${path} does not apply`);
    this.name = 'PatchConflict';
  }
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_CONFLICT_CHARS = 2000;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** Marks the line before it as having no trailing newline; it belongs to no side of the hunk. */
const NO_NEWLINE = '\\ No newline at end of file';

/** `--- a/x` / `+++ b/x` path: drops a trailing timestamp (tab-separated) and surrounding quotes; /dev/null is null. */
function headerPath(raw: string): string | null {
  const name = raw.split('\t')[0].trim().replace(/^"(.*)"$/, '$1');
  return name === '/dev/null' ? null : name;
}

/** Parses `diff --git`/plain unified diffs. Throws `invalid diff at line N: <reason>` (1-based line in `patch`). */
export function parseUnifiedDiff(patch: string): FilePatch[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const fail = (index: number, reason: string): never => {
    throw new Error(`invalid diff at line ${index + 1}: ${reason}`);
  };
  const patches: FilePatch[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) fail(i, 'binary patches are not supported');
    if (!line.startsWith('--- ')) {
      // `diff --git`, `index`, mode lines and free text between files carry nothing the hunks do not.
      if (line.startsWith('@@')) fail(i, 'hunk before a ---/+++ file header');
      if (line.startsWith('+++ ')) fail(i, '+++ header without a preceding --- header');
      i++;
      continue;
    }
    if (!lines[i + 1]?.startsWith('+++ ')) fail(i + 1, 'expected a +++ header after ---');
    let oldPath = headerPath(line.slice(4));
    let newPath = headerPath(lines[i + 1].slice(4));
    if (oldPath === null && newPath === null) fail(i, 'both sides are /dev/null');
    // git prefixes the two sides with a/ and b/; strip them only when the diff uses that convention.
    if ((oldPath === null || oldPath.startsWith('a/')) && (newPath === null || newPath.startsWith('b/'))) {
      oldPath = oldPath?.slice(2) ?? null;
      newPath = newPath?.slice(2) ?? null;
    }
    i += 2;
    const hunks: Hunk[] = [];
    while (i < lines.length && lines[i].startsWith('@@')) {
      const match = HUNK_HEADER.exec(lines[i]);
      if (!match) fail(i, `malformed hunk header "${lines[i].slice(0, 80)}"`);
      const [, oldStart, oldCount, newStart, newCount] = match!;
      const hunk: Hunk = {
        oldStart: Number(oldStart), oldLines: oldCount === undefined ? 1 : Number(oldCount),
        newStart: Number(newStart), newLines: newCount === undefined ? 1 : Number(newCount), lines: [],
      };
      const headerIndex = i++;
      let oldSeen = 0;
      let newSeen = 0;
      while (oldSeen < hunk.oldLines || newSeen < hunk.newLines) {
        if (i >= lines.length) fail(headerIndex, `hunk ends early: expected ${hunk.oldLines} old and ${hunk.newLines} new lines, got ${oldSeen} and ${newSeen}`);
        // Models often drop the single space of an empty context line; inside a hunk that is unambiguous.
        const body = lines[i] === '' ? ' ' : lines[i];
        const kind = body[0];
        if (body === NO_NEWLINE) { hunk.lines.push(body); i++; continue; }
        if (kind !== ' ' && kind !== '-' && kind !== '+') fail(i, `unexpected line in hunk (must start with ' ', '-' or '+')`);
        if (kind !== '+') oldSeen++;
        if (kind !== '-') newSeen++;
        if (oldSeen > hunk.oldLines || newSeen > hunk.newLines) fail(i, `hunk has more lines than its header @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        hunk.lines.push(body);
        i++;
      }
      if (lines[i] === NO_NEWLINE) hunk.lines.push(lines[i++]);
      hunks.push(hunk);
    }
    if (!hunks.length) fail(i - 1, `no hunks for ${newPath ?? oldPath}`);
    patches.push({ oldPath, newPath, hunks });
  }
  if (!patches.length) throw new Error('invalid diff at line 1: no ---/+++ file headers found');
  return patches;
}

/** Old-side or new-side lines of a hunk, without prefixes, and whether that side's last line lacks a newline. */
function hunkSide(hunk: Hunk, side: 'old' | 'new'): { lines: string[]; noFinalNewline: boolean } {
  const skip = side === 'old' ? '+' : '-';
  const out: string[] = [];
  let noFinalNewline = false;
  for (let k = 0; k < hunk.lines.length; k++) {
    const line = hunk.lines[k];
    if (line === NO_NEWLINE) continue;
    if (line[0] === skip) continue;
    out.push(line.slice(1));
    noFinalNewline = hunk.lines[k + 1] === NO_NEWLINE;
  }
  return { lines: out, noFinalNewline };
}

/** Trailing `\r` is the file's line ending, not content: a CRLF file still matches a diff written with LF. */
const sameLine = (a: string, b: string) => a.replace(/\r$/, '') === b.replace(/\r$/, '');

function matchesAt(fileLines: readonly string[], block: readonly string[], at: number): boolean {
  if (at < 0 || at + block.length > fileLines.length) return false;
  return block.every((line, k) => sameLine(fileLines[at + k], line));
}

/**
 * Applies `hunks` to `source` (`path` only names the file in a conflict). A hunk is tried at its stated line
 * first, then at the nearest offset after the previous hunk where its old lines match exactly, as `patch`
 * does; whitespace other than the line ending is never fuzzed. Keeps the file's line ending.
 */
export function applyHunks(source: string, hunks: readonly Hunk[], filePath = '<file>'): string {
  const eol = lineEndingOf(source);
  const fileLines = splitLines(source);
  if (source === '') fileLines.length = 0;
  let finalNewline = source === '' ? true : source.endsWith('\n');
  const out: string[] = [];
  let cursor = 0;
  hunks.forEach((hunk, index) => {
    const oldSide = hunkSide(hunk, 'old');
    const newSide = hunkSide(hunk, 'new');
    // A pure insertion (`-N,0`) goes after line N; anything else starts at line N.
    const expected = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    let at = -1;
    for (let distance = 0; at < 0 && (expected - distance >= cursor || expected + distance <= fileLines.length); distance++) {
      if (expected - distance >= cursor && matchesAt(fileLines, oldSide.lines, expected - distance)) at = expected - distance;
      else if (distance > 0 && expected + distance >= cursor && matchesAt(fileLines, oldSide.lines, expected + distance)) at = expected + distance;
    }
    if (at < 0) {
      const from = Math.min(Math.max(expected, 0), fileLines.length);
      const actual = fileLines.slice(from, from + Math.max(oldSide.lines.length, 1));
      throw new PatchConflict(
        filePath, index, oldSide.lines.join('\n'), actual.map((l) => l.replace(/\r$/, '')).join('\n'),
        actual.length ? `${from + 1}-${from + actual.length}` : `${from + 1} (end of file)`
      );
    }
    out.push(...fileLines.slice(cursor, at), ...newSide.lines);
    cursor = at + oldSide.lines.length;
    // The hunk that reaches the end of the file decides whether the file ends with a newline.
    if (cursor === fileLines.length) finalNewline = !newSide.noFinalNewline;
  });
  out.push(...fileLines.slice(cursor));
  if (!out.length) return '';
  return out.map((l) => l.replace(/\r$/, '')).join(eol) + (finalNewline ? eol : '');
}

function clip(text: string): string {
  return text.length > MAX_CONFLICT_CHARS ? `${text.slice(0, MAX_CONFLICT_CHARS)}\n… (truncated)` : text;
}

/** Reads a UTF-8 text file the same way `edit` does: refuse binary or non-UTF-8 content instead of corrupting it. */
function readText(abs: string, rel: string): string {
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error(`${rel} is not a regular file`);
  if (stat.size > MAX_FILE_SIZE) throw new Error(`${rel} is too large to patch (limit ${MAX_FILE_SIZE} bytes)`);
  const buffer = fs.readFileSync(abs);
  if (buffer.includes(0) || !Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer)) {
    throw new Error(`${rel} is not valid UTF-8 text (binary or another encoding)`);
  }
  return buffer.toString('utf8');
}

function writeAtomic(abs: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', ...(mode !== undefined && { mode }) });
    fs.renameSync(temp, abs);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/** Planned effect on one path: `after === null` deletes it, `before === null` creates it. */
interface Change { rel: string; abs: string; before: string | null; after: string | null; mode?: number }

export class ApplyPatchTool extends BaseTool {
  readonly name = 'apply_patch';
  readonly description = 'Apply a unified diff (git diff format) to files in the workspace. Either every hunk applies or no file is changed.';
  readonly parameters = {
    type: 'object',
    properties: { patch: { type: 'string', description: 'Unified diff with ---/+++ headers and @@ hunks' } },
    required: ['patch'],
  };

  /**
   * `guard.allowedTests` comes from the code that builds the registry (issue metadata or a human), never
   * from tool arguments, so the model cannot grant itself permission to change a test.
   */
  constructor(private readonly guard: TestGuardOptions = {}) {
    super();
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const patch = typeof args.patch === 'string' ? args.patch : '';
    if (!patch.trim()) return 'Error: patch must be a non-empty unified diff';
    const root = path.resolve(context?.workspaceRoot ?? process.cwd());

    let patches: FilePatch[];
    try {
      patches = parseUnifiedDiff(patch);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Kept even though decide() checks these too (phase-2.md mục 7): the tool must be safe on its own.
    const seen = new Set<string>();
    for (const p of patches) {
      for (const target of new Set([p.oldPath, p.newPath])) {
        if (target === null) continue;
        if (path.isAbsolute(target) || escapesWorkspace(target, root)) return `Error: ${target} is outside the workspace`;
        if (isSecretPath(target) || isSecretPath(realRelative(target, root))) return `Error: ${target} is a secret file and cannot be patched`;
        const key = path.resolve(root, target);
        if (seen.has(key)) return `Error: ${target} appears in more than one file patch; merge them into one`;
        seen.add(key);
      }
    }

    const tamper = findTestTampering(patches, root, this.guard);
    if (tamper) return `Error: ${tamper}`;

    const changes: Change[] = [];
    for (const p of patches) {
      const rel = (p.oldPath ?? p.newPath)!;
      const abs = path.resolve(root, rel);
      let before: string | null = null;
      let mode: number | undefined;
      try {
        if (p.oldPath === null) {
          if (fs.existsSync(abs)) return `Error: ${p.newPath} already exists; a /dev/null diff only creates new files`;
        } else {
          if (!fs.existsSync(abs)) return `Error: ${p.oldPath} does not exist`;
          before = readText(abs, p.oldPath);
          mode = fs.statSync(abs).mode;
        }
        const after = applyHunks(before ?? '', p.hunks, rel);
        if (p.newPath === null && after !== '') {
          return `Error: the diff deletes ${p.oldPath} but its hunks do not remove every line of it`;
        }
        if (p.newPath !== null && p.oldPath !== null && p.newPath !== p.oldPath) {
          // Rename: write the new path, delete the old one.
          const target = path.resolve(root, p.newPath);
          if (fs.existsSync(target)) return `Error: cannot rename ${p.oldPath} to ${p.newPath}: the target exists`;
          changes.push({ rel: p.newPath, abs: target, before: null, after, mode });
          changes.push({ rel: p.oldPath, abs, before, after: null });
        } else {
          changes.push({ rel, abs, before, after: p.newPath === null ? null : after, mode });
        }
      } catch (err) {
        if (err instanceof PatchConflict) {
          return (
            `Error: hunk ${err.hunkIndex + 1} of ${err.path} does not apply. Expected:\n${clip(err.expected)}\n` +
            `Actual (lines ${err.actualRange}):\n${clip(err.actual)}\nRe-read the file and send a diff against its current content.`
          );
        }
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const done: Change[] = [];
    try {
      for (const change of changes) {
        if (change.after === null) fs.rmSync(change.abs);
        else writeAtomic(change.abs, change.after, change.mode);
        done.push(change);
      }
    } catch (err) {
      // Put back what was already written so a half-applied patch never stays on disk.
      for (const change of done.reverse()) {
        try {
          if (change.before === null) fs.rmSync(change.abs, { force: true });
          else writeAtomic(change.abs, change.before, change.mode);
        } catch {
          // Best effort: the error below already reports the failed write.
        }
      }
      return `Error: writing ${changes[done.length]?.rel ?? 'a file'} failed, no file was changed: ${err instanceof Error ? err.message : String(err)}`;
    }

    return patches
      .map((p) => {
        const added = p.hunks.reduce((n, h) => n + h.lines.filter((l) => l[0] === '+').length, 0);
        const removed = p.hunks.reduce((n, h) => n + h.lines.filter((l) => l[0] === '-').length, 0);
        const label = p.oldPath && p.newPath && p.oldPath !== p.newPath ? `${p.oldPath} -> ${p.newPath}` : (p.newPath ?? p.oldPath)!;
        const note = p.oldPath === null ? ', created' : p.newPath === null ? ', deleted' : '';
        return `Applied: ${label} (+${added} -${removed}${note})`;
      })
      .join('\n');
  }
}

/** Workspace-relative path after symlinks, so a link to `.env` is caught as a secret. */
function realRelative(target: string, root: string): string {
  try {
    return path.relative(fs.realpathSync.native(root), fs.realpathSync.native(path.resolve(root, target)));
  } catch {
    return target;
  }
}
