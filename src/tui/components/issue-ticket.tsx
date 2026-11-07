// src/tui/components/issue-ticket.tsx - Hiển thị thông tin phân loại của IssueTicket.
import { Box, Text } from 'ink';
import type { IssueTicket } from '../../agents/triage.js';

export function IssueTicketView(props: {
  ticket: IssueTicket;
  warnings: string[];
  width: number;
  workspaceRoot: string;
}) {
  const rows = [
    ['type', props.ticket.type],
    ['priority', props.ticket.priority],
    ['route', props.ticket.route],
  ];

  return (
    <Box flexDirection="column" width={props.width}>
      {rows.map(([label, value]) => (
        <Box key={label}>
          {/* Giữ cột nhãn cố định để giá trị dài xuống dòng trong cột riêng. */}
          <Box width={12} flexShrink={0}><Text>{label}</Text></Box>
          <Box flexGrow={1} flexShrink={1}><Text wrap="wrap">{value}</Text></Box>
        </Box>
      ))}
    </Box>
  );
}
