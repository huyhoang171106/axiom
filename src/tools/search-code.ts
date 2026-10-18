// src/tools/search-code.ts - search_code: ripgrep over the workspace with a capped, line-truncated result list
import { spawn } from 'node:child_process';
import path from 'node:path';
import { BaseTool, type ToolExecutionContext } from './base-tool.js';
import { isSecretPath } from './permissions.js';

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 200;
const MAX_LINE_CHARS = 300;
const TIMEOUT_MS = 10_000;

/** A readable `match` line of `rg --json`; non-UTF-8 paths or lines come back as base64 `bytes` and fail this check. */
function readMatch(value: unknown): { file: string; line: number; text: string } | null {
  if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'match' || !('data' in value)) return null;
  const data = value.data as { path?: { text?: unknown }; lines?: { text?: unknown }; line_number?: unknown } | null;
  const file = data?.path?.text;
  const text = data?.lines?.text;
  const line = data?.line_number;
  return typeof file === 'string' && typeof text === 'string' && typeof line === 'number' ? { file, line, text } : null;
}

export class SearchCodeTool extends BaseTool {
  readonly name = 'search_code';
  readonly isReadOnly = true;
  readonly description =
    'Search file contents with ripgrep. Returns "path:line: text" for each matching line, ' +
    `at most maxResults (default ${DEFAULT_MAX_RESULTS}). Skips hidden, git-ignored, binary and secret files.`;
  readonly parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex in ripgrep (Rust) syntax; escape special characters to match them literally' },
      path: { type: 'string', description: 'File or directory to search (default ".", the workspace root)' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.py" or "tests/**"' },
      maxResults: { type: 'number', description: `Maximum matching lines to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS})` },
    },
    required: ['pattern'],
  };

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    if (!pattern) throw new Error('pattern must be a non-empty string');
    const searchPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
    const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : undefined;
    const maxResults =
      typeof args.maxResults === 'number' && args.maxResults >= 1 ? Math.min(Math.floor(args.maxResults), MAX_RESULTS) : DEFAULT_MAX_RESULTS;
    const cwd = context?.workspaceRoot ?? process.cwd();

    // `--opt=value` and `--` keep a model-supplied value from being parsed as another rg option (`--pre` runs a program).
    const argv = ['--json', ...(glob ? [`--glob=${glob}`] : []), `--regexp=${pattern}`, '--', searchPath];
    const { results, truncated, timedOut } = await runRipgrep(argv, cwd, maxResults);

    const notes = [
      ...(truncated ? [`... more matches not shown (limit ${maxResults}); narrow the pattern, path or glob`] : []),
      ...(timedOut ? [`... search stopped after ${TIMEOUT_MS / 1000}s; results may be incomplete`] : []),
    ];
    if (results.length === 0) return [`No matches for /${pattern}/ in ${searchPath}`, ...notes].join('\n');
    return [...results, ...notes].join('\n');
  }
}

function runRipgrep(argv: string[], cwd: string, maxResults: number): Promise<{ results: string[]; truncated: boolean; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const results: string[] = [];
    let truncated = false;
    let timedOut = false;
    let stopped = false;
    let pending = '';
    let stderr = '';
    const stop = () => {
      stopped = true;
      child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, TIMEOUT_MS);

    const take = (line: string) => {
      if (stopped || !line.startsWith('{"type":"match"')) return;
      let match: ReturnType<typeof readMatch>;
      try {
        match = readMatch(JSON.parse(line));
      } catch {
        // A throw inside this stream callback would crash the whole agent; one unreadable line is just skipped.
        return;
      }
      if (!match) return;
      const file = path.relative(cwd, path.resolve(cwd, match.file)).split(path.sep).join('/');
      // A glob overrides rg's hidden-file rule (`--glob=.env` searches .env), so secrets are filtered here.
      if (isSecretPath(file)) return;
      if (results.length === maxResults) {
        truncated = true;
        stop();
        return;
      }
      const text = match.text.replace(/\r?\n$/, '');
      const shown = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}... (${text.length} chars)` : text;
      results.push(`${file}:${match.line}: ${shown}`);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(take);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new Error('ripgrep (rg) is not installed; see https://github.com/BurntSushi/ripgrep#installation')
          : err
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!stopped) take(pending);
      // rg exits 1 for "no match"; 2 means an error (bad regex, missing path), unless some files still matched.
      if (!stopped && code === 2 && results.length === 0) {
        reject(new Error(`rg failed: ${stderr.trim().slice(0, 500) || 'exit code 2'}`));
        return;
      }
      resolve({ results, truncated, timedOut });
    });
  });
}
