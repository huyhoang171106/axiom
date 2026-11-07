// src/tui/components/diff-view.tsx - Colored unified diff for apply_patch, edit approvals and /fix reports
import { Box, Text } from 'ink';
import { truncate } from '../layout.js';
import { createTheme } from '../theme.js';

export const DEFAULT_DIFF_LINES = 40;

export type DiffLineKind = 'file' | 'hunk' | 'added' | 'removed' | 'context';

/** `---`/`+++` are file headers, not a removed or added line, so they are checked before `-`/`+`. */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ')) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}

export function DiffView(props: { patch: string; width: number; maxLines?: number }) {
  const theme = createTheme();
  const width = Math.max(1, Math.floor(props.width));
  const maxLines = Math.max(1, Math.floor(props.maxLines ?? DEFAULT_DIFF_LINES));
  // Tabs measure 0 columns and CR would move the cursor; both would break the width budget.
  const lines = props.patch.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/\n$/, '').split('\n');
  const shown = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
  const hidden = lines.length - shown.length;
  const paint: Record<DiffLineKind, (s: string) => string> = {
    file: theme.bold,
    hunk: theme.muted,
    added: theme.success,
    removed: theme.error,
    context: (s) => s,
  };
  return (
    <Box flexDirection="column">
      {/* The leading +/- stays in the text, so the diff still reads without color (NO_COLOR, colorblind). */}
      {shown.map((line, index) => (
        <Text key={index}>{paint[diffLineKind(line)](truncate(line, width))}</Text>
      ))}
      {hidden > 0 && <Text>{theme.muted(truncate(`… ${hidden} dòng nữa`, width))}</Text>}
    </Box>
  );
}
