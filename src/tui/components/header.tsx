// src/tui/components/header.tsx - One-time terminal welcome inspired by pi-open-tui
import os from 'node:os';
import { Box, Text } from 'ink';
import { compactHomePath, formatTwoColumnRow, truncate } from '../layout.js';
import { createTheme } from '../theme.js';

export function Header({
  workspace,
  model,
  mode = 'edit',
  width = 80,
}: {
  workspace: string;
  model: string;
  mode?: string;
  width?: number;
}) {
  const theme = createTheme();
  const cols = Math.max(24, Math.floor(width));
  const innerWidth = Math.max(12, cols - 4);
  const displayPath = compactHomePath(workspace, os.homedir());
  const divider = ` ${theme.muted(theme.icons.bar)} `;

  if (innerWidth >= 64) {
    const row1 = formatTwoColumnRow(
      `${theme.accent(`${theme.icons.logo} Axiom v0.1`)} ${theme.muted(`${theme.icons.bullet} Coding agent`)}`,
      theme.accent('Welcome'),
      innerWidth,
      divider,
    );
    const row2 = formatTwoColumnRow(
      theme.bold("  Let's fix something"),
      theme.muted('Hỏi gì về repo cũng được'),
      innerWidth,
      divider,
    );
    const row3 = formatTwoColumnRow(
      `  ${model} ${theme.muted(`${theme.icons.bullet} ${mode} mode`)}`,
      theme.accent('Commands'),
      innerWidth,
      divider,
    );
    const row4 = formatTwoColumnRow(
      theme.muted(`  ${displayPath}`),
      theme.muted('/help  /login  /model  /triage  /exit'),
      innerWidth,
      divider,
    );
    return (
      <Box borderStyle="round" flexDirection="column" paddingX={1} width={cols}>
        <Text>{row1}</Text>
        <Text>{row2}</Text>
        <Text>{row3}</Text>
        <Text>{row4}</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} width={cols}>
      <Text>{truncate(theme.accent(`${theme.icons.logo} Axiom v0.1 ${theme.icons.bullet} Coding agent`), innerWidth)}</Text>
      <Text>{truncate("Let's fix something", innerWidth)}</Text>
      <Text>{truncate(`${model} ${theme.icons.bullet} ${mode} mode`, innerWidth)}</Text>
      <Text>{truncate(theme.muted(displayPath), innerWidth)}</Text>
      <Text>{truncate(theme.muted('/help  /login  /model  /triage  /exit'), innerWidth)}</Text>
    </Box>
  );
}
