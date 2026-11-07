// src/tui/components/approval-dialog.tsx - Human-in-the-loop approval prompt (Enter defaults to deny)
import { DiffView } from './diff-view.js';
import { approvalPreview } from '../approval-preview.js';
import { Box, Text } from 'ink';
import type { ApprovalRequest } from '../../tools/permissions.js';
import { truncate } from '../layout.js';
import { createTheme } from '../theme.js';

export function ApprovalDialog({
  approval,
  width = 80,
  expanded = false,
  draft,
}: {
  approval: Readonly<ApprovalRequest>;
  width?: number;
  expanded?: boolean;
  draft?: string;
}) {
  const theme = createTheme();
  const cols = Math.max(24, Math.floor(width));
  const innerWidth = Math.max(12, cols - 4);
  let args = approval.args;
  if (draft !== undefined) {
    try {
      const parsed: unknown = JSON.parse(draft);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      else args = {};
    } catch { args = {}; } // Draft sai chưa có preview; editor giữ nguyên để sửa.
  }
  const patch = approvalPreview(approval.name, args);
  const primaryArg = approval.args.command ?? approval.args.path ?? JSON.stringify(approval.args);

  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} width={cols}>
      <Text>{truncate(theme.warning(`${theme.icons.warning} Cần duyệt: ${approval.name}`), innerWidth)}</Text>
      <Text>{truncate((approval.risk === 'high' ? theme.error : approval.risk === 'low' ? theme.success : theme.warning)(`Risk: ${approval.risk ?? 'unknown'}`), innerWidth)}</Text>
      <Text>{truncate(String(primaryArg).replace(/[\r\n]+/g, ' '), innerWidth)}</Text>
      {patch !== undefined && <DiffView patch={patch} width={innerWidth} maxLines={expanded ? Number.MAX_SAFE_INTEGER : 30} />}
      <Text>{truncate(theme.muted(`Lý do: ${approval.reason}`), innerWidth)}</Text>
      <Text>{truncate(`${theme.success('[y] Duyệt')}   ${theme.error('[n / Enter] Từ chối')}${approval.name === 'confirm' ? '' : '   [e] Edit'}`, innerWidth)}</Text>
    </Box>
  );
}
