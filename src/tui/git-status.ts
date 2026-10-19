// src/tui/git-status.ts - Cached `git status` for the footer, run by the TUI (not the agent)
import { execFile } from 'node:child_process';
import type { EventBus } from '../core/event-bus.js';
import { parseGitStatus, type GitStatus } from './layout.js';

/** Tools that may write files; a finished call refreshes the cached status. */
const WRITING_TOOLS = new Set(['write_file', 'edit', 'apply_patch', 'run_command']);

export type GitRunner = (cwd: string) => Promise<string>;

export const runGitStatus: GitRunner = (cwd) => new Promise((resolve, reject) => {
  execFile('git', ['status', '--porcelain=v2', '--branch'], { cwd, timeout: 1000, windowsHide: true }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

export class GitStatusCache {
  private cached: GitStatus | null = null;
  private inflight: Promise<GitStatus | null> | null = null;

  constructor(
    private readonly cwd: string,
    private readonly onChange: (status: GitStatus | null) => void,
    private readonly run: GitRunner = runGitStatus,
  ) {}

  public get(): GitStatus | null { return this.cached; }

  /** Runs git once at a time; failures (not a repo, timeout, no git) leave the footer without git data. */
  public refresh(): Promise<GitStatus | null> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run(this.cwd)
      .then((out) => parseGitStatus(out), () => null)
      .then((status) => {
        this.cached = status;
        this.inflight = null;
        this.onChange(status);
        return status;
      });
    return this.inflight;
  }

  /** Refresh after each tool call that may have written files. */
  public attach(bus: EventBus): () => void {
    const listener = ({ name }: { name: string }) => { if (WRITING_TOOLS.has(name)) void this.refresh(); };
    bus.on('tool_call_end', listener);
    return () => bus.off('tool_call_end', listener);
  }
}
