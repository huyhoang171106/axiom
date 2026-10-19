// src/tui/components/transcript.tsx - Static completed turns and a live streaming turn
import { Box, Static, Text } from 'ink';
import type { TuiTurn, TuiState } from '../store.js';
import { ToolRow } from './tool-row.js';
import { formatTelemetryLine, truncate } from '../layout.js';
import { createTheme } from '../theme.js';

export function Turn({ turn, expanded, width }: { turn: TuiTurn; expanded: boolean; width: number }) {
  const theme = createTheme();
  return <Box flexDirection="column">
    {turn.prompt && <Box width="100%"><Text>{theme.userBg(`> ${turn.prompt}`)}</Text></Box>}
    {turn.thinking && <Text>{theme.muted(truncate(`~ think ${turn.text ? theme.icons.success : turn.thinking.split('\n').at(-1)}`, width))}</Text>}
    {turn.tools.map((row, index) => <ToolRow key={`${row.call.id}-${index}`} row={row} expanded={expanded} width={width} />)}
    {turn.text && <Text>{turn.text}</Text>}
    {turn.error && <Text>{theme.error(`${theme.icons.error} ${turn.error}`)}</Text>}
    {turn.telemetry && <Text>{theme.muted(truncate(formatTelemetryLine(turn.telemetry, turn.usage), width))}</Text>}
  </Box>;
}

export function Transcript({ state, expanded, width }: { state: TuiState; expanded: boolean; width: number }) {
  return <Box flexDirection="column">
    <Static items={[...state.entries]}>{turn => <Turn key={turn.id} turn={turn} expanded={false} width={width} />}</Static>
    {expanded && state.entries.flatMap(turn => turn.tools.map((row, index) =>
      <ToolRow key={`${turn.id}-${index}`} row={row} expanded width={width} />))}
    {state.live && <Turn turn={state.live} expanded={expanded} width={width} />}
  </Box>;
}
