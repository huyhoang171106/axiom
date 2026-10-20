// src/tui/components/approval-dialog.tsx - Human-in-the-loop approval prompt (Enter defaults to deny)
import { Box, Text } from 'ink';
import type { ApprovalRequest } from '../../tools/permissions.js';
import { truncate } from '../layout.js';
import { createTheme } from '../theme.js';

export function ApprovalDialog({
  approval,
  width = 80,
}: {
  approval: Readonly<ApprovalRequest>;
  width?: number;
}) {
  const theme = createTheme();
  const cols = Math.max(24, Math.floor(width));
  const innerWidth = Math.max(12, cols - 4);
  const primaryArg = approval.args.command ?? approval.args.path ?? JSON.stringify(approval.args);

  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} width={cols}>
      <Text>{truncate(theme.warning(`${theme.icons.warning} Cần duyệt: ${approval.name}`), innerWidth)}</Text>
      <Text>{truncate(String(primaryArg).replace(/[\r\n]+/g, ' '), innerWidth)}</Text>
      <Text>{truncate(theme.muted(`Lý do: ${approval.reason}`), innerWidth)}</Text>
      <Text>{truncate(`${theme.success('[y] Duyệt')}   ${theme.error('[n / Enter] Từ chối')}`, innerWidth)}</Text>
    </Box>
  );
}
