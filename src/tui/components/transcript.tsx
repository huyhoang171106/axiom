// src/tui/components/transcript.tsx - Static completed turns and a live streaming turn
import type { ReactNode } from 'react';
import { Box, Static, Text } from 'ink';
import type { TuiTurn, TuiState } from '../store.js';
import { ToolRow } from './tool-row.js';
import { formatTelemetryLine, formatUserPromptLines, truncate } from '../layout.js';
import { createTheme } from '../theme.js';

function renderAssistantLines(text: string, theme: ReturnType<typeof createTheme>): ReactNode[] {
  const lines = text.split(/\r?\n/);
  let inFence = false;
  return lines.map((line, idx) => {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      return <Text key={idx}>{theme.muted(line)}</Text>;
    }
    if (inFence) {
      return <Text key={idx}>{theme.muted(`${theme.icons.bar} `)}{line}</Text>;
    }
    if (/^#{1,6}\s/.test(line)) {
      return <Text key={idx}>{theme.accent(theme.bold(line))}</Text>;
    }
    return <Text key={idx}>{line}</Text>;
  });
}

export function Turn({ turn, expanded, width }: { turn: TuiTurn; expanded: boolean; width: number }) {
  const theme = createTheme();
  const cols = Math.max(20, Math.floor(width));
  const promptLines = turn.prompt
    ? formatUserPromptLines(turn.prompt, cols, { left: theme.icons.userLeft, right: theme.icons.userRight })
    : [];
  const lastThought =
    turn.thinking
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? '';
  const doneThinking = Boolean(turn.text) || turn.status === 'completed' || turn.status === 'failed';
  const thinkingLine = turn.thinking
    ? truncate(`~ think ${doneThinking ? theme.icons.success : `${theme.icons.thinking} ${lastThought}`}`, cols)
    : '';
  const errorLines = turn.error ? turn.error.split(/\r?\n/) : [];

  return (
    <Box flexDirection="column">
      {promptLines.map((line, idx) => (
        <Text key={`p-${idx}`}>{theme.userBg(line)}</Text>
      ))}
      {thinkingLine && <Text>{theme.muted(thinkingLine)}</Text>}
      {turn.tools.map((row, index) => (
        <ToolRow key={`${row.call.id}-${index}`} row={row} expanded={expanded} width={cols} />
      ))}
      {turn.text && <Box flexDirection="column">{renderAssistantLines(turn.text, theme)}</Box>}
      {errorLines.map((line, idx) => (
        <Text key={`err-${idx}`}>
          {idx === 0
            ? theme.error(truncate(`${theme.icons.error} ${line}`, cols))
            : theme.warning(truncate(`  ${line}`, cols))}
        </Text>
      ))}
      {turn.telemetry && <Text>{theme.muted(truncate(formatTelemetryLine(turn.telemetry, turn.usage), cols))}</Text>}
    </Box>
  );
}

export function Transcript({ state, expanded, width, header }: { state: TuiState; expanded: boolean; width: number; header?: ReactNode }) {
  // Ink writes out only one <Static> per app, so the header goes in as the first item of this one.
  const items: ('header' | TuiTurn)[] = header ? ['header', ...state.entries] : [...state.entries];
  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) =>
          item === 'header' ? (
            <Box key="header">{header}</Box>
          ) : (
            <Turn key={item.id} turn={item} expanded={false} width={width} />
          )
        }
      </Static>
      {expanded &&
        state.entries.flatMap((turn) =>
          turn.tools.map((row, index) => <ToolRow key={`${turn.id}-${index}`} row={row} expanded width={width} />),
        )}
      {state.live && <Turn turn={state.live} expanded={expanded} width={width} />}
    </Box>
  );
}
