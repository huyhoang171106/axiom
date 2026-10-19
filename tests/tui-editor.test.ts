// tests/tui-editor.test.ts - Editing without splitting Unicode characters
import test from 'node:test';
import assert from 'node:assert/strict';
import { editInput } from '../src/tui/editor.js';

test('Enter submits, while Alt+Enter and backslash Enter insert newlines', () => {
  const state = { text: 'hello', cursor: 5 };
  assert.equal(editInput(state, '', { return: true }).submit, 'hello');
  assert.equal(editInput(state, '', { return: true, meta: true }).state.text, 'hello\n');
  assert.equal(editInput({ text: 'hello\\', cursor: 6 }, '', { return: true }).state.text, 'hello\n');
  assert.equal(editInput({ text: '  ', cursor: 2 }, '', { return: true }).submit, undefined);
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
