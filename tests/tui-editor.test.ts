// tests/tui-editor.test.ts - Editing without splitting Unicode characters
import test from 'node:test';
import assert from 'node:assert/strict';
import { editInput } from '../src/tui/editor.js';
import { editMenuInput, filterMenuItems, windowMenuItems, type TuiMenuState } from '../src/tui/select-menu.js';

test('Enter submits, while Alt+Enter and backslash Enter insert newlines', () => {
  const state = { text: 'hello', cursor: 5 };
  assert.equal(editInput(state, '', { return: true }).submit, 'hello');
  assert.equal(editInput(state, '', { return: true, meta: true }).state.text, 'hello\n');
  assert.equal(editInput({ text: 'hello\\', cursor: 6 }, '', { return: true }).state.text, 'hello\n');
  assert.equal(editInput({ text: '  ', cursor: 2 }, '', { return: true }).submit, undefined);
  assert.equal(editInput({ text: '', cursor: 0 }, '', { return: true }, { allowEmptySubmit: true }).submit, '');
});

test('singleLine mode strips bracketed paste markers and newlines from API keys', () => {
  const empty = { text: '', cursor: 0 };
  const pasted = editInput(empty, '\x1b[200~AIzaSyTestKey123\r\n\x1b[201~', {}, { singleLine: true });
  assert.equal(pasted.state.text, 'AIzaSyTestKey123');
  const bareMarkers = editInput(empty, '[200~sk-abc-123[201~', {}, { singleLine: true });
  assert.equal(bareMarkers.state.text, 'sk-abc-123');
});

test('editing preserves graphemes, inserts at the cursor and ignores control shortcuts', () => {
  const state = { text: 'a\u0301界', cursor: 2 };
  assert.deepEqual(editInput(state, '', { backspace: true }).state, { text: '界', cursor: 0 });
  assert.equal(editInput(state, 'x', {}).state.text, 'a\u0301x界');
  assert.equal(editInput(state, '', { delete: true }).state.text, 'a\u0301');
  assert.equal(editInput(state, 'c', { ctrl: true }).state, state);
  assert.equal(editInput(state, '', { leftArrow: true }).state.cursor, 0);
  assert.equal(editInput(state, '', { rightArrow: true }).state.cursor, 3);
});

test('SelectMenu filters with exact/prefix priority, navigates skipping disabled items, selects on Enter and cancels on Esc', () => {
  const initial: TuiMenuState = {
    kind: 'login',
    title: 'Chọn provider',
    query: '',
    selectedIndex: 0,
    items: [
      { value: 'google-vertex', label: 'google-vertex (Vertex AI)', description: 'cloud' },
      { value: 'google', label: 'google (Google AI Studio)', description: 'API key' },
      { value: 'apple', label: 'apple (Apple)', description: 'unsupported', disabled: true },
    ],
  };

  // Exact match 'google' ranks before prefix match 'google-vertex'.
  const filtered = filterMenuItems(initial.items, 'google');
  assert.deepEqual(filtered.map((i) => i.value), ['google', 'google-vertex']);

  // Typing updates query and resets selectedIndex to 0.
  const typed = editMenuInput(initial, 'google', {});
  assert.equal(typed.state.query, 'google');
  assert.equal(typed.state.selectedIndex, 0);

  // Enter selects the top ranked match ('google').
  const chosen = editMenuInput(typed.state, '', { return: true });
  assert.equal(chosen.select, 'google');

  // Down arrow from index 1 in unfiltered list skips disabled item at index 2 and wraps to 0.
  const atOne = { ...initial, selectedIndex: 1 };
  const afterDown = editMenuInput(atOne, '', { downArrow: true });
  assert.equal(afterDown.state.selectedIndex, 0);

  // Escape cancels without selecting.
  const cancelled = editMenuInput(initial, '', { escape: true });
  assert.equal(cancelled.cancel, true);
  assert.equal(cancelled.select, undefined);

  // Windowing keeps selectedIndex visible inside maxVisible.
  const many = Array.from({ length: 20 }, (_, i) => ({ value: `m-${i}`, label: `Model ${i}` }));
  const win = windowMenuItems(many, 15, 8);
  assert.equal(win.slice.length, 8);
  assert.ok(win.start <= 15 && win.end > 15);
});
