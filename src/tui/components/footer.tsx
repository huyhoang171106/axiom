// src/tui/components/footer.tsx - Two footer lines; layout decisions live in layout.ts
import os from 'node:os';
import { Box, Text } from 'ink';
import type { TuiState } from '../store.js';
import {
  compactHomePath,
  contextBar,
  fitFooterLine,
  footerUsageText,
  formatCost,
  formatTokens,
  MISSING,
  type Segment,
} from '../layout.js';
import { createTheme } from '../theme.js';
import { detectRuntime } from '../runtime.js';

export function Footer({ state, workspace, width }: { state: TuiState; workspace: string; width: number }) {
  const theme = createTheme();
  const cols = Math.max(10, Math.floor(width));

  // Context bar on the right of Line 1
  const promptTokens = state.usage.latest?.promptTokens ?? (state.usage.total ? state.usage.total.promptTokens : 0);
  const contextWindow = state.model?.contextWindow ?? 1_000_000;
  const bar = contextBar(promptTokens, contextWindow);
  const right1 = bar.warn ? theme.warning(`${theme.icons.warning} ${bar.text}`) : bar.text;

  // Left side of Line 1: cwd + git + status + runtime
  const displayCwd = compactHomePath(workspace, os.homedir());
  const cwdText = `${theme.accent(theme.icons.cwd)} ${displayCwd}`;
  const cwdCompact = `${theme.accent(theme.icons.cwd)} ${displayCwd.split(/[\\/]+/).filter(Boolean).at(-1) ?? displayCwd}`;
  const line1Segments: Segment[] = [{ text: cwdText, compact: cwdCompact, priority: 5 }];

  if (state.git?.branch) {
    line1Segments.push({ text: `${theme.accent(theme.icons.git)} ${state.git.branch}`, priority: 4 });
  }

  if (state.git && (state.git.changed || state.git.untracked)) {
    const flags = [
      state.git.changed ? `${theme.warning('!')}${state.git.changed}` : '',
      state.git.untracked ? `${theme.muted('?')}${state.git.untracked}` : '',
    ].filter(Boolean).join(' ');
    line1Segments.push({ text: `[${flags}]`, priority: 3 });
  }

  const runtime = detectRuntime(workspace);
  if (runtime) {
    const runtimeSymbol = theme.icons.runtime || runtime.symbol;
    line1Segments.push({
      text: `${theme.success(runtimeSymbol)} ${theme.muted(runtime.version ?? runtime.name)}`,
      priority: 2,
    });
  }

  if (state.git?.commit) {
    line1Segments.push({ text: theme.muted(state.git.commit), priority: 1 });
  }

  const line1 = fitFooterLine(line1Segments, right1, cols);

  // Line 2 Left: provider + model id + mode
  const left2: Segment[] = [
    { text: state.model?.provider ?? MISSING, priority: 3 },
    { text: state.model?.id ?? MISSING, priority: 2 },
    { text: state.mode, priority: 1 },
  ];

  // Line 2 Right: tokens + cost stats
  const line2 = fitFooterLine(left2, footerUsageText(state.usage.total), cols);

  return (
    <Box flexDirection="column">
      <Text>{line1}</Text>
      <Text>{line2}</Text>
    </Box>
  );
}
