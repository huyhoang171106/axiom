// src/tui/components/fix-progress.tsx - One line per /fix round: tests after the patch and the hypothesis
import { Box, Text } from 'ink';
import type { FixRound } from '../../agents/fix.js';
import { truncate } from '../layout.js';
import { createTheme } from '../theme.js';

/** A round succeeded only when its patch applied and left no failing test and no regression. */
const isRoundGreen = (r: FixRound) => r.patchApplied && r.testsFailed === 0 && r.regressions.length === 0;

export function formatRoundLine(r: FixRound, maxRounds: number, sep = '·'): string {
  const tests = r.patchApplied
    ? `passed ${r.testsPassed}, failed ${r.testsFailed}${r.regressions.length ? `, regressions ${r.regressions.length}` : ''}`
    : 'không áp được patch';
  const hypothesis = r.hypothesis.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return `Vòng ${r.round}/${maxRounds} ${sep} ${tests} ${sep} ${hypothesis}`;
}

export function FixProgress(props: { rounds: FixRound[]; maxRounds: number; width: number }) {
  const theme = createTheme();
  const width = Math.max(1, Math.floor(props.width));
  return (
    <Box flexDirection="column">
      {props.rounds.map((r) => {
        const green = isRoundGreen(r);
        // Symbol next to the color: the state must read without color too (tui.md section 3).
        const line = truncate(`${green ? theme.icons.success : theme.icons.error} ${formatRoundLine(r, props.maxRounds, theme.icons.bullet)}`, width);
        return <Text key={r.round}>{green ? theme.success(line) : theme.error(line)}</Text>;
      })}
    </Box>
  );
}
