// src/tools/bash.ts - Deterministic execution tool for bash commands
import { spawn } from 'node:child_process';
import path from 'node:path';
import { BaseTool, type ToolExecutionContext } from './base-tool.js';
import {
  bwrapInvocation,
  execViaSandboxService,
  extraWritableFromEnv,
  fallbackPlan,
  planSandbox,
  SandboxUnavailable,
  type SandboxPlan,
} from './sandbox.js';

const MAX_OUTPUT_BYTES = 30 * 1024; // 30KB

// Commands run in their own process group so a timeout kills the whole tree (npm -> mocha -> ...), not just the
// shell; otherwise a hung test run is orphaned and spins at 100% CPU. Survivors are also killed when we exit.
const live = new Set<number>();
const killGroup = (pid: number) => {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
};
process.once('exit', () => live.forEach(killGroup));

// --- destructive-command guards ----------------------------------------------------------------------------
// A regex over shell text cannot enumerate the shell, so these guards first normalise the spellings that mean
// the same thing (quotes, `\/`, `$HOME`/`${HOME}`, `//`, `/./`, `/../`) and then *parse* the invocation
// instead of matching one shape of it. Every bypass the audit confirmed against the previous patterns is a
// test case in tests/tools-destructive.test.ts.

/** Collapses `/./`, `/../` and `//`, so `/tmp/../../` and `//` are both seen as `/`. */
function canonicalPath(token: string): string {
  if (!token.startsWith('/')) return token;
  const parts: string[] = [];
  for (const part of token.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** Quote-free, home-aliased, path-canonical text that the guards below match against. */
function normalizeCommand(command: string): string {
  return command
    .replace(/["']/g, '')
    .replace(/\\\//g, '/')
    .replace(/\$\{HOME\}|\$HOME\b/gi, '~')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(canonicalPath)
    .join(' ');
}

/** Operands of every recursive `rm` in the command. `rm -rf x`, `rm --no-preserve-root -rf x` and `rm -rf -- /` all reduce to the same list. */
function recursiveRmTargets(command: string): string[] {
  const targets: string[] = [];
  const tokens = command.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (path.basename(tokens[i]) !== 'rm') continue;
    let recursive = false;
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j];
      if (token.startsWith('-')) {
        if (/^--recursive/.test(token) || (!token.startsWith('--') && /[rR]/.test(token))) recursive = true;
        continue;
      }
      if (recursive) targets.push(token);
    }
  }
  return targets;
}

/** Device nodes everything already writes to; a write to anything else in /dev is a raw disk write. */
const SAFE_DEVICE = /^\/dev\/(?:null|zero|stdout|stderr|stdin|random|urandom|full|tty|shm\/|pts\/|fd\/)/;
const DISK_WRITERS =
  /\b(?:dd|cp|tee|install|truncate|shred|blkdiscard|wipefs|fdisk|sfdisk|parted|sgdisk|mkfs(?:\.\w+)?|mke2fs|mkdosfs|mkntfs|mkexfatfs)\b/i;

/** Raw write to a block device: `dd of=/dev/vda`, `cp /dev/zero /dev/sda`, `tee /dev/sda`, `> /dev/vda`. */
function deviceWriteReason(command: string): string | null {
  const redirected = command.match(/>>?\s*(\/dev\/\S+)/);
  if (redirected && !SAFE_DEVICE.test(redirected[1])) return `Raw write redirection to ${redirected[1]}`;
  const tokens = command.split(/\s+/).filter(Boolean);
  const last = (tokens.at(-1) ?? '').replace(/^of=/, '');
  if (last.startsWith('/dev/') && !SAFE_DEVICE.test(last)) {
    if (/\bdd\b/.test(command)) {
      // A read (`dd if=/dev/sda of=img`) is fine; only `of=` makes it a write.
      if (/\bof=/.test(command)) return `Raw write to block device ${last}`;
    } else if (DISK_WRITERS.test(command)) {
      return `Raw write to block device ${last}`;
    }
  }
  // The device can also be hidden behind a variable (`of=$dev`, `of="$dev"`); those are writes too.
  if (/\bdd\b[^|;&]*\bof=\s*\$/.test(command)) return 'Raw write to a block device via a variable';
  return null;
}

/** A command may only be read at the start of a segment (`reboot`, `&& sudo reboot`), not inside an argument. */
const COMMAND_START = '(?:^|[;&|]\\s*)(?:sudo\\s+|env\\s+|nohup\\s+|setsid\\s+)*';

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    // Any function name, not only the `:` one: `:(){ :|:& };:` and `bomb(){ bomb|bomb& }; bomb`.
    pattern: /(\S+)\s*\(\s*\)\s*\{[^}]*\|\s*\1\s*&[^}]*\}\s*;?\s*\1/,
    reason: 'Fork bomb detected',
  },
  {
    pattern: new RegExp(
      `${COMMAND_START}(?:shutdown|reboot|poweroff|halt|telinit\\s+[06]|init\\s+[06]|systemctl\\s+(?:reboot|poweroff|halt))\\b`
    ),
    reason: 'System shutdown/reboot command',
  },
  {
    pattern: new RegExp(`${COMMAND_START}kill\\s+[^|;&]*-1(?:\\s|$)`),
    reason: 'Kills every process the user owns',
  },
  { pattern: new RegExp(`${COMMAND_START}kill\\s+0(?:\\s|$)`), reason: 'Kills the process group' },
  { pattern: /\b(?:killall5|pkill\s+-9\s+-u)\b/, reason: 'Kills every process the user owns' },
];

/**
 * Removes quoted regions. `echo "rm -rf /"` prints text — the shell never runs it — so quoted text must not
 * be read as a command, while `rm -rf "/"` still has to be seen as the root path the shell will pass on.
 */
function stripQuotedRegions(command: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Command segments worth guarding, with the segments that only print removed: `echo "rm -rf /"` is output,
 * not a command, and reading it as one would refuse a plain echo.
 */
function guardSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||&|\n/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && !/^(?:echo|printf)\b/.test(segment));
}

/** Reason to refuse the command outright, or null when nothing destructive was found. Exported for tests. */
export function destructiveReason(command: string): string | null {
  // `d=$HOME; rm -rf $d` hides the target behind a variable, so a recursive rm anywhere next to a home-ish
  // assignment is treated as the home tree too.
  const whole = normalizeCommand(command);
  if (recursiveRmTargets(whole).length && /(?:^|\s)\w*=\S*(?:~|\/home\/|\/Users\/)/.test(whole)) {
    return 'Attempt to recursively delete the home directory';
  }

  for (const segment of guardSegments(command)) {
    const normalized = normalizeCommand(segment);
    for (const target of recursiveRmTargets(normalized)) {
      if (target === '/' || target.startsWith('/*')) return 'Attempt to recursively delete the root directory';
      if (target === '~' || target.startsWith('~/') || /HOME/i.test(target)) {
        return 'Attempt to recursively delete the home directory';
      }
    }
    const device = deviceWriteReason(normalized);
    if (device) return device;
  }

  // Shapes that only make sense over the whole command: a fork bomb or `init 6` split across separators.
  const patterns = stripQuotedRegions(command).replace(/\s+/g, ' ').trim();
  for (const check of DESTRUCTIVE_PATTERNS) {
    if (check.pattern.test(patterns)) return check.reason;
  }
  return null;
}

export class BashTool extends BaseTool {
  readonly name = 'bash';
  readonly description =
    'Execute shell commands deterministically with safety checks and output limits. Runs sandboxed when a backend is configured (AXIOM_SANDBOX_URL for the deep-agent sandbox service, otherwise bwrap); otherwise it runs directly.';
  readonly parameters = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds (defaults to 120000)',
      },
    },
    required: ['command'],
  };

  /**
   * Picks the execution backend: the sandbox service if configured and reachable, else OS sandbox, else local.
   * A service that is merely unreachable degrades to the next backend; a command that failed stays a failure.
   */
  private async runSandboxedService(plan: SandboxPlan, command: string, cwd: string, timeout: number): Promise<string | null> {
    if (!plan.url) return null;
    try {
      const output = await execViaSandboxService(plan.url, { command, cwd, timeoutMs: timeout });
      return this.truncateOutput(output, 'output');
    } catch (err) {
      if (!(err instanceof SandboxUnavailable)) throw err;
      return null;
    }
  }

  private truncateOutput(output: string, label: string): string {
    const byteLength = Buffer.byteLength(output, 'utf8');
    if (byteLength <= MAX_OUTPUT_BYTES) {
      return output;
    }
    const truncated = Buffer.from(output, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
    return `${truncated}\n\n[NOTE: ${label} truncated at 30KB limit (${byteLength} bytes total)]`;
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<string> {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) {
      throw new Error('Command argument must be a non-empty string');
    }

    const blocked = destructiveReason(command);
    if (blocked) {
      return `[SECURITY WARNING: Command blocked by safety policy - ${blocked}]\nCommand: ${command}`;
    }

    const timeout = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 120000;
    const cwd = context?.workspaceRoot ?? process.cwd();

    let plan = planSandbox();
    if (plan.kind === 'service') {
      const viaService = await this.runSandboxedService(plan, command, cwd, timeout);
      if (viaService !== null) return viaService;
      plan = fallbackPlan(plan);
    }

    const invocation =
      plan.kind === 'bwrap'
        ? bwrapInvocation(command, cwd, { extraWritable: extraWritableFromEnv() })
        : { file: '/bin/bash', args: ['-c', command] };

    const { promise, resolve, reject } = Promise.withResolvers<string>();

    const child = spawn(invocation.file, invocation.args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) live.add(child.pid);
    let stdoutStr = '';
    let stderrStr = '';
    // ponytail: keep the tail of each stream and show its head; 256KB is ample for the 30KB we report.
    // Upgrade to a ring buffer over the tail if a caller ever needs the last lines of a huge run.
    const MAX_BUFFER = 256 * 1024;
    child.stdout.on('data', (d) => (stdoutStr = (stdoutStr + d).slice(-MAX_BUFFER)));
    child.stderr.on('data', (d) => (stderrStr = (stderrStr + d).slice(-MAX_BUFFER)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killGroup(child.pid);
    }, timeout);

    let finished = false;
    const finish = (code: number | null, signal: string | null, spawnError?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child.pid) live.delete(child.pid);
      const parts: string[] = [];
      const out = this.truncateOutput(stdoutStr, 'stdout');
      const err = this.truncateOutput(stderrStr, 'stderr');
      if (out) parts.push(out);
      if (err) parts.push(`[stderr]\n${err}`);
      const combined = parts.join('\n').trim();

      if (!timedOut && !spawnError && code !== null) {
        // Non-zero exit (failing tests, grep with no match) is information, not a tool failure.
        resolve(code === 0 ? combined || '(Command produced no output)' : `${combined}\n\n[exit code ${code}]`.trim());
        return;
      }
      const why = timedOut ? ` (timed out after ${timeout}ms)` : spawnError ? `: ${spawnError.message}` : ` (signal ${signal})`;
      const errorMsg = `Command failed${why}`;
      reject(new Error(combined ? `${combined}\n\n${errorMsg}` : errorMsg));
    };
    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal));

    return promise;
  }
}
