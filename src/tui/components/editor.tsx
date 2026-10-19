// src/tui/components/editor.tsx - Controlled terminal input; state remains in the store
import { Box, Text, useInput } from 'ink';
import { editInput, type EditorState } from '../editor.js';
import { createTheme } from '../theme.js';

export function Editor(props: {
  value: EditorState; disabled?: boolean; secret?: boolean;
  getValue?(): EditorState;
  onChange(value: EditorState): void; onSubmit(text: string): void;
}) {
  useInput((input, key) => {
    if (key.upArrow || key.downArrow || key.tab) return;
    const result = editInput(props.getValue?.() ?? props.value, input, key);
    props.onChange(result.state);
    if (result.submit !== undefined) props.onSubmit(result.submit);
  }, { isActive: !props.disabled });
  const theme = createTheme();
  const text = props.secret ? '*'.repeat([...props.value.text].length) : props.value.text;
  return <Box borderStyle="round" paddingX={1} flexDirection="column">
    <Text>{text || theme.muted(props.disabled ? 'Đang xử lý…' : 'Nhập yêu cầu hoặc /help')}</Text>
  </Box>;
}
