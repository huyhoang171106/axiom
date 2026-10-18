// src/tools/list-dir.ts - list_dir: directory tree of the workspace, depth- and entry-limited
import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseTool, type ToolExecutionContext } from './base-tool.js';
import { isSecretPath } from './permissions.js';

const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 5;
const MAX_ENTRIES = 500;
/** Generated trees: listing them spends context on files the agent never needs to read. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache']);

export class ListDirTool extends BaseTool {
  readonly name = 'list_dir';
  readonly isReadOnly = true;
  readonly description =
    `List a directory tree as workspace-relative paths (directories end with "/"). ` +
    `Skips ${[...SKIPPED_DIRS].join(', ')} and secret files; stops after ${MAX_ENTRIES} entries.`;
  readonly parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list (default ".", the workspace root)' },
      depth: { type: 'number', description: `Levels to descend (default ${DEFAULT_DEPTH}, max ${MAX_DEPTH})` },
    },
  };

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
    const depth = typeof args.depth === 'number' && args.depth >= 1 ? Math.min(Math.floor(args.depth), MAX_DEPTH) : DEFAULT_DEPTH;
    const base = context?.workspaceRoot ?? process.cwd();
    const root = this.resolvePath(rawPath, context);

    const stat = await fs.stat(root).catch((err: NodeJS.ErrnoException) => {
      throw new Error(err.code === 'ENOENT' ? `Directory not found: ${rawPath}` : `Cannot access ${rawPath}: ${err.message}`);
    });
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${rawPath} (use read_file for files)`);

    const lines: string[] = [];
    let truncated = false;
    const walk = async (dir: string, level: number): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        // Symlinks are listed but never followed, so a link cannot lead the walk out of the workspace or loop.
        const isDir = entry.isDirectory();
        if (isDir && SKIPPED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const shown = path.relative(base, full).split(path.sep).join('/');
        if (isSecretPath(shown)) continue;
        if (lines.length >= MAX_ENTRIES) {
          truncated = true;
          return;
        }
        lines.push(isDir ? `${shown}/` : shown);
        if (isDir && level < depth) await walk(full, level + 1);
        if (truncated) return;
      }
    };
    await walk(root, 1);

    const header = `Directory: ${rawPath} (depth ${depth})`;
    if (lines.length === 0) return `${header}\n(empty)`;
    const footer = truncated ? [`... stopped at ${MAX_ENTRIES} entries; list a subdirectory or lower the depth`] : [];
    return [header, ...lines, ...footer].join('\n');
  }
}
