// src/tools/sandbox.ts - Sandbox backends for the bash executor.
//
// Three strategies, tried in order:
//   1. service - the deep-agent/sandbox HTTP API (POST /v1/bash/exec), used when AXIOM_SANDBOX_URL is set.
//   2. bwrap   - the OS sandbox on Linux (read-only root, writable workspace), used when bwrap is installed.
//   3. local   - today's plain spawn, the fallback whenever the two above are unavailable.
//
// Selection is env-driven (see planSandbox) so nothing changes for callers that have not opted in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type SandboxKind = 'service' | 'bwrap' | 'local';

export interface SandboxPlan {
  kind: SandboxKind;
  /** Base URL of the sandbox service; only set when kind === 'service'. */
  url?: string;
  /** Why this backend was picked, for logs and `axiom doctor`. */
  detail: string;
}

/** Thrown when a sandbox backend is unreachable/misconfigured; the caller then falls back. */
export class SandboxUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailable';
  }
}

/** Package-manager caches stay writable so installs inside the sandbox do not fail on a read-only root. */
const WRITABLE_CACHE_DIRS = [
  '.npm',
  '.cache',
  '.bun',
  '.yarn',
  '.cargo',
  '.gradle',
  '.m2',
  '.deno',
  '.local/share/pnpm',
  '.local/share/uv',
];

let bwrapPath: string | null | undefined;
let bwrapUsable: boolean | undefined;

/** Resolves a binary on PATH once and caches the answer. */
export function which(bin: string): string | null {
  const dirs = (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function getBwrapPath(): string | null {
  if (bwrapPath === undefined) bwrapPath = which('bwrap');
  return bwrapPath;
}

/** Test seam: forget the cached bwrap lookups. */
export function resetSandboxCache(): void {
  bwrapPath = undefined;
  bwrapUsable = undefined;
}

/**
 * bwrap can be installed but unusable (unprivileged user namespaces disabled in the kernel).
 * One cached probe decides it, so a broken bwrap never becomes every command's failure.
 */
export function isBwrapUsable(): boolean {
  if (bwrapUsable !== undefined) return bwrapUsable;
  const bwrap = getBwrapPath();
  if (!bwrap) {
    bwrapUsable = false;
    return false;
  }
  try {
    const probe = spawnSync(bwrap, ['--ro-bind', '/', '/', '--', '/bin/true'], { timeout: 5_000 });
    bwrapUsable = probe.status === 0;
  } catch {
    bwrapUsable = false;
  }
  return bwrapUsable;
}

/**
 * Decides which backend the bash tool should use.
 *
 * `AXIOM_SANDBOX` (default `auto`):
 *   - `auto`    service if `AXIOM_SANDBOX_URL` is set, else bwrap if installed, else local
 *   - `service` the sandbox service (needs `AXIOM_SANDBOX_URL`)
 *   - `bwrap`   the OS sandbox (needs bwrap)
 *   - `off`     no sandboxing; run commands directly
 */
export function planSandbox(env: NodeJS.ProcessEnv = process.env): SandboxPlan {
  const mode = (env.AXIOM_SANDBOX ?? 'auto').trim().toLowerCase();
  const url = env.AXIOM_SANDBOX_URL?.trim().replace(/\/+$/, '');

  if (mode === 'off' || mode === 'none' || mode === '0' || mode === 'false') {
    return { kind: 'local', detail: 'AXIOM_SANDBOX=off' };
  }

  if (mode === 'service') {
    return url
      ? { kind: 'service', url, detail: `AXIOM_SANDBOX=service (${url})` }
      : { kind: 'local', detail: 'AXIOM_SANDBOX=service but AXIOM_SANDBOX_URL is unset' };
  }

  if (mode === 'bwrap') {
    return bwrapPlan('AXIOM_SANDBOX=bwrap') ??
      { kind: 'local', detail: 'AXIOM_SANDBOX=bwrap but bwrap is unavailable or unusable' };
  }

  if (mode !== 'auto') {
    return { kind: 'local', detail: `Unknown AXIOM_SANDBOX="${mode}"; expected auto|service|bwrap|off` };
  }

  if (url) return { kind: 'service', url, detail: `auto: AXIOM_SANDBOX_URL=${url}` };
  return bwrapPlan('auto') ?? { kind: 'local', detail: 'auto: no sandbox backend available' };
}

function bwrapPlan(prefix: string): SandboxPlan | null {
  if (!isBwrapUsable()) return null;
  return { kind: 'bwrap', detail: `${prefix}: ${getBwrapPath()}` };
}

/** Given a plan that turned out to be unusable, the next backend to try. */
export function fallbackPlan(plan: SandboxPlan, env: NodeJS.ProcessEnv = process.env): SandboxPlan {
  if (plan.kind === 'service') {
    // Re-plan with the service out of the picture: `auto` moves to bwrap, forced `service` drops to local.
    return planSandbox({ ...env, AXIOM_SANDBOX_URL: '' });
  }
  return { kind: 'local', detail: 'local fallback' };
}

export interface SandboxExecRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Runs a command through the deep-agent/sandbox service.
 * Shape verified against the service's Go model: POST /v1/bash/exec {command,cwd,timeout_ms} -> {output,exit_code,error}.
 */
export async function execViaSandboxService(url: string, req: SandboxExecRequest): Promise<string> {
  const endpoint = `${url}/v1/bash/exec`;
  const timeoutSignal = AbortSignal.timeout(req.timeoutMs + 5_000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: req.command, cwd: req.cwd, timeout_ms: req.timeoutMs }),
      signal,
    });
  } catch (err) {
    throw new SandboxUnavailable(`sandbox service unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.status === 404 || res.status === 502 || res.status === 503 || res.status === 504) {
    throw new SandboxUnavailable(`sandbox service returned HTTP ${res.status} for ${endpoint}`);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`sandbox service HTTP ${res.status}: ${raw.slice(0, 500)}`);
  }

  let parsed: { output?: unknown; exit_code?: unknown; error?: unknown; output_file?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SandboxUnavailable(`sandbox service returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const output = typeof parsed.output === 'string' ? parsed.output : '';
  const exitCode = typeof parsed.exit_code === 'number' ? parsed.exit_code : null;
  const serviceError = typeof parsed.error === 'string' ? parsed.error : '';
  const outputFile = typeof parsed.output_file === 'string' ? parsed.output_file : '';

  if (!output && serviceError) {
    throw new Error(serviceError);
  }

  const parts: string[] = [];
  if (output) parts.push(output);
  if (outputFile) parts.push(`[output file: ${outputFile}]`);
  if (exitCode !== null && exitCode !== 0) parts.push(`[exit code ${exitCode}]`);
  return parts.join('\n').trim() || '(Command produced no output)';
}

/**
 * Builds the bwrap argv for a command.
 *
 * Default (what `run_command` uses): the root is mounted read-only and only the workspace (plus package
 * caches) is writable, so a stray `rm -rf` cannot reach the user's home or system files. The network
 * namespace is shared, because installs need it.
 *
 * `isolateNetwork` adds `--unshare-net`: the command gets a network namespace with no interfaces at all.
 *
 * `readableRoots` replaces the read-only bind of `/` with `/usr` (+ the `/bin`, `/lib*`, `/sbin` links or
 * dirs), fresh `/tmp` and `/home`, and a read-only bind of each given root. Host files outside those roots,
 * `~/.ssh` and `~/.axiom` included, do not exist inside, and only `cwd` + `extraWritable` are writable
 * (package caches are not bound). `run_tests` uses both, because test code is untrusted.
 */
export function bwrapInvocation(
  command: string,
  cwd: string,
  opts: { bwrap?: string; home?: string; extraWritable?: string[]; isolateNetwork?: boolean; readableRoots?: string[] } = {}
): { file: string; args: string[] } {
  const bwrap = opts.bwrap ?? getBwrapPath() ?? 'bwrap';
  const home = opts.home ?? os.homedir();
  const args: string[] = [];
  const writable = [cwd];

  if (opts.readableRoots) {
    args.push('--ro-bind', '/usr', '/usr');
    for (const top of ['/bin', '/sbin', '/lib', '/lib32', '/lib64']) {
      const link = readLink(top);
      if (link !== null) args.push('--symlink', link, top);
      else if (isDirectory(top)) args.push('--ro-bind', top, top);
    }
    args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/home');
    for (const root of uniqueExisting(opts.readableRoots.filter((r) => path.isAbsolute(r) && r !== '/'), '')) {
      args.push('--ro-bind', root, root);
    }
  } else {
    args.push('--ro-bind', '/', '/', '--dev', '/dev', '--tmpfs', '/dev/shm', '--proc', '/proc', '--tmpfs', '/tmp');
    for (const rel of WRITABLE_CACHE_DIRS) writable.push(path.join(home, rel));
  }

  // Mounted after the read-only binds, so these override them.
  if (opts.extraWritable) writable.push(...opts.extraWritable);
  for (const dir of uniqueExisting(writable, cwd)) {
    args.push('--bind', dir, dir);
  }

  args.push('--chdir', cwd, '--unshare-pid');
  if (opts.isolateNetwork) args.push('--unshare-net');
  args.push('--die-with-parent', '--', '/bin/bash', '-c', command);
  return { file: bwrap, args };
}

/** Target of a symlink such as `/bin -> usr/bin` (merged-/usr systems), or null when it is not a link. */
function readLink(p: string): string | null {
  try {
    return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : null;
  } catch {
    return null;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Extra writable roots, e.g. AXIOM_SANDBOX_RW=/srv/data:/opt/tools. */
export function extraWritableFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.AXIOM_SANDBOX_RW?.trim();
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter((p) => p.startsWith('/'));
}

function uniqueExisting(dirs: string[], cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    // The workspace is bound even if the path check races, since bwrap fails hard on a missing dir.
    const isCwd = dir === cwd;
    if (!isCwd) {
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}
