// tests/tui-components.test.ts - Render terminal components at supported widths using Ink itself
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { Header } from '../src/tui/components/header.js';
import { Turn } from '../src/tui/components/transcript.js';
import { Editor } from '../src/tui/components/editor.js';
import { SelectMenu } from '../src/tui/components/select-menu.js';
import { ApprovalDialog } from '../src/tui/components/approval-dialog.js';
import { visibleWidth } from '../src/tui/layout.js';
import type { TuiTurn } from '../src/tui/store.js';

for (const columns of [40, 60, 80, 120]) test(`components render within ${columns} columns without overflowing`, () => {
  const header = renderToString(
    createElement(Header, { workspace: 'D:/workspace/tinydb', model: 'openrouter/qwen3-coder', mode: 'edit', width: columns }),
    { columns },
  );
  assert.match(header, /Axiom v0\.1/);
  assert.match(header, /\/login/);
  if (columns >= 80) {
    assert.match(header, /Welcome/);
    assert.match(header, /Commands/);
    assert.match(header, /\/help \/login \/model \/triage \/exit/);
  }
  assert.ok(header.split('\n').every((line) => visibleWidth(line) <= columns));

  const turn: TuiTurn = {
    id: 1,
    prompt: 'Read the repo\nand check tests',
    status: 'executing',
    text: '# Summary\n```ts\nconst x = 1;\n```\nReading',
    thinking: 'Inspecting files',
    usage: { promptTokens: 5600, completionTokens: 1200, totalTokens: 6800, costEstimate: 0.004 },
    telemetry: { ttftMs: 1200, tps: 42, durationMs: 29_700 },
    error: null,
    tools: [
      {
        call: { id: 'a', name: 'read_file', arguments: { path: 'file.ts' } },
        result: { toolCallId: 'a', name: 'read_file', output: 'full output\nline two', metadata: { durationMs: 100 } },
      },
      {
        call: { id: 'b', name: 'run_command', arguments: { command: 'cat .env' } },
        result: {
          toolCallId: 'b',
          name: 'run_command',
          output: 'blocked',
          isError: true,
          metadata: { policy: { verdict: 'deny', reason: 'secret file' } },
        },
      },
    ],
  };

  const collapsed = renderToString(createElement(Turn, { turn, expanded: false, width: columns }), { columns });
  assert.match(collapsed, /Read the repo/);
  assert.match(collapsed, /read_file/);
  assert.match(collapsed, /bị chặn/);
  assert.ok(!collapsed.includes('full output'));
  assert.ok(collapsed.split('\n').every((line) => visibleWidth(line) <= columns));

  const expanded = renderToString(createElement(Turn, { turn, expanded: true, width: columns }), { columns });
  assert.match(expanded, /full output/);
  assert.ok(expanded.split('\n').every((line) => visibleWidth(line) <= columns));

  const approval = renderToString(
    createElement(ApprovalDialog, {
      approval: { name: 'run_command', args: { command: 'pip install requests' }, reason: 'cài dependency' },
      width: columns,
    }),
    { columns },
  );
  assert.match(approval, /Cần duyệt/);
  assert.ok(approval.split('\n').every((line) => visibleWidth(line) <= columns));

  const multilineEditor = renderToString(
    createElement(Editor, {
      value: { text: 'first line\nsecond line', cursor: 22 },
      width: columns,
      onChange() {},
      onSubmit() {},
    }),
    { columns },
  );
  assert.match(multilineEditor, /first line/);
  assert.match(multilineEditor, /second line/);
  assert.ok(multilineEditor.split('\n').every((line) => visibleWidth(line) <= columns));

  const secret = renderToString(
    createElement(Editor, {
      value: { text: 'private-value', cursor: 13 },
      secret: true,
      width: columns,
      onChange() {},
      onSubmit() {},
    }),
    { columns },
  );
  assert.ok(!secret.includes('private-value'));
  assert.ok(secret.split('\n').every((line) => visibleWidth(line) <= columns));

  const selector = renderToString(
    createElement(SelectMenu, {
      menu: {
        kind: 'model',
        title: 'Chọn model cho phiên làm việc',
        placeholder: 'Gõ để lọc...',
        query: '',
        selectedIndex: 0,
        items: [
          {
            value: 'google/gemini-3.1-flash-lite',
            label: 'google/gemini-3.1-flash-lite',
            description: 'Gemini 3.1 Flash Lite · 1M · $0.25/$1.5 · khuyên dùng',
            badge: 'đang dùng',
            active: true,
          },
          {
            value: 'openrouter/qwen3-coder',
            label: 'openrouter/qwen3-coder',
            description: 'Qwen 3 Coder · 256k · $0.2/$0.8',
            badge: 'connected',
          },
        ],
      },
      width: columns,
      onChange() {},
      onSelect() {},
      onCancel() {},
    }),
    { columns },
  );
  assert.match(selector, /gemini-3\.1-flash-lite/);
  assert.ok(selector.split('\n').every((line) => visibleWidth(line) <= columns));

  const longStreamingTurn: TuiTurn = {
    ...turn,
    text: Array.from({ length: 25 }, (_, i) => `Line ${i + 1} of streaming response`).join('\n'),
  };
  const clippedLive = renderToString(
    createElement(Turn, { turn: longStreamingTurn, expanded: false, width: columns, maxLines: 6 }),
    { columns },
  );
  assert.match(clippedLive, /\+19 dòng phía trên/);
  assert.ok(!clippedLive.includes('Line 1 of streaming response'));
  assert.match(clippedLive, /Line 25 of streaming response/);
});
