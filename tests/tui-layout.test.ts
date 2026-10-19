// tests/tui-layout.test.ts - Terminal width, truncation and theme contracts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitFooterLine, truncate, visibleWidth } from '../src/tui/layout.js';
import { createTheme } from '../src/tui/theme.js';

test('truncation measures graphemes and preserves ANSI styles', () => {
  assert.equal(visibleWidth('a\u0301界'), 3);
  assert.equal(truncate('a\u0301界abc', 3), 'a\u0301…');
  const colored = '\u001b[31mabcdef\u001b[39m';
  assert.equal(visibleWidth(truncate(colored, 4)), 4);
  assert.ok(truncate(colored, 4).includes('\u001b[39m'));
  assert.equal(truncate(colored, 0), '');
  assert.equal(truncate('abc', 1), '…');
  assert.equal(truncate(colored, 6), colored);
});

test('footer removes lower priority content first without mutating its input', () => {
  const left = [
    { text: '/workspace/tinydb', compact: 'tinydb', priority: 3 },
    { text: 'main', priority: 2 }, { text: '!2', priority: 1 }, { text: 'abcdef', priority: 0 },
  ];
  const original = structuredClone(left);
  const line = fitFooterLine(left, '$0.01', 30);
  assert.equal(visibleWidth(line), 30);
  assert.ok(line.includes('main'));
  assert.ok(!line.includes('abcdef'));
  for (const width of [10, 20, 40, 80, 120]) {
    const output = fitFooterLine(left, '$0.01', width);
    assert.equal(visibleWidth(output), width);
    assert.ok(output.endsWith('$0.01'));
  }
  assert.deepEqual(left, original);
  assert.equal(fitFooterLine(left, '$0.01', 2), '$0.01');
});

test('NO_COLOR disables every semantic color and ASCII remains distinguishable', () => {
  const theme = createTheme({ env: { NO_COLOR: '', LANG: 'en_US.UTF-8' }, isTTY: true, icons: 'ascii' });
  for (const role of ['accent', 'muted', 'success', 'warning', 'error', 'userBg'] as const) {
    assert.equal(theme[role]('hello'), 'hello');
  }
  assert.notEqual(theme.icons.success, theme.icons.error);
  assert.equal(createTheme({ env: { TERM: 'dumb' }, isTTY: true }).icons.running, '*');
  assert.equal(createTheme({ isTTY: false }).icons.running, '*');
  assert.equal(createTheme({ icons: 'unicode' }).icons.success, '✓');
});
