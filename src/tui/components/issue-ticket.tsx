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
    ['type', [props.ticket.type]],
    ['priority', [props.ticket.priority]],
    ['route', [props.ticket.route]],
    ['affected_files', props.ticket.affected_files],
    ['reproduction_steps', props.ticket.reproduction_steps],
    ['acceptance_criteria', props.ticket.acceptance_criteria],
    ['missing_info', props.ticket.missing_info],
  ] as const;

  return (
    <Box flexDirection="column" width={props.width}>
      {rows.map(([label, values]) => (
        <Box key={label}>
          {/* Giữ cột nhãn cố định để giá trị dài xuống dòng trong cột riêng. */}
          <Box width={22} flexShrink={0}><Text>{label}</Text></Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            {/* Không bỏ hàng rỗng: người đọc cần biết ticket không có mục nào. */}
            {values.length === 0 ? <Text>—</Text> : values.map((value, index) => (
              <Text key={index} wrap="wrap">{value}</Text>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
