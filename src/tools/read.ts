// src/tools/read.ts - Deterministic read tool for files and directories
//
// File output follows the `cat -n` convention from minimal-agent-tools: a right-aligned line number,
// a TAB, then the line. The tab is load-bearing — models recover line numbers from it far more
// reliably than from a "12: text" prefix, which matters because the next call is usually `edit`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseTool, type ToolExecutionContext } from './base-tool.js';
import { splitLines } from './text-lines.js';

const DEFAULT_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const BINARY_SNIFF_BYTES = 8192;
/** Byte cap on one read's output, in line with the other tools (bash and web_fetch cap at 30 KB of text). */
const MAX_OUTPUT_CHARS = 200 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

interface TextSlice {
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: string[];
  truncated: boolean;
}

export class ReadTool extends BaseTool {
  readonly name = 'read';
  readonly isReadOnly = true;
  readonly description =
    'Read file contents with line numbers (cat -n style: number, tab, text) or list directory entries with types and sizes';
  readonly parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File or directory path to read',
      },
      offset: {
        type: 'number',
        description: `Starting line number (1-based) to read (default 1)`,
      },
      limit: {
        type: 'number',
        description: `Maximum number of lines or directory entries to read (default ${DEFAULT_LIMIT}` +
          ` for files, all entries for directories)`,
      },
      lineRange: {
        type: 'string',
        description: 'Line range string in format "start-end" (e.g. "10-50")',
      },
    },
    required: ['path'],
  };

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<string> {
    const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!rawPath) {
      throw new Error('Path argument must be a non-empty string');
    }

    const targetPath = this.resolvePath(rawPath, context);

    let stat;
    try {
      stat = await fs.stat(targetPath);
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
      if (code === 'ENOENT') {
        throw new Error(`File or directory not found: ${rawPath}`);
      }
      throw new Error(`Failed to access ${rawPath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (stat.isDirectory()) {
      return this.readDirectory(targetPath, rawPath, args);
    }

    return this.readFile(targetPath, rawPath, stat.size, args);
  }

  private async readDirectory(
    fullPath: string,
    displayPath: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) - 1 : 0;
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : entries.length;

    const sliced = entries.slice(offset, offset + limit);
    const lines: string[] = [
      `Directory: ${displayPath} (${entries.length} items total):`,
    ];

    // Stats were awaited one entry at a time; batches keep the order and bound the open descriptors.
    const describe = async (entry: (typeof sliced)[number]): Promise<string> => {
      if (entry.isDirectory()) return `  [DIR]  ${entry.name}/`;
      if (entry.isSymbolicLink()) return `  [LINK] ${entry.name}`;
      try {
        const s = await fs.stat(path.join(fullPath, entry.name));
        return `  [FILE] ${entry.name} (${s.size} bytes)`;
      } catch {
        return `  [FILE] ${entry.name}`;
      }
    };
    for (let i = 0; i < sliced.length; i += 64) {
      lines.push(...(await Promise.all(sliced.slice(i, i + 64).map(describe))));
    }

    if (offset + limit < entries.length) {
      lines.push(`  ... (${entries.length - (offset + limit)} more entries)`);
    }

    return lines.join('\n');
  }

  private async readFile(
    fullPath: string,
    displayPath: string,
    size: number,
    args: Record<string, unknown>
  ): Promise<string> {
    const ext = path.extname(fullPath).toLowerCase();

    // Non-text payloads would spend context on bytes the model cannot use, so they are described.
    const imageMime = IMAGE_MIME[ext];
    if (imageMime) {
      return `[Image: ${displayPath}, ${formatBytes(size)}, ${imageMime}]`;
    }
    if (ext === '.pdf') {
      return `[PDF: ${displayPath}, ${formatBytes(size)}] (binary document; text extraction needs an external tool)`;
    }

    const buffer = await fs.readFile(fullPath);
    if (ext === '.ipynb') {
      return this.formatNotebook(buffer.toString('utf8'), displayPath);
    }
    if (looksBinary(buffer)) {
      return `[Binary file: ${displayPath}, ${formatBytes(size)}] (not shown; use bash if you need to inspect the bytes)`;
    }

    const decoded = buffer.toString('utf8');
    const slice = sliceLinesWithDefaultLimit(decoded, args);
    const out: string[] = [];
    // Nothing to gain from pretending: the invalid bytes are already U+FFFD here, so say so rather than let
    // the model read mojibake as if it were the file's content.
    if (!Buffer.from(decoded, 'utf8').equals(buffer)) {
      out.push(`[Note: ${displayPath} is not valid UTF-8; invalid bytes are shown as \uFFFD]`);
    }
    out.push(`File: ${displayPath} (lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines}):`);
    for (const { lineNumber, text } of describeSlice(slice)) {
      out.push(`${String(lineNumber).padStart(6, ' ')}\t${text}`);
    }
    if (slice.truncated) {
      out.push(`[${slice.totalLines - slice.endLine} more lines; re-read with offset=${slice.endLine + 1}]`);
    }
    // The read tool had no byte cap while every other tool has one; a single call could hand millions of
    // characters to the context estimator (budget.ts) and to the model.
    const joined = out.join('\n');
    if (joined.length > MAX_OUTPUT_CHARS) {
      return `${joined.slice(0, MAX_OUTPUT_CHARS)}\n[truncated at ${MAX_OUTPUT_CHARS} characters; re-read a narrower window with offset/limit]`;
    }
    return joined;
  }

  private formatNotebook(raw: string, displayPath: string): string {
    let notebook: { cells?: Array<Record<string, unknown>> };
    try {
      notebook = JSON.parse(raw);
    } catch {
      throw new Error(`Not a valid Jupyter notebook: ${displayPath}`);
    }
    const cells = Array.isArray(notebook.cells) ? notebook.cells : [];
    const out: string[] = [`Notebook: ${displayPath} (${cells.length} cells):`];
    cells.forEach((cell, idx) => {
      const kind = typeof cell.cell_type === 'string' ? cell.cell_type : 'unknown';
      out.push(`--- Cell ${idx + 1} [${kind}] ---`);
      out.push(joinSource(cell.source));
      const outputs = Array.isArray(cell.outputs) ? (cell.outputs as Array<Record<string, unknown>>) : [];
      if (outputs.length) {
        out.push('[Output]:');
        for (const o of outputs) {
          const rendered = renderNotebookOutput(o);
          if (rendered) out.push(rendered);
        }
      }
    });
    return out.join('\n');
  }
}

function joinSource(source: unknown): string {
  if (Array.isArray(source)) return source.join('');
  return typeof source === 'string' ? source : '';
}

function renderNotebookOutput(output: Record<string, unknown>): string {
  if (typeof output.text === 'string' || Array.isArray(output.text)) return joinSource(output.text);
  const data = output.data as Record<string, unknown> | undefined;
  if (data) {
    if (data['text/plain'] !== undefined) return joinSource(data['text/plain']);
    return `[${Object.keys(data).join(', ')}]`;
  }
  return '';
}

/** Resolves the requested window and clamps it to the file. */
export function sliceLines(content: string, args: Record<string, unknown>): TextSlice {
  const allLines = splitLines(content);
  const totalLines = allLines.length;

  let startLine = 1;
  let endLine = totalLines;

  if (typeof args.lineRange === 'string' && args.lineRange.trim()) {
    const raw = args.lineRange.trim();
    const match = raw.match(/^(\d+)(?:-(\d+))?$/);
    // A typo like "1:5" used to fall through to the whole file, so the caller never learned the range was
    // ignored; a reversed range silently returned one line.
    if (!match) {
      throw new Error(`Invalid lineRange "${raw}"; expected "N" or "N-M" (e.g. "12" or "10-25").`);
    }
    startLine = parseInt(match[1], 10);
    endLine = match[2] ? parseInt(match[2], 10) : startLine;
    if (endLine < startLine) {
      throw new Error(`Invalid lineRange "${raw}"; the end line is before the start line.`);
    }
  } else {
    if (typeof args.offset === 'number' && args.offset > 0) {
      startLine = Math.floor(args.offset);
    }
    if (typeof args.limit === 'number' && args.limit > 0) {
      endLine = startLine + Math.floor(args.limit) - 1;
    }
  }

  startLine = Math.max(1, Math.min(startLine, totalLines));
  endLine = Math.max(startLine, Math.min(endLine, totalLines));

  return {
    startLine,
    endLine,
    totalLines,
    lines: allLines.slice(startLine - 1, endLine),
    truncated: endLine < totalLines,
  };
}

/** Defaults the window to the first DEFAULT_LIMIT lines so a huge file cannot swallow the context. */
function sliceLinesWithDefaultLimit(content: string, args: Record<string, unknown>): TextSlice {
  const hasWindow = typeof args.lineRange === 'string' && args.lineRange.trim().length > 0;
  const hasOffset = typeof args.offset === 'number' && args.offset > 0;
  const hasLimit = typeof args.limit === 'number' && args.limit > 0;
  if (hasWindow || hasOffset || hasLimit) return sliceLines(content, args);
  return sliceLines(content, { limit: DEFAULT_LIMIT });
}

function describeSlice(slice: TextSlice): Array<{ lineNumber: number; text: string }> {
  return slice.lines.map((line, idx) => {
    const text =
      line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...[truncated]` : line;
    return { lineNumber: slice.startLine + idx, text };
  });
}

/** A NUL byte in the head of a file is the usual signal that it is not text. */
function looksBinary(buffer: Buffer): boolean {
  const head = buffer.subarray(0, BINARY_SNIFF_BYTES);
  return head.includes(0);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
