// src/tui/components/header.tsx - One-time terminal welcome inspired by pi-open-tui
import os from 'node:os';
import { Box, Text } from 'ink';
import { compactHomePath, truncate, visibleWidth } from '../layout.js';
import { createTheme } from '../theme.js';

const AXIOM_LOGO = [
  '  ███    █   █   █    ███   █   █ ',
  ' █   █    █ █    █   █   █  ██ ██ ',
  ' █████     █     █   █   █  █ █ █ ',
  ' █   █    █ █    █   █   █  █   █ ',
  ' █   █   █   █   █    ███   █   █ ',
];

function renderLogo(paintBrand: (text: string) => string): string[] {
  return AXIOM_LOGO.map((r) => paintBrand(r));
}

function padRight(text: string, width: number, ellipsis = ''): string {
  const clipped = truncate(text, width);
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}

function center(text: string, width: number): string {
  if (width <= 0) return '';
  const w = visibleWidth(text);
  if (w >= width) return truncate(text, width);
  return ' '.repeat(Math.floor((width - w) / 2)) + text;
}

function borderLine(
  left: string,
  label: string,
  right: string,
  width: number,
  paint: (text: string) => string,
): string {
  if (width <= 1) return '';
  if (width < 8 || label.length === 0) {
    return paint(truncate(left + '─'.repeat(Math.max(0, width - 2)) + right, width));
  }
  const before = '─ ';
  const after = ' ─────';
  const fixedWidth = visibleWidth(before) + visibleWidth(label) + visibleWidth(after);
  const fill = Math.max(0, width - 2 - fixedWidth);
  return `${paint(left)}${paint(before)}${label}${paint(after)}${paint('─'.repeat(fill))}${paint(right)}`;
}

function boxedLine(content: string, width: number, paint: (text: string) => string): string {
  if (width <= 2) return truncate(content, width);
  return `${paint('│')}${padRight(content, width - 2)}${paint('│')}`;
}

function twoColumn(
  left: string,
  right: string,
  leftWidth: number,
  rightWidth: number,
  paint: (text: string) => string,
): string {
  return `${padRight(left, leftWidth)} ${paint('│')} ${padRight(right, rightWidth)}`;
}

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
  const cols = Math.max(20, Math.floor(width));
  const innerWidth = Math.max(10, cols - 2);
  const paint = (s: string) => theme.accent(s);
  const brand = (s: string) => `\x1b[38;2;180;140;255m${s}\x1b[39m`;
  const muted = (s: string) => theme.muted(s);
  const bold = (s: string) => theme.bold(s);

  if (cols < 28) {
    return <Text>{theme.accent('Axiom v0.1')}</Text>;
  }

  const minLeftWidth = 28;
  const minTipsWidth = 16;
  const maxTipsWidth = 28;
  const gap = 3;
  const useTips = innerWidth >= minLeftWidth + gap + minTipsWidth;

  let rightWidth = Math.min(maxTipsWidth, Math.max(minTipsWidth, Math.round(innerWidth * 0.28)));
  let leftWidth = innerWidth - gap - rightWidth;
  if (leftWidth < minLeftWidth) {
    leftWidth = minLeftWidth;
    rightWidth = innerWidth - gap - leftWidth;
  }
  if (!useTips) {
    leftWidth = innerWidth;
    rightWidth = 0;
  }

  const displayPath = compactHomePath(workspace, os.homedir());
  const leftLines = [
    '',
    ...renderLogo(brand).map((line) => center(line, leftWidth)),
    center(bold("Let's build something great"), leftWidth),
    center(muted(`${model} · ${mode} mode`), leftWidth),
    center(muted(displayPath), leftWidth),
    ...(!useTips ? [center(muted('/help /login /model /triage /exit'), leftWidth)] : []),
    '',
  ];

  const tipDivider = paint('─'.repeat(Math.max(8, Math.min(rightWidth, 22))));
  const tipLines = [
    '',
    paint(bold('Welcome')),
    muted('Ask Axiom anything'),
    tipDivider,
    paint(bold('Commands')),
    muted('/help'),
    muted('/login'),
    muted('/model'),
    muted('/triage'),
    muted('/exit'),
    '',
  ];

  const maxRows = Math.max(leftLines.length, tipLines.length);
  while (leftLines.length < maxRows) leftLines.push('');
  while (tipLines.length < maxRows) tipLines.push('');

  const title = `${paint('Axiom')} v0.1`;
  const topBorder = borderLine('╭', title, '╮', cols, paint);
  const bottomBorder = borderLine('╰', '', '╯', cols, paint);

  const lines = [topBorder];
  for (let i = 0; i < maxRows; i++) {
    const content = useTips
      ? twoColumn(leftLines[i] ?? '', tipLines[i] ?? '', leftWidth, rightWidth, paint)
      : padRight(leftLines[i] ?? '', leftWidth);
    lines.push(boxedLine(content, cols, paint));
  }
  lines.push(bottomBorder);

  return (
    <Box flexDirection="column" width={cols}>
      {lines.map((line, idx) => (
        <Text key={idx}>{line}</Text>
      ))}
    </Box>
  );
}
