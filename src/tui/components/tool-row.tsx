// src/tui/components/tool-row.tsx - Compact tool status with optional full output
import { Box, Text } from 'ink';
import type { TuiToolRow } from '../store.js';
import { truncate } from '../layout.js';
import { createTheme } from '../theme.js';

export function ToolRow({ row, expanded, width }: { row: TuiToolRow; expanded: boolean; width: number }) {
  const theme = createTheme();
  const policy = row.result?.metadata?.policy;
  const denied = typeof policy === 'object' && policy !== null &&
    ('verdict' in policy && policy.verdict === 'deny' || 'approval' in policy && policy.approval === 'denied');
  const icon = denied ? theme.icons.denied : !row.result ? theme.icons.running : row.result.isError ? theme.icons.error : theme.icons.success;
  const main = row.call.arguments.path ?? row.call.arguments.command ?? JSON.stringify(row.call.arguments);
  const duration = row.result?.metadata?.durationMs;
  const suffix = typeof duration === 'number' ? ` (${(duration / 1000).toFixed(1)}s)` : '';
  const summary = truncate(`${icon} ${row.call.name} ${String(main).replace(/[\r\n]+/g, ' ')}${suffix}`, width);
  return <Box flexDirection="column">
    <Text>{row.result?.isError ? theme.error(summary) : theme.muted(summary)}</Text>
    {row.result?.isError && <Text>{theme.error(row.result.error ?? row.result.output)}</Text>}
    {expanded && row.result && <Text>{row.result.output}</Text>}
  </Box>;
}
