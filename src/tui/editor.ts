// src/tui/editor.ts - Pure multiline editor transitions for terminal key events
export interface EditorState { text: string; cursor: number }
export interface EditorKey { return?: boolean; meta?: boolean; shift?: boolean; ctrl?: boolean; backspace?: boolean; delete?: boolean; leftArrow?: boolean; rightArrow?: boolean; escape?: boolean }
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function editInput(state: EditorState, input: string, key: EditorKey): { state: EditorState; submit?: string } {
  const before = state.text.slice(0, state.cursor);
  const after = state.text.slice(state.cursor);
  const previous = [...graphemes.segment(before)].at(-1)?.segment ?? '';
  const next = [...graphemes.segment(after)][0]?.segment ?? '';
  if (key.return) {
    if (key.meta || key.shift || before.endsWith('\\')) {
      const prefix = before.endsWith('\\') && !key.meta && !key.shift ? before.slice(0, -1) : before;
      return { state: { text: prefix + '\n' + after, cursor: prefix.length + 1 } };
    }
    return state.text.trim() ? { state: { text: '', cursor: 0 }, submit: state.text } : { state };
  }
  if (key.leftArrow) return { state: { ...state, cursor: state.cursor - previous.length } };
  if (key.rightArrow) return { state: { ...state, cursor: state.cursor + next.length } };
  if (key.backspace) return { state: { text: before.slice(0, before.length - previous.length) + after, cursor: state.cursor - previous.length } };
  if (key.delete) return { state: { ...state, text: before + after.slice(next.length) } };
  if (key.ctrl || key.meta || key.escape || !input) return { state };
  const inserted = input.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return { state: { text: before + inserted + after, cursor: before.length + inserted.length } };
}
