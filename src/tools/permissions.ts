// src/tools/permissions.ts - Policy engine: decides allow / ask / deny for every tool call, in code, before it runs
import fs from 'node:fs';
import path from 'node:path';

export type Verdict = 'allow' | 'ask' | 'deny';
export interface PolicyDecision {
  verdict: Verdict;
  reason: string;
}

export interface ApprovalRequest {
  name: string;
  args: Record<string, unknown>;
  reason: string;
}
/** A human answer to an `ask`: run as proposed, refuse, or run with arguments the human edited. */
export type ApprovalDecision = 'approve' | 'deny' | { editedArgs: Record<string, unknown> };
export type Approver = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/**
 * Commands that only read state, as the argv shape that stays read-only.
 *
 * A bare command name is not enough: several of these binaries write files or execute helpers when handed
 * the right option (`sort -o`, `rg --pre`, `git branch -D`, `find -fprintf`, `env <cmd>`), and the audit
 * escaped the old name-only allowlist exactly that way. Each entry therefore anchors the command and may
 * carry a `deny` pattern for the options that turn it into a writer or an executor.
 */
const READ_ONLY_COMMANDS: Array<{ match: RegExp; deny?: RegExp }> = [
  { match: /^ls(\s|$)/ },
  { match: /^cat(\s|$)/ },
  { match: /^head(\s|$)/ },
  { match: /^tail(\s|$)/ },
  { match: /^wc(\s|$)/ },
  { match: /^pwd$/ },
  { match: /^which(\s|$)/ },
  { match: /^whoami$/ },
  { match: /^id$/ },
  { match: /^date(\s|$)/ },
  { match: /^echo(\s|$)/ },
  // `env` with no operand only lists variables; `env <cmd>` executes its argument.
  { match: /^env$/ },
  { match: /^printenv(\s|$)/ },
  { match: /^df(\s|$)/ },
  { match: /^du(\s|$)/ },
  { match: /^ps(\s|$)/ },
  { match: /^stat(\s|$)/ },
  { match: /^file(\s|$)/ },
  { match: /^tree(\s|$)/ },
  { match: /^sort(\s|$)/, deny: /(^|\s)(?:-o|--output)(\s|=|$)/ },
  { match: /^uniq(\s|$)/ },
  { match: /^diff(\s|$)/ },
  { match: /^grep(\s|$)/ },
  { match: /^rg(\s|$)/, deny: /(^|\s)--(?:pre|pre-glob|hostname-bin|engine|pager|-files)(\s|=|$)/ },
  {
    match: /^find(\s|$)/,
    deny: /(^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)(\s|$)/,
  },
  {
    match: /^git\s+(?:status|diff|log|show|rev-parse|ls-files|blame|describe|shortlog|show-ref|symbolic-ref|remote\s+-v)(\s|$)/,
    // `git log --output=<file>` writes a file.
    deny: /(^|\s)--output(=|\s)/,
  },
  {
    match: /^git\s+branch(\s|$)/,
    // Only the listing forms; -d/-D/-m/-M/-c/-C and their long forms mutate refs.
    deny: /(^|\s)(?:-[dDmMcC]|--(?:delete|move|copy|edit-description))(\s|$)/,
  },
  { match: /^node\s+(?:-v|--version|--test)(\s|$)/ },
  { match: /^npm\s+(?:test|ls|run\s+(?:test|lint|build|typecheck))(\s|$)/ },
  { match: /^npx\s+(?:tsc|vitest|jest|eslint|mocha|tape|ava|tap|nyc)(\s|$)/ },
  { match: /^npx\s+prettier\s+--check(\s|$)/ },
  { match: /^(?:mocha|jest|vitest|tape|ava|tap)(\s|$)/ },
  { match: /^(?:yarn|pnpm|bun)\s+(?:test|run\s+(?:test|lint|build|typecheck))(\s|$)/ },
  { match: /^deno\s+test(\s|$)/ },
  { match: /^pytest(\s|$)/ },
  { match: /^python3?\s+-m\s+(?:pytest|unittest)(\s|$)/ },
  { match: /^cargo\s+(?:test|check|build|vet)(\s|$)/ },
  { match: /^go\s+(?:test|build|vet)(\s|$)/ },
  { match: /^make\s+(?:test|check)(\s|$)/ },
];

/**
 * Removes quoted regions so a metacharacter inside a literal string (`echo "a > b"`) is not mistaken for
 * shell syntax, and keeps escaped characters as escapes (`\/` is not a redirect). Everything the checks
 * below look at is the *unquoted* text, which is what the shell actually acts on.
 */
function withoutQuotedText(command: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      if (i + 1 < command.length) out += command[++i];
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
 * Every construct that can hide another command or write a file: `>`, `>>`, `<`, `<(...)`, `>(...)`,
 * `$(...)`, backticks and the separators `;`, `&`, `&&`, `||`, `|`. A redirect with an explicit file
 * descriptor (`1>`, `2>`) is included — that spelling is what slipped past the old guard.
 */
const SHELL_SYNTAX = /[<>]|\$\(|`|\n/;

/** Separators that start a new command, including a single `&` (background). */
const SEGMENT_SPLIT = /&&|\|\||;|\||&|\n|\r|\(|\)|\{|\}/;

const escapesWorkspaceCache = new Map<string, string>();

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
}

/** Resolves symlinks for the deepest existing ancestor, so a not-yet-created file is still checked. */
function realTarget(target: string): string {
  let current = target;
  const tail: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  const real = realpathOrSelf(current);
  return tail.length ? path.join(real, ...tail) : real;
}

/**
 * True when `target` (relative to the workspace or absolute) lands outside the workspace **after**
 * symlinks are resolved. The old check was purely lexical, so a symlink planted in the repo
 * (`link -> /tmp/outside`) let a write escape without the prompt this path exists to raise.
 */
export function escapesWorkspace(target: string, workspaceRoot: string): boolean {
  const root = realpathOrSelf(path.resolve(workspaceRoot));
  const cacheKey = `${root}\0${target}`;
  const cached = escapesWorkspaceCache.get(cacheKey);
  if (cached !== undefined) return cached === 'yes';
  const real = realTarget(path.resolve(workspaceRoot, target));
  const rel = path.relative(root, real);
  const escaped = rel.startsWith('..') || path.isAbsolute(rel);
  if (escapesWorkspaceCache.size > 500) escapesWorkspaceCache.clear();
  escapesWorkspaceCache.set(cacheKey, escaped ? 'yes' : 'no');
  return escaped;
}

/**
 * Null when the command is a plain sequence of read-only commands, otherwise the reason to ask the user.
 * Splits on every separator (a single `&` included), rejects substitution/redirection outright, and checks
 * each segment against the argv shapes above.
 */
export function bashNeedsApproval(command: string): string | null {
  const visible = withoutQuotedText(command);
  // `2>&1` / `>&2` duplicate a descriptor the process already has; nothing is written, so they are not the
  // redirect this gate is about (an fd-numbered write like `1>/etc/...` still is).
  const significant = visible.replace(/\d*[<>]&\s*\d+/g, '');
  if (SHELL_SYNTAX.test(significant)) return 'shell has substitution or redirection';
  for (const raw of significant.split(SEGMENT_SPLIT)) {
    const segment = raw.trim();
    if (!segment) continue;
    const rule = READ_ONLY_COMMANDS.find((candidate) => candidate.match.test(segment));
    if (!rule || (rule.deny && rule.deny.test(segment))) {
      return `"${segment.slice(0, 60)}" is not a known read-only command`;
    }
  }
  return null;
}

/**
 * Hosts that are not reachable on the public internet: loopback, link-local (incl. the cloud metadata
 * address), private ranges and the usual internal suffixes. These are the interesting SSRF targets, so
 * they are the ones that ask first.
 */
export function isNonPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, includes 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast / reserved
    );
  }
  // IPv6: loopback, unspecified, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  return false;
}

/** Path argument of every tool that reads or writes a path, with the word used in the prompt. */
const PATH_TOOLS: Record<string, string> = {
  read_file: 'reads',
  list_dir: 'lists',
  search_code: 'searches',
  search: 'searches',
  glob: 'globs',
  find: 'searches',
  write_file: 'writes',
  edit: 'edits',
};

function needsApproval(name: string, args: Record<string, unknown>, workspaceRoot: string): string | null {
  if (name === 'run_command') return bashNeedsApproval(typeof args.command === 'string' ? args.command : '');

  const verb = PATH_TOOLS[name];
  if (verb) {
    const raw = typeof args.path === 'string' ? args.path.trim() : '';
    if (raw && escapesWorkspace(raw, workspaceRoot)) {
      return `${verb} outside the workspace (${path.resolve(workspaceRoot, raw)})`;
    }
    return null;
  }

  if (name === 'web_fetch') {
    const raw = typeof args.url === 'string' ? args.url : '';
    try {
      const host = new URL(raw).hostname;
      return isNonPublicHost(host) ? `fetches a non-public host (${host})` : null;
    } catch {
      // The tool rejects malformed URLs itself; no need to prompt about them.
      return null;
    }
  }

  if (name.startsWith('mcp__')) return 'external MCP tool';

  // Persistence tools write text that is injected into every later session's prompt, so a prompt-injected
  // call would be a durable foothold. Ask before storing it.
  if (name === 'remember' || name === 'skill_write') return 'persists instructions into future prompts';

  return null;
}

/**
 * Secret files the agent may never touch (topic §4.1 / UC-05): `.env` and its variants (`.env.example` is a
 * template and stays readable), `*.pem`, anything under `.ssh`, and `.git/config` (may hold credentials).
 */
export function isSecretPath(p: string): boolean {
  const n = p.trim().replace(/\\/g, '/').replace(/^['"]|['"]$/g, '');
  return (
    /(^|\/)\.env(\.(?!example$)[^/]*)?$/.test(n) ||
    /\.pem$/i.test(n) ||
    /(^|\/|^~)\.ssh(\/|$)/.test(n) ||
    /(^|\/)\.git\/config$/.test(n)
  );
}

const PUSH_TO_MAIN = /\bgit\s+push\b[^;&|\n]*\b(?:main|master)\b/;

/** Hard denials first (never asked, never run), then the approval rules of `needsApproval`. */
export function decide(name: string, args: Record<string, unknown>, workspaceRoot: string): PolicyDecision {
  if (name === 'run_command') {
    const command = typeof args.command === 'string' ? args.command : '';
    // Token scan over the raw text, quotes included: `cat ".env"` must not slip through.
    const secret = command.split(/[\s;&|<>()`$=]+/).find((t) => t && isSecretPath(t));
    if (secret) return { verdict: 'deny', reason: `touches a secret file (${secret})` };
    if (PUSH_TO_MAIN.test(command)) return { verdict: 'deny', reason: 'pushes to the main branch' };
  }
  if (PATH_TOOLS[name]) {
    const raw = typeof args.path === 'string' ? args.path.trim() : '';
    if (raw && isSecretPath(raw)) return { verdict: 'deny', reason: `secret file (${raw})` };
    if (raw && escapesWorkspace(raw, workspaceRoot)) {
      return { verdict: 'deny', reason: `outside the workspace (${path.resolve(workspaceRoot, raw)})` };
    }
  }
  const reason = needsApproval(name, args, workspaceRoot);
  return reason ? { verdict: 'ask', reason } : { verdict: 'allow', reason: 'allowed by policy' };
}
