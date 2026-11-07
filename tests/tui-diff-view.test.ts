// tests/tui-diff-view.test.ts - DiffView, FixProgress and the fix-report renderer (C7)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'ink';
import type { FixReport, FixRound } from '../src/agents/fix.js';
import { DiffView, diffLineKind } from '../src/tui/components/diff-view.js';
import { FixProgress, formatRoundLine } from '../src/tui/components/fix-progress.js';
import { FixReportView, fixReportSchema } from '../src/tui/components/fix-report.js';
import { visibleWidth } from '../src/tui/layout.js';

const PATCH = [
  '--- a/tinydb/operations.py',
  '+++ b/tinydb/operations.py',
  '@@ -40,2 +40,2 @@',
  '     def transform(doc: MutableMapping):',
  '-        doc[field] += n',
  '+        doc[field] -= n',
  '',
].join('\n');

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';

/** createTheme() colors only a TTY; pretend stdout is one for the color assertions. */
function withColor(t: test.TestContext): void {
  const saved = { isTTY: process.stdout.isTTY, noColor: process.env.NO_COLOR, term: process.env.TERM };
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  delete process.env.NO_COLOR;
  process.env.TERM = 'xterm-256color';
  t.after(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: saved.isTTY, configurable: true });
    if (saved.noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved.noColor;
    if (saved.term === undefined) delete process.env.TERM;
    else process.env.TERM = saved.term;
  });
}

const lineOf = (output: string, text: string) => output.split('\n').find((l) => l.includes(text)) ?? '';
const render = (el: Parameters<typeof renderToString>[0], columns: number) => renderToString(el, { columns });

test('added and removed lines are colored', (t) => {
  withColor(t);
  const output = render(createElement(DiffView, { patch: PATCH, width: 80 }), 80);
  assert.ok(lineOf(output, '+        doc[field] -= n').includes(GREEN), 'added line is green');
  assert.ok(lineOf(output, '-        doc[field] += n').includes(RED), 'removed line is red');
  assert.ok(lineOf(output, '@@ -40,2 +40,2 @@').includes(DIM), 'hunk header is gray');
  for (const header of ['--- a/tinydb/operations.py', '+++ b/tinydb/operations.py']) {
    const line = lineOf(output, header);
    assert.ok(!line.includes(GREEN) && !line.includes(RED), `${header} is a file header, not a change`);
  }
  assert.ok(!lineOf(output, 'def transform').includes(GREEN) && !lineOf(output, 'def transform').includes(RED));
});

test('without color the +/- markers still tell the lines apart', () => {
  const output = render(createElement(DiffView, { patch: PATCH, width: 80 }), 80);
  assert.ok(!output.includes('\u001b['), 'no ANSI when stdout is not a TTY');
  assert.match(output, /^\+ {8}doc\[field\] -= n$/m);
  assert.match(output, /^- {8}doc\[field\] \+= n$/m);
});

test('long diffs are truncated with a count', () => {
  const body = Array.from({ length: 50 }, (_, i) => `+line ${i}`);
  const patch = ['--- /dev/null', '+++ b/tests/test_x.py', '@@ -0,0 +1,50 @@', ...body].join('\n');
  const output = render(createElement(DiffView, { patch, width: 80 }), 80).split('\n');
  assert.equal(output.length, 41, '40 lines plus the count');
  assert.equal(output.at(-1), '… 13 dòng nữa');
  assert.equal(output[39], '+line 36');
  const short = render(createElement(DiffView, { patch, width: 80, maxLines: 5 }), 80).split('\n');
  assert.equal(short.at(-1), '… 48 dòng nữa');
});

test('diff lines are cut to the width, tabs and CRLF included', () => {
  const patch = `@@ -1 +1 @@\r\n-\t${'x'.repeat(200)}\r\n+${'é'.repeat(200)}\r\n`;
  for (const width of [40, 80]) {
    const output = render(createElement(DiffView, { patch, width }), width).split('\n');
    assert.equal(output.length, 3);
    assert.ok(output.every((l) => visibleWidth(l) <= width), `fits ${width} columns`);
    assert.ok(output[1].endsWith('…') && output[1].startsWith('-    x'), 'tab expanded, line cut with …');
  }
});

test('diffLineKind tells file headers from changed lines', () => {
  assert.equal(diffLineKind('--- a/x.py'), 'file');
  assert.equal(diffLineKind('+++ b/x.py'), 'file');
  assert.equal(diffLineKind('---x'), 'removed');
  assert.equal(diffLineKind('+++x'), 'added');
  assert.equal(diffLineKind('@@ -1 +1 @@'), 'hunk');
  assert.equal(diffLineKind(' ctx'), 'context');
});

const ROUNDS: FixRound[] = [
  { round: 1, hypothesis: 'Query.__le__ in tinydb/queries.py compares with < so the boundary value is dropped, and this sentence goes on well past eighty columns.\nSecond line.', patchApplied: true, testsPassed: 210, testsFailed: 1, regressions: ['tests/test_queries.py::test_lt (failed)'] },
  { round: 2, hypothesis: 'no patch could be applied', patchApplied: false, testsPassed: 0, testsFailed: 0, regressions: [] },
  { round: 3, hypothesis: 'Query.__le__ uses < instead of <=.', patchApplied: true, testsPassed: 211, testsFailed: 0, regressions: [] },
];

test('fix progress fits in 80 columns', () => {
  for (const width of [80, 120]) {
    const output = render(createElement(FixProgress, { rounds: ROUNDS, maxRounds: 5, width }), width).split('\n');
    assert.equal(output.length, 3, 'one line per round; the hypothesis is cut to its first line');
    assert.ok(output.every((l) => visibleWidth(l) <= width), `fits ${width} columns`);
    assert.match(output[0], /^x Vòng 1\/5 - passed 210, failed 1, regressions 1 - Query\.__le__/);
    assert.match(output[1], /^x Vòng 2\/5 - không áp được patch - no patch/);
    assert.match(output[2], /^\+ Vòng 3\/5 - passed 211, failed 0 - Query\.__le__ uses < instead of <=\.$/);
  }
  assert.ok(render(createElement(FixProgress, { rounds: ROUNDS, maxRounds: 5, width: 80 }), 80).split('\n')[0].endsWith('…'));
});

test('a round line follows the plan format', () => {
  assert.equal(formatRoundLine(ROUNDS[2], 5), 'Vòng 3/5 · passed 211, failed 0 · Query.__le__ uses < instead of <=.');
});

const REPORT: FixReport = {
  status: 'fixed',
  rounds: [ROUNDS[2]],
  filesChanged: ['tinydb/operations.py'],
  diffStat: { files: 1, added: 1, removed: 1 },
  summary: 'Fixed in round 3. Cause: subtract adds n.',
  patch: PATCH,
};

test('the fix-report renderer shows status, rounds, the real diff and the summary', () => {
  for (const width of [80, 120]) {
    const output = render(createElement(FixReportView, { report: fixReportSchema.parse(REPORT), width }), width);
    const lines = output.split('\n');
    assert.match(lines[0], /^\+ fixed - 1 file, \+1 -1$/);
    assert.match(output, /Vòng 3\/5/);
    assert.match(output, /^- {8}doc\[field\] \+= n$/m);
    assert.match(output, /^\+ {8}doc\[field\] -= n$/m);
    assert.match(output, /Fixed in round 3/);
    assert.ok(lines.every((l) => visibleWidth(l) <= width), `fits ${width} columns`);
  }
});

test('a report without a patch draws no diff, and malformed data is rejected', () => {
  const output = render(createElement(FixReportView, { report: { ...REPORT, status: 'failed', patch: '' }, width: 80 }), 80);
  assert.match(output, /^x failed/);
  assert.doesNotMatch(output, /doc\[field\]/);
  assert.equal(fixReportSchema.safeParse({ status: 'fixed' }).success, false);
  assert.equal(fixReportSchema.safeParse({ ...REPORT, patch: undefined }).success, true, 'reports from before C7 still draw');
});
