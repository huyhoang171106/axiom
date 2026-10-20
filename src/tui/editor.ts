// src/tui/editor.ts - Pure multiline editor transitions for terminal key events
export interface EditorState { text: string; cursor: number }
export interface EditorKey {
  return?: boolean;
  meta?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  escape?: boolean;
}
export interface EditOptions {
  /** Allow submitting an empty line (used for [y/N] confirmations and optional login fields). */
  allowEmptySubmit?: boolean;
  /** Single-line mode (used for secret API key prompts so pasted newlines never corrupt the key). */
  singleLine?: boolean;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Strips bracketed-paste markers (`ESC[200~` / `ESC[201~`) that some terminals deliver inside `input`. */
function stripBracketedPaste(raw: string): string {
  return raw.replace(/\x1b\[20[01]~/g, '').replace(/^\[200~|\[201~$/g, '');
}

export function editInput(
  state: EditorState,
  input: string,
  key: EditorKey,
  opts: EditOptions = {},
): { state: EditorState; submit?: string } {
  const before = state.text.slice(0, state.cursor);
  const after = state.text.slice(state.cursor);
  const previous = [...graphemes.segment(before)].at(-1)?.segment ?? '';
  const next = [...graphemes.segment(after)][0]?.segment ?? '';

  if (key.return) {
    if (!opts.singleLine && (key.meta || key.shift || before.endsWith('\\'))) {
      const prefix = before.endsWith('\\') && !key.meta && !key.shift ? before.slice(0, -1) : before;
      return { state: { text: prefix + '\n' + after, cursor: prefix.length + 1 } };
    }
    if (state.text.trim() || opts.allowEmptySubmit) {
      return { state: { text: '', cursor: 0 }, submit: state.text };
    }
    return { state };
  }
  if (key.leftArrow) return { state: { ...state, cursor: state.cursor - previous.length } };
  if (key.rightArrow) return { state: { ...state, cursor: state.cursor + next.length } };
  if (key.backspace) {
    return {
      state: {
        text: before.slice(0, before.length - previous.length) + after,
        cursor: state.cursor - previous.length,
      },
    };
  }
  if (key.delete) return { state: { ...state, text: before + after.slice(next.length) } };
  if (key.ctrl || key.meta || key.escape || !input) return { state };

  const cleaned = stripBracketedPaste(input)
    .replace(/\r\n?/g, opts.singleLine ? '' : '\n')
    .replace(opts.singleLine ? /[\x00-\x1f\x7f]/g : /[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return { state: { text: before + cleaned + after, cursor: before.length + cleaned.length } };
}
