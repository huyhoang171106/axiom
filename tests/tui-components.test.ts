// tests/tui-components.test.ts - Render terminal components at supported widths using Ink itself
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { Header } from '../src/tui/components/header.js';
import { Turn } from '../src/tui/components/transcript.js';
import { Editor } from '../src/tui/components/editor.js';
import { visibleWidth } from '../src/tui/layout.js';
import type { TuiTurn } from '../src/tui/store.js';

for (const columns of [80, 120]) test(`components render at ${columns} columns`, () => {
  const header = renderToString(createElement(Header, { workspace: 'D:/workspace/tinydb', model: 'test/model' }), { columns });
  assert.match(header, /Axiom/);
  assert.match(header, /\/login/);
  assert.ok(header.split('\n').every(line => visibleWidth(line) <= columns));
  const turn: TuiTurn = { id: 1, prompt: 'Read the repo', status: 'executing', text: 'Reading', thinking: 'Inspecting files', usage: null, error: null,
    tools: [{ call: { id: 'a', name: 'read_file', arguments: { path: 'file.ts' } }, result: { toolCallId: 'a', name: 'read_file', output: 'full output' } }] };
  const collapsed = renderToString(createElement(Turn, { turn, expanded: false, width: columns }), { columns });
  assert.match(collapsed, /Read the repo/);
  assert.match(collapsed, /read_file/);
  assert.ok(!collapsed.includes('full output'));
  assert.match(renderToString(createElement(Turn, { turn, expanded: true, width: columns }), { columns }), /full output/);
  const secret = renderToString(createElement(Editor, { value: { text: 'private-value', cursor: 13 }, secret: true, onChange() {}, onSubmit() {} }), { columns });
  assert.ok(!secret.includes('private-value'));
});
