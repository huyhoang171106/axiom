// src/tui/components/issue-ticket.tsx - Hiển thị thông tin phân loại của IssueTicket.
import { Box, Text } from 'ink';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IssueTicket } from '../../agents/triage.js';
import { visibleWidth } from '../layout.js';
import { createTheme } from '../theme.js';

function linkFile(workspaceRoot: string, file: string, label: string): string {
  // Mã hóa URL bằng API của Node để dấu cách và ký tự đặc biệt không làm hỏng đích mở file.
  const url = pathToFileURL(path.resolve(workspaceRoot, file)).href;
  return `\u001b]8;;${url}\u001b\\${label}\u001b]8;;\u001b\\`;
}

function fileSegments(file: string, width: number): string[] {
  const segments: string[] = [];
  let current = '';
  // Chia theo grapheme và số cột terminal để không tách dấu tổ hợp hoặc emoji.
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(file)) {
    if (current && visibleWidth(current + segment) > width) {
      segments.push(current);
      current = '';
    }
    current += segment;
  }
  if (current) segments.push(current);
  return segments;
}

export function IssueTicketView(props: {
  ticket: IssueTicket;
  warnings: string[];
  width: number;
  workspaceRoot: string;
}) {
  const theme = createTheme();
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
            {values.length === 0 ? <Text>—</Text> : values.map((value, index) => label === 'affected_files' ? (
              <Box key={index} flexDirection="column">
                {fileSegments(value, Math.max(1, Math.floor(props.width) - 22)).map((segment, segmentIndex) => (
                  <Text key={segmentIndex}>{linkFile(props.workspaceRoot, value, segment)}</Text>
                ))}
              </Box>
            ) : <Text key={index} wrap="wrap">{value}</Text>)}
          </Box>
        </Box>
      ))}
      {props.warnings.map((warning, index) => (
        <Text key={index} wrap="wrap">{theme.warning(`${theme.icons.warning} ${warning}`)}</Text>
      ))}
    </Box>
  );
}
