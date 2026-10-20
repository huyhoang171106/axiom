// src/tui/components/editor.tsx - Controlled terminal input; state remains in the store
import { Box, Text, useInput } from 'ink';
import { editInput, type EditorState } from '../editor.js';
import { truncate } from '../layout.js';
import { createTheme } from '../theme.js';

export function Editor(props: {
  value: EditorState;
  disabled?: boolean;
  secret?: boolean;
  width?: number;
  getValue?(): EditorState;
  onChange(value: EditorState): void;
  onSubmit(text: string): void;
}) {
  useInput(
    (input, key) => {
      if (key.upArrow || key.downArrow || key.tab) return;
      const result = editInput(props.getValue?.() ?? props.value, input, key);
      props.onChange(result.state);
      if (result.submit !== undefined) props.onSubmit(result.submit);
    },
    { isActive: !props.disabled },
  );

  const theme = createTheme();
  const cols = props.width ? Math.max(20, Math.floor(props.width)) : undefined;
  const innerWidth = cols ? Math.max(8, cols - 4) : 1000;
  const cursorGlyph = props.disabled ? '' : theme.accent(theme.icons.cursor);
  const prefix0 = `${props.disabled ? theme.muted(theme.icons.prompt) : theme.accent(theme.icons.prompt)} `;
  const prefixN = `${theme.muted(theme.icons.bar)} `;

  if (!props.value.text) {
    const hint = props.disabled ? 'Đang xử lý…' : 'Nhập yêu cầu hoặc /help';
    const content = props.disabled
      ? `${prefix0}${theme.muted(hint)}`
      : `${prefix0}${cursorGlyph} ${theme.muted(hint)}`;
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column" {...(cols ? { width: cols } : {})}>
        <Text>{truncate(content, innerWidth)}</Text>
      </Box>
    );
  }

  if (props.secret) {
    const masked = '*'.repeat([...props.value.text].length);
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column" {...(cols ? { width: cols } : {})}>
        <Text>{truncate(`${prefix0}${masked}${cursorGlyph}`, innerWidth)}</Text>
      </Box>
    );
  }

  const cursor = Math.max(0, Math.min(props.value.cursor, props.value.text.length));
  const withCursor = `${props.value.text.slice(0, cursor)}${cursorGlyph}${props.value.text.slice(cursor)}`;
  const lines = withCursor.split(/\r?\n/);

  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column" {...(cols ? { width: cols } : {})}>
      {lines.map((line, idx) => (
        <Text key={idx}>{truncate(`${idx === 0 ? prefix0 : prefixN}${line}`, innerWidth)}</Text>
      ))}
    </Box>
  );
}
