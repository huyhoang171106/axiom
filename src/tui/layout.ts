// src/tui/layout.ts - Display-column layout shared by terminal components
import stringWidth from 'string-width';
import sliceAnsi from 'slice-ansi';

export interface Segment { text: string; priority: number; compact?: string }

export function visibleWidth(s: string): number { return stringWidth(s); }

export function truncate(s: string, width: number): string {
  const columns = Math.max(0, Math.floor(width));
  if (!columns) return '';
  if (visibleWidth(s) <= columns) return s;
  return sliceAnsi(s, 0, columns - 1) + '…';
}

export function fitFooterLine(left: Segment[], right: string, width: number): string {
  const available = Math.max(0, Math.floor(width) - visibleWidth(right) - (right ? 1 : 0));
  const parts = left.map((segment) => ({ ...segment }));
  const join = () => parts.map((part) => part.text).filter(Boolean).join(' ');
  for (const part of [...parts].sort((a, b) => a.priority - b.priority)) {
    if (visibleWidth(join()) <= available) break;
    if (part.compact !== undefined) part.text = part.compact;
    if (visibleWidth(join()) > available) part.text = '';
  }
  const text = truncate(join(), available);
  // When the terminal is narrower than right itself, preserving right takes precedence.
  return text + ' '.repeat(Math.max(0, Math.floor(width) - visibleWidth(text) - visibleWidth(right))) + right;
}

// ---- Telemetry and footer values (E5). Missing data renders as '—', never 0. ----

export const MISSING = '—';
/** Context usage at or above this ratio is shown as a warning (UC-04 compaction threshold). */
export const CONTEXT_WARN_RATIO = 0.6;

/** Timestamps (ms) collected for one agent turn. */
export interface TurnTiming {
  sentAt: number;
  firstTokenAt?: number;
  endAt?: number;
  /** Total time spent running tools after the first token; excluded from generation time. */
  toolMs: number;
}

export interface TurnTelemetry {
  ttftMs: number | null;
  tps: number | null;
  durationMs: number | null;
}

/**
 * TTFT = first stream_token − sent. TPS = output tokens ÷ text generation time
 * (first token → end, minus time spent in tools).
 */
export function computeTelemetry(timing: TurnTiming, completionTokens: number | null | undefined): TurnTelemetry {
  const ttftMs = timing.firstTokenAt !== undefined ? Math.max(0, timing.firstTokenAt - timing.sentAt) : null;
  const durationMs = timing.endAt !== undefined ? Math.max(0, timing.endAt - timing.sentAt) : null;
  let tps: number | null = null;
  if (timing.firstTokenAt !== undefined && timing.endAt !== undefined && completionTokens) {
    const generationMs = timing.endAt - timing.firstTokenAt - timing.toolMs;
    if (generationMs > 0) tps = completionTokens / (generationMs / 1000);
  }
  return { ttftMs, tps, durationMs };
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return MISSING;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trimFixed(n / 1000)}k`;
  return `${trimFixed(n / 1_000_000)}M`;
}

function trimFixed(n: number): string { return n >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, ''); }

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return MISSING;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatCost(dollars: number | null | undefined): string {
  if (dollars === null || dollars === undefined || !Number.isFinite(dollars)) return MISSING;
  return `$${dollars.toFixed(3)}`;
}

/** `> TPS 42 tok/s | TTFT 1.2s | 29.7s | ↑ 5.6k | ↓ 1.2k | $0.004` */
export function formatTelemetryLine(t: TurnTelemetry, usage: { promptTokens: number; completionTokens: number; costEstimate: number } | null): string {
  return [
    `> TPS ${t.tps === null ? MISSING : `${Math.round(t.tps)} tok/s`}`,
    `TTFT ${formatDuration(t.ttftMs)}`,
    formatDuration(t.durationMs),
    `↑ ${formatTokens(usage?.promptTokens)}`,
    `↓ ${formatTokens(usage?.completionTokens)}`,
    formatCost(usage?.costEstimate),
  ].join(' | ');
}

export interface ContextBar { text: string; ratio: number | null; warn: boolean }

/** `[███░░░░░░] 4.7% · 12k/252k` — used = input tokens of the latest request. */
export function contextBar(used: number | null | undefined, contextWindow: number | null | undefined, cells = 9): ContextBar {
  const size = Math.max(1, Math.floor(cells));
  if (used === null || used === undefined || !contextWindow || contextWindow <= 0) {
    return { text: `[${'░'.repeat(size)}] ${MISSING} · ${formatTokens(used)}/${formatTokens(contextWindow || null)}`, ratio: null, warn: false };
  }
  const ratio = Math.max(0, used / contextWindow);
  // Any usage shows at least one cell so a non-empty context never looks empty.
  const filled = ratio > 0 ? Math.min(size, Math.max(1, Math.round(ratio * size))) : 0;
  const percent = `${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%`;
  return {
    text: `[${'█'.repeat(filled)}${'░'.repeat(size - filled)}] ${percent} · ${formatTokens(used)}/${formatTokens(contextWindow)}`,
    ratio,
    warn: ratio >= CONTEXT_WARN_RATIO,
  };
}

export interface GitStatus { branch: string | null; commit: string | null; changed: number; untracked: number }

/** Parses `git status --porcelain=v2 --branch`. */
export function parseGitStatus(output: string): GitStatus {
  const status: GitStatus = { branch: null, commit: null, changed: 0, untracked: 0 };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      status.branch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      status.commit = oid === '(initial)' ? null : oid.slice(0, 7);
    } else if (/^[12u] /.test(line)) status.changed++;
    else if (line.startsWith('? ')) status.untracked++;
  }
  return status;
}

/**
 * Footer left segments. Cut order (lowest priority first):
 * commit → git status → branch → cwd shrunk to its last directory.
 */
export function footerLeftSegments(cwd: string, git: GitStatus | null): Segment[] {
  const base = cwd.split(/[\\/]+/).filter(Boolean).at(-1) ?? cwd;
  const segments: Segment[] = [{ text: cwd, compact: base, priority: 4 }];
  if (git?.branch) segments.push({ text: git.branch, priority: 3 });
  if (git && (git.changed || git.untracked)) {
    const flags = [git.changed ? `!${git.changed}` : '', git.untracked ? `?${git.untracked}` : ''].filter(Boolean).join(' ');
    segments.push({ text: `[${flags}]`, priority: 2 });
  }
  if (git?.commit) segments.push({ text: git.commit, priority: 1 });
  return segments;
}

/** Footer line 2 right: `↑36k (U 4.6k + R 31k) ↓69 $0.041`. */
export function footerUsageText(total: { promptTokens: number; completionTokens: number; costEstimate: number; cacheReadInputTokens?: number } | null): string {
  if (!total) return `↑${MISSING} ↓${MISSING} ${MISSING}`;
  const read = total.cacheReadInputTokens;
  const detail = read === undefined ? '' : ` (U ${formatTokens(Math.max(0, total.promptTokens - read))} + R ${formatTokens(read)})`;
  return `↑${formatTokens(total.promptTokens)}${detail} ↓${formatTokens(total.completionTokens)} ${formatCost(total.costEstimate)}`;
}

/** Shortens a leading home directory to `~` for clean header/footer display. */
export function compactHomePath(cwd: string, homedir?: string): string {
  const norm = cwd.replace(/\\/g, '/');
  const home = homedir?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (home && (norm === home || norm.startsWith(`${home}/`))) {
    return `~${norm.slice(home.length)}`;
  }
  return norm;
}

/**
 * Formats a user message as full-width pi-open-tui block lines (`▌ > ... ▐`)
 * that never exceed `width` columns.
 */
export function formatUserPromptLines(
  prompt: string,
  width: number,
  opts: { left?: string; right?: string } = {},
): string[] {
  const cols = Math.max(4, Math.floor(width));
  const left = opts.left ?? '▌';
  const right = opts.right ?? '▐';
  const edgeWidth = visibleWidth(left) + visibleWidth(right) + 2;
  const innerWidth = Math.max(1, cols - edgeWidth);
  return prompt.split(/\r?\n/).map((line, idx) => {
    const prefix = idx === 0 ? '> ' : '  ';
    const body = truncate(`${prefix}${line}`, innerWidth);
    const pad = ' '.repeat(Math.max(0, innerWidth - visibleWidth(body)));
    return `${left} ${body}${pad} ${right}`;
  });
}

/** Joins two fixed-width columns separated by `divider`, padded/truncated to `totalWidth`. */
export function formatTwoColumnRow(
  leftText: string,
  rightText: string,
  totalWidth: number,
  divider = ' │ ',
): string {
  const divWidth = visibleWidth(divider);
  const avail = Math.max(2, Math.floor(totalWidth) - divWidth);
  const leftCols = Math.max(1, Math.floor(avail * 0.56));
  const rightCols = Math.max(1, avail - leftCols);
  const l = truncate(leftText, leftCols);
  const lPad = ' '.repeat(Math.max(0, leftCols - visibleWidth(l)));
  const r = truncate(rightText, rightCols);
  const rPad = ' '.repeat(Math.max(0, rightCols - visibleWidth(r)));
  return `${l}${lPad}${divider}${r}${rPad}`;
}
