// src/tui/components/fix-report.tsx - Renderer for the `fix-report` CommandResult of /fix (UC-03)
import { Box, Text } from 'ink';
import { z } from 'zod';
import { DEFAULT_MAX_ROUNDS, type FixReport } from '../../agents/fix.js';
import { truncate } from '../layout.js';
import { createTheme } from '../theme.js';
import { DiffView } from './diff-view.js';
import { FixProgress } from './fix-progress.js';

/** CommandResult.data is unknown at the TUI boundary; draw only what has the FixReport shape. */
export const fixReportSchema = z.object({
  status: z.enum(['fixed', 'failed', 'aborted']),
  rounds: z.array(z.object({
    round: z.number(), hypothesis: z.string(), patchApplied: z.boolean(),
    testsPassed: z.number(), testsFailed: z.number(), regressions: z.array(z.string()),
  })),
  filesChanged: z.array(z.string()),
  diffStat: z.object({ files: z.number(), added: z.number(), removed: z.number() }),
  explanation: z.string().optional(),
  summary: z.string(),
  patch: z.string().optional(),
});

export function FixReportView(props: { report: FixReport; width: number; maxRounds?: number; maxDiffLines?: number }) {
  const theme = createTheme();
  const width = Math.max(20, Math.floor(props.width));
  const { report } = props;
  const status = report.status === 'fixed'
    ? theme.success(`${theme.icons.success} fixed`)
    : report.status === 'aborted' ? theme.warning(`${theme.icons.warning} aborted`) : theme.error(`${theme.icons.error} failed`);
  const stat = `${report.diffStat.files} file, +${report.diffStat.added} -${report.diffStat.removed}`;
  return (
    <Box flexDirection="column" width={width}>
      <Text>{status} {theme.muted(truncate(`${theme.icons.bullet} ${stat}`, width - 10))}</Text>
      <FixProgress rounds={report.rounds} maxRounds={props.maxRounds ?? DEFAULT_MAX_ROUNDS} width={width} />
      {report.patch ? <DiffView patch={report.patch} width={width} maxLines={props.maxDiffLines} /> : null}
      <Text wrap="wrap">{report.summary}</Text>
      {report.explanation && <Text wrap="wrap">{theme.muted(report.explanation)}</Text>}
    </Box>
  );
}
