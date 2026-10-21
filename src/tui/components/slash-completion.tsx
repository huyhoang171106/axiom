// src/tui/components/slash-completion.tsx - Vertical slash command completion popup
import { Box, Text } from 'ink';
import type { Command } from '../../commands/types.js';
import { createTheme } from '../theme.js';
import { truncate } from '../layout.js';

export function SlashCompletion({
  matches,
  selectedIndex,
  width,
}: {
  matches: Command[];
  selectedIndex: number;
  width: number;
}) {
  if (matches.length === 0) return null;

  const theme = createTheme();
  const PAGE_SIZE = 5;
  const total = matches.length;
  const clampedIdx = Math.max(0, Math.min(selectedIndex, total - 1));

  let windowStart = 0;
  if (total > PAGE_SIZE) {
    windowStart = Math.max(0, Math.min(clampedIdx - Math.floor(PAGE_SIZE / 2), total - PAGE_SIZE));
  }
  const visible = matches.slice(windowStart, windowStart + PAGE_SIZE);
  const maxNameWidth = Math.max(12, ...visible.map((m) => m.name.length));

  return (
    <Box flexDirection="column" width={width}>
      {visible.map((cmd, offset) => {
        const actualIdx = windowStart + offset;
        const isSelected = actualIdx === clampedIdx;
        const prefix = isSelected ? theme.accent('→ ') : '  ';
        const namePadded = cmd.name.padEnd(maxNameWidth + 2);

        // Strip leading /<name> from usage to extract arguments
        const rawArg = cmd.usage.replace(new RegExp('^/' + cmd.name + '\\s*'), '').trim();
        let cleanArg = rawArg.split('|')[0].trim();
        if (cleanArg.startsWith('[') && !cleanArg.endsWith(']')) cleanArg += ']';
        if (cleanArg.startsWith('<') && !cleanArg.endsWith('>')) cleanArg += '>';
        const descText = cleanArg ? `${cleanArg} — ${cmd.summary}` : cmd.summary;

        const nameStyled = isSelected ? theme.accent(theme.bold(namePadded)) : theme.bold(namePadded);
        const descStyled = isSelected ? theme.brand(descText) : theme.muted(descText);

        const rawLine = `${prefix}${nameStyled}${descStyled}`;
        return (
          <Text key={cmd.name}>
            {truncate(rawLine, width)}
          </Text>
        );
      })}
      {total > 1 && (
        <Text key="pagination">
          {theme.muted(`  (${clampedIdx + 1}/${total})`)}
        </Text>
      )}
    </Box>
  );
}
