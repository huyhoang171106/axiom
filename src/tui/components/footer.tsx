// src/tui/components/footer.tsx - Two footer lines; layout decisions live in layout.ts
import os from 'node:os';
import { Box, Text } from 'ink';
import type { TuiState } from '../store.js';
import {
  compactHomePath,
  contextBar,
  fitFooterLine,
  footerLeftSegments,
  footerUsageText,
  MISSING,
} from '../layout.js';
import { createTheme } from '../theme.js';

export function Footer({ state, workspace, width }: { state: TuiState; workspace: string; width: number }) {
  const theme = createTheme();
  const cols = Math.max(10, Math.floor(width));
  const bar = contextBar(state.usage.latest?.promptTokens, state.model?.contextWindow);
  const right1 = bar.warn ? theme.warning(`${theme.icons.warning} ${bar.text}`) : bar.text;
  const displayCwd = compactHomePath(workspace, os.homedir());
  const line1 = fitFooterLine(footerLeftSegments(displayCwd, state.git), right1, cols);
  const left2 = [
    { text: state.model?.provider ?? MISSING, priority: 3 },
    { text: state.model?.id ?? MISSING, priority: 2 },
    { text: state.mode, priority: 1 },
  ];
  const line2 = fitFooterLine(left2, footerUsageText(state.usage.total), cols);
  return (
    <Box flexDirection="column">
      <Text>{theme.muted(line1)}</Text>
      <Text>{theme.muted(line2)}</Text>
    </Box>
  );
}
