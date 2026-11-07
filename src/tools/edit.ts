// src/tools/edit.ts - Deterministic file editing tool with unique match validation and line targeting
//
// Exact-string replacement, not diffs: a model that did not see enough context to make the match unique
// gets a loud error naming every candidate position, instead of a silently corrupted region.
//
// The write path is byte-conservative on purpose: the file is read as a Buffer, refused when it is not
// valid UTF-8 (decoding with 'utf8' replaces every invalid byte with U+FFFD, and writing that back destroys
// the original bytes), lines are re-joined with the line ending the file already uses, the replacement is
// inserted literally (`$&` in `newText` is not a replacement pattern), and the write goes through a
// temp file + rename so an interrupted write cannot truncate the original.
import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseTool, type ToolExecutionContext } from './base-tool.js';
import { findChangeTampering, type TestGuardOptions } from './test-guard.js';
import { lineEndingOf, splitLines } from './text-lines.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ERROR_BLOCK_CHARS = 2000;

export class EditTool extends BaseTool {
  readonly name = 'edit';
  readonly description =
    'Edit a file by replacing oldText with newText. oldText must occur exactly once unless replaceAll is set; a line range can target the match instead.';
  readonly parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path of the file to edit',
      },
      oldText: {
        type: 'string',
        description: 'Existing text to replace (must match uniquely unless replaceAll or a line range is given)',
      },
      newText: {
        type: 'string',
        description: 'Replacement text to insert (empty string deletes the match)',
      },
      replaceAll: {
        type: 'boolean',
        description: 'Replace every occurrence instead of requiring a unique match',
      },
      lineRange: {
        type: 'string',
        description: 'Optional line range to target (e.g. "10-25" or "15")',
      },
      startLine: {
        type: 'number',
        description: 'Optional 1-based start line for replacement range',
      },
      endLine: {
        type: 'number',
        description: 'Optional 1-based end line for replacement range',
      },
    },
    required: ['path', 'oldText', 'newText'],
  };

  /** `guard.allowedTests` is set by trusted code building the registry, never by tool arguments (see test-guard.ts). */
  constructor(private readonly guard: TestGuardOptions = {}) {
    super();
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<string> {
    const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!rawPath) {
      throw new Error('Path argument must be a non-empty string');
    }

    if (typeof args.oldText !== 'string') {
      throw new Error('oldText argument must be a string');
    }

    if (typeof args.newText !== 'string') {
      throw new Error('newText argument must be a string');
    }

    const oldText = args.oldText;
    const newText = args.newText;
    const replaceAll = args.replaceAll === true;
    const targetPath = this.resolvePath(rawPath, context);

    if (oldText === newText) {
      throw new Error('oldText and newText are identical; nothing to change.');
    }

    let buffer: Buffer;
    let mode: number | undefined;
    try {
      const stat = await fs.stat(targetPath);
      if (stat.size > MAX_FILE_SIZE) {
        throw new Error(`File too large to edit: ${rawPath} is ${formatBytes(stat.size)} (limit ${formatBytes(MAX_FILE_SIZE)})`);
      }
      mode = stat.mode;
      buffer = await fs.readFile(targetPath);
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
      if (code === 'ENOENT') {
        throw new Error(`File not found: ${rawPath}`);
      }
      throw new Error(`Failed to read file ${rawPath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Refuse rather than corrupt: a NUL (binary) or a byte sequence that is not valid UTF-8 cannot survive a
    // decode/re-encode round trip, and the edit would silently rewrite bytes it was not asked to touch.
    if (buffer.includes(0) || !Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer)) {
      throw new Error(
        `${rawPath} is not valid UTF-8 text (binary or another encoding); edit it with a tool that works on bytes instead.`
      );
    }

    const originalContent = buffer.toString('utf8');
    const eol = lineEndingOf(originalContent);
    const targetRange = this.parseLineRange(args);
    const trailingNewline = originalContent.endsWith('\n');

    // Check if line-targeted replacement is requested
    if (targetRange) {
      const allLines = splitLines(originalContent);
      const totalLines = allLines.length;

      if (targetRange.start < 1 || targetRange.start > totalLines) {
        throw new Error(`Specified start line ${targetRange.start} is out of bounds (file has ${totalLines} lines)`);
      }
      if (targetRange.end < targetRange.start || targetRange.end > totalLines) {
        throw new Error(`Specified end line ${targetRange.end} is out of bounds (file has ${totalLines} lines)`);
      }

      // Extract target line block
      const targetLines = allLines.slice(targetRange.start - 1, targetRange.end);
      const targetBlock = targetLines.join(eol);

      if (oldText && !targetBlock.includes(oldText)) {
        throw new Error(
          `Target line range ${targetRange.start}-${targetRange.end} does not contain oldText.\n` +
          `Expected to find:\n${oldText}\n` +
          `Actual content in lines ${targetRange.start}-${targetRange.end}:\n${truncateForMessage(targetBlock)}`
        );
      }

      let updatedBlock: string;
      if (oldText) {
        const occurrences = this.countOccurrences(targetBlock, oldText);
        if (occurrences > 1 && !replaceAll) {
          throw new Error(
            `Found ${occurrences} occurrences of oldText within line range ${targetRange.start}-${targetRange.end}. ` +
            `Target range must contain exactly one occurrence, or pass replaceAll: true.`
          );
        }
        updatedBlock = replaceAll ? targetBlock.split(oldText).join(newText) : replaceLiterally(targetBlock, oldText, newText);
      } else {
        updatedBlock = newText;
      }

      const before = allLines.slice(0, targetRange.start - 1);
      const after = allLines.slice(targetRange.end);
      const replacementLines = updatedBlock === '' ? [] : splitLines(updatedBlock);
      const updatedLines = [...before, ...replacementLines, ...after];
      const finalContent = updatedLines.length === 0
        ? ''
        : updatedLines.join(eol) + (trailingNewline ? eol : '');

      this.refuseTestTampering(targetPath, originalContent, finalContent, context);
      await this.writeAtomically(targetPath, finalContent, mode);
      return `Successfully replaced text in ${rawPath} at lines ${targetRange.start}-${targetRange.end}`;
    }

    // Whole-file oldText replacement with unique match validation
    if (!oldText) {
      throw new Error('oldText cannot be empty when no line range is specified');
    }

    // A snippet typed with LF into a CRLF file would otherwise be reported as "not found" even though it is
    // exactly what the caller meant; retry once with the file's own ending before failing.
    let searchText = oldText;
    let matches = this.countOccurrences(originalContent, searchText);
    if (matches === 0 && eol === '\r\n' && oldText.includes('\n')) {
      const withCrlf = oldText.replace(/\r?\n/g, '\r\n');
      if (this.countOccurrences(originalContent, withCrlf) > 0) {
        searchText = withCrlf;
        matches = this.countOccurrences(originalContent, searchText);
      }
    }

    if (matches === 0) {
      throw new Error(
        `oldText not found in ${rawPath}.\n` +
        `Make sure the text matches exactly, including indentation and line breaks.`
      );
    }

    if (matches > 1 && !replaceAll) {
      const positions = this.findPositions(originalContent, searchText)
        .slice(0, 5)
        .map((p) => `line ${p.line}, col ${p.column}`)
        .join('; ');
      throw new Error(
        `oldText found ${matches} times in ${rawPath} (at ${positions}). ` +
        `Add surrounding context to make it unique, provide lineRange to disambiguate, or set replaceAll: true.`
      );
    }

    const updatedContent = replaceAll
      ? originalContent.split(searchText).join(newText)
      : replaceLiterally(originalContent, searchText, newText);
    this.refuseTestTampering(targetPath, originalContent, updatedContent, context);
    await this.writeAtomically(targetPath, updatedContent, mode);

    const replaced = replaceAll ? matches : 1;
    const delta = splitLines(updatedContent).length - splitLines(originalContent).length;
    return (
      `Successfully replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} of oldText in ${rawPath}` +
      ` (${delta >= 0 ? '+' : ''}${delta} lines)`
    );
  }

  /** Same test-tamper rules as `apply_patch`, so `edit` is not a way around them (UC-03). */
  private refuseTestTampering(targetPath: string, before: string, after: string, context?: ToolExecutionContext): void {
    const reason = findChangeTampering(targetPath, before, after, context?.workspaceRoot ?? process.cwd(), this.guard);
    if (reason) throw new Error(reason);
  }

  /**
   * Writes through a sibling temp file and renames it over the target, so a crash or a full disk leaves the
   * original intact instead of truncated (fs.writeFile opens with O_TRUNC).
   */
  private async writeAtomically(targetPath: string, content: string, mode?: number): Promise<void> {
    const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tempPath, content, { encoding: 'utf8', mode });
      await fs.rename(tempPath, targetPath);
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  private parseLineRange(args: Record<string, unknown>): { start: number; end: number } | null {
    if (typeof args.startLine === 'number' && args.startLine > 0) {
      const start = Math.floor(args.startLine);
      if (typeof args.endLine === 'number') {
        if (args.endLine < args.startLine) {
          throw new Error('startLine cannot be greater than endLine');
        }
        return { start, end: Math.floor(args.endLine) };
      }
      return { start, end: start };
    }

    if (Array.isArray(args.lineRange) && args.lineRange.length >= 2 && typeof args.lineRange[0] === 'number' && typeof args.lineRange[1] === 'number') {
      const start = Math.floor(args.lineRange[0]);
      const end = Math.floor(args.lineRange[1]);
      if (end < start) {
        throw new Error('the end line is before the start line');
      }
      return { start, end };
    }

    if (typeof args.lineRange === 'string' && args.lineRange.trim()) {
      const raw = args.lineRange.trim();
      const clean = raw.replace(/^\[|\]$/g, '').trim();
      const match = clean.match(/^(\d+)(?:[-:,]\s*(\d+))?$/);
      // A malformed range used to fall through to the whole-file path, so a typo'd range silently edited a
      // different occurrence than the caller asked for.
      if (!match) {
        throw new Error(`Invalid lineRange "${raw}"; expected "N" or "N-M" (e.g. "12" or "10-25").`);
      }
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : start;
      if (end < start) {
        throw new Error(`Invalid lineRange "${raw}"; the end line is before the start line.`);
      }
      return { start, end };
    }

    return null;
  }

  private countOccurrences(content: string, substring: string): number {
    let count = 0;
    let pos = 0;
    while ((pos = content.indexOf(substring, pos)) !== -1) {
      count++;
      pos += substring.length;
    }
    return count;
  }

  /** Every occurrence, as a 1-based line/column pair, so the caller can pick the right one. */
  private findPositions(content: string, substring: string): Array<{ line: number; column: number }> {
    const out: Array<{ line: number; column: number }> = [];
    let pos = 0;
    while ((pos = content.indexOf(substring, pos)) !== -1) {
      const before = content.slice(0, pos);
      const lines = before.split('\n');
      out.push({ line: lines.length, column: lines[lines.length - 1].length + 1 });
      pos += substring.length;
    }
    return out;
  }
}

/** Inserts `newText` verbatim: `String.replace` expands `$&`, `$$`, `` $` `` inside the replacement. */
function replaceLiterally(content: string, oldText: string, newText: string): string {
  const index = content.indexOf(oldText);
  if (index === -1) return content;
  return content.slice(0, index) + newText + content.slice(index + oldText.length);
}

function truncateForMessage(text: string): string {
  if (text.length <= MAX_ERROR_BLOCK_CHARS) return text;
  return `${text.slice(0, MAX_ERROR_BLOCK_CHARS)}\n[... ${text.length - MAX_ERROR_BLOCK_CHARS} more characters; the block is too large to show]`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
