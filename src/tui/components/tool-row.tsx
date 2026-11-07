// src/tui/components/tool-row.tsx - Compact tool status with optional full output
import { DiffView } from './diff-view.js';
import { approvalPreview } from '../approval-preview.js';
import { Box, Text } from 'ink';
import type { TuiToolRow } from '../store.js';
import { truncate } from '../layout.js';
import { createTheme } from '../theme.js';

export function ToolRow({ row, expanded, width }: { row: TuiToolRow; expanded: boolean; width: number }) {
  const theme = createTheme();
  const policy = row.result?.metadata?.policy as Record<string, unknown> | undefined;
  const denied =
    typeof policy === 'object' &&
    policy !== null &&
    (policy.verdict === 'deny' || policy.approval === 'denied');
  const main = String(row.call.arguments.path ?? row.call.arguments.command ?? JSON.stringify(row.call.arguments)).replace(/[\r\n]+/g, ' ');
  const duration = row.result?.metadata?.durationMs;
  const durationSuffix = typeof duration === 'number' ? `  (${(duration / 1000).toFixed(1)}s)` : '';

  let summary: string;
  if (denied) {
    const reason = (typeof policy?.reason === 'string' && policy.reason) || row.result?.error || row.result?.output || 'policy';
    summary = truncate(`${theme.icons.denied} ${row.call.name} ${main} — bị chặn: ${String(reason).replace(/[\r\n]+/g, ' ')}`, width);
  } else if (!row.result) {
    summary = truncate(`${theme.icons.running} ${row.call.name} ${main}`, width);
  } else if (row.result.isError) {
    const errText = String(row.result.error ?? row.result.output).split(/\r?\n/)[0] ?? 'error';
    summary = truncate(`${theme.icons.running} ${row.call.name} ${main}  ${theme.icons.error} ${errText}${durationSuffix}`, width);
  } else {
    summary = truncate(`${theme.icons.running} ${row.call.name} ${main}  ${theme.icons.success}${durationSuffix}`, width);
  }

  const patch = approvalPreview(row.call.name, row.call.arguments);
  const gutter = `  ${theme.icons.bar} `;
  const expandedLines = expanded && row.result?.output ? row.result.output.split(/\r?\n/) : [];

  return (
    <Box flexDirection="column">
      <Text>{denied || row.result?.isError ? theme.error(summary) : !row.result ? theme.accent(summary) : theme.muted(summary)}</Text>
      {row.result?.isError && !denied && <Text>{theme.error(truncate(`  ${row.result.error ?? row.result.output}`, width))}</Text>}
      {expanded && patch !== undefined && <><Text>{theme.muted('Proposed changes' + (policy?.approval === 'edited' ? ' (arguments were edited before execution)' : ''))}</Text><DiffView patch={patch} width={width} maxLines={Number.MAX_SAFE_INTEGER} /></>}
      {expandedLines.map((line, idx) => (
        <Text key={idx}>{theme.muted(truncate(`${gutter}${line}`, width))}</Text>
      ))}
    </Box>
  );
}
