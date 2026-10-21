// src/tui/components/editor.tsx - Controlled terminal input; state remains in the store
import { Box, Text, useInput } from 'ink';
import { editInput, type EditorState } from '../editor.js';
import { truncate } from '../layout.js';
import { createTheme } from '../theme.js';

export function Editor(props: {
  value: EditorState;
  disabled?: boolean;
  secret?: boolean;
  allowEmptySubmit?: boolean;
  width?: number;
  getValue?(): EditorState;
  onChange(value: EditorState): void;
  onSubmit(text: string): void;
}) {
  useInput(
    (input, key) => {
      if (key.upArrow || key.downArrow || key.tab) return;
      const result = editInput(props.getValue?.() ?? props.value, input, key, {
        allowEmptySubmit: props.allowEmptySubmit,
        singleLine: props.secret,
      });
      props.onChange(result.state);
      if (result.submit !== undefined) props.onSubmit(result.submit);
    },
    { isActive: !props.disabled },
  );

  const theme = createTheme();
  const cols = props.width ? Math.max(20, Math.floor(props.width)) : undefined;
  const innerWidth = cols ? Math.max(8, cols - 4) : 1000;
  const cursorGlyph = props.disabled ? '' : theme.accent(theme.icons.cursor);

  if (!props.value.text) {
    if (props.disabled) {
      return (
        <Box borderStyle="round" paddingX={1} flexDirection="column" {...(cols ? { width: cols } : {})}>
          <Text>{truncate(theme.muted('Đang xử lý…'), innerWidth)}</Text>
        </Box>
      );
    }
    if (props.secret) {
      return (
        <Box borderStyle="round" paddingX={1} flexDirection="column" {...(cols ? { width: cols } : {})}>
          <Text>{truncate(`${cursorGlyph} ${theme.muted('Dán key rồi bấm Enter (ký tự được ẩn)')}`, innerWidth)}</Text>
        </Box>
      );
    }
    if (props.allowEmptySubmit) {
      return (
        <Box borderStyle="round" paddingX={1} flexDirection="column" {...(cols ? { width: cols } : {})}>
          <Text>{truncate(`${cursorGlyph} ${theme.muted('Nhập câu trả lời hoặc bấm Enter để chọn mặc định')}`, innerWidth)}</Text>
        </Box>
      );
    }
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column" {...(cols ? { width: cols } : {})}>
        <Text>{cursorGlyph}</Text>
      </Box>
    );
  }

  if (props.secret) {
    const len = [...props.value.text].length;
    const masked = '*'.repeat(Math.min(len, 48));
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column" {...(cols ? { width: cols } : {})}>
        <Text>{truncate(`${masked}${cursorGlyph} ${theme.muted(`(${len} chars)`)}`, innerWidth)}</Text>
      </Box>
    );
  }

  const cursor = Math.max(0, Math.min(props.value.cursor, props.value.text.length));
  const withCursor = `${props.value.text.slice(0, cursor)}${cursorGlyph}${props.value.text.slice(cursor)}`;
  const lines = withCursor.split(/\r?\n/);

  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column" {...(cols ? { width: cols } : {})}>
      {lines.map((line, idx) => (
        <Text key={idx}>{truncate(line, innerWidth)}</Text>
      ))}
    </Box>
  );
}
