import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { answerQuestion, NOT_FOUND_TEXT, RERANK_PROMPT, rerankedSearch, REWRITE_PROMPT, type AskOptions } from '../src/agents/ask.js';
import type { RepoIndex } from '../src/core/rag/index.js';
import type { ScoredChunk } from '../src/core/rag/types.js';
import { askCommand } from '../src/commands/ask.js';
import type { CommandContext } from '../src/commands/types.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { createExecutionContext } from '../src/core/execution-context.js';
import { pythonBin } from '../src/core/paths.js';
import { fileLink } from '../src/core/rag/citations.js';
import { fakeEmbedder, MISSING_EMBED_MESSAGE } from '../src/core/rag/embedder.js';
import { linkCitations } from '../src/tui/components/citation.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { fakeUI } from './fake-ui.js';

const hasPython = !spawnSync(pythonBin(), ['-c', 'import ast'], { windowsHide: true }).error;
const needsPython = { skip: !hasPython && 'needs python' };

const TABLE = [
  'class Table:',                                   // 1
  '    """Stores documents."""',                    // 2
  '',                                               // 3
  '    def insert(self, document):',                // 4
  '        """Insert a new document into the table."""', // 5
  '        return self._write(document)',           // 6
  '',                                               // 7
  '    def remove(self, cond):',                    // 8
  '        """Remove documents matching a condition."""', // 9
  '        return self._delete(cond)',              // 10
].join('\n');

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ask-'));
  fs.mkdirSync(path.join(root, 'db'));
  fs.writeFileSync(path.join(root, 'db/table.py'), `${TABLE}\n`);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function options(provider: MockProvider, tracker = new CostTracker()): AskOptions {
  return { workspaceRoot: root, provider, model: 'mock-model', embedder: fakeEmbedder(), costTracker: tracker, indexDir: path.join(root, '.idx') };
}

describe('ask', () => {
  it('answer keeps only validated citations and shows none of the failed ones', needsPython, async () => {
    const bad = 'Insert is at db/table.py:L4-L6 and db/nowhere.py:L1-L2.\nRemove lives in db/gone.py:L1-L3.';
    const provider = new MockProvider('mock', [bad, bad]);
    const answer = await answerQuestion('Where is insert?', options(provider));
    assert.equal(answer.found, true);
    assert.deepEqual(answer.citations, [{ path: 'db/table.py', startLine: 4, endLine: 6 }]);
    assert.doesNotMatch(answer.text, /nowhere|gone/, 'failed citations are not in the shown text');
    assert.doesNotMatch(answer.text, /Remove lives/, 'a line left without any valid citation is dropped with its claim');
    assert.match(answer.text, /^Insert is at db\/table\.py:L4-L6/);
    assert.match(answer.text.split('\n').at(-1) ?? '', /Đã bỏ 2 trích dẫn/);
  });

  it('a citation in a sentence about something else is rejected', needsPython, async () => {
    const offTopic = 'Searching uses a regex, see db/table.py:L4-L6.';
    const provider = new MockProvider('mock', [offTopic, offTopic]);
    const answer = await answerQuestion('Where is insert?', options(provider));
    assert.match(provider.callHistory[1].messages.at(-1)?.content ?? '', /db\/table\.py:L4-L6: cited lines do not mention what the sentence says/);
    assert.deepEqual(answer, { text: NOT_FOUND_TEXT, citations: [], found: false });
  });

  it('invalid citation triggers exactly one retry', needsPython, async () => {
    const provider = new MockProvider('mock', ['Insert is in db/table.py:L4-L40.', 'Insert is in db/table.py:L4-L6.', 'never used']);
    const tracker = new CostTracker();
    const answer = await answerQuestion('Where is insert?', options(provider, tracker));
    assert.equal(provider.callHistory.length, 2);
    assert.match(provider.callHistory[1].messages.at(-1)?.content ?? '', /db\/table\.py:L4-L40: line out of range/);
    assert.deepEqual(answer, { text: 'Insert is in db/table.py:L4-L6.', citations: [{ path: 'db/table.py', startLine: 4, endLine: 6 }], found: true });
    assert.equal(tracker.getSessionSummary().byModel['mock-model'].calls, 2);

    const stubborn = new MockProvider('mock', ['db/table.py:L99-L100', 'db/table.py:L99-L100', 'never used']);
    const failed = await answerQuestion('Where is insert?', options(stubborn));
    assert.equal(stubborn.callHistory.length, 2);
    assert.deepEqual(failed, { text: NOT_FOUND_TEXT, citations: [], found: false });
  });

  it('the prompt carries each chunk with its path and line range', needsPython, async () => {
    const provider = new MockProvider('mock', ['Insert is in db/table.py:L4-L6']);
    await answerQuestion('Where is insert?', options(provider));
    assert.match(provider.callHistory[0].messages[1].content, /### db\/table\.py:L4-L6 \(Table\.insert\)\n    def insert/);
    assert.match(provider.callHistory[0].messages[0].content, new RegExp(NOT_FOUND_TEXT));
  });

  it('a not-found reply from the model is returned as not found', needsPython, async () => {
    const provider = new MockProvider('mock', [NOT_FOUND_TEXT]);
    assert.deepEqual(await answerQuestion('Where is insert?', options(provider)), { text: NOT_FOUND_TEXT, citations: [], found: false });
    assert.equal(provider.callHistory.length, 1);
  });

  it('no relevant chunk returns not found without a model call', needsPython, async () => {
    const provider = new MockProvider('mock', ['db/table.py:L4-L6']);
    const answer = await answerQuestion('Thời tiết Hà Nội hôm nay thế nào?', options(provider));
    assert.deepEqual(answer, { text: NOT_FOUND_TEXT, citations: [], found: false });
    assert.equal(provider.callHistory.length, 0);
  });

  it('team docs are searched, cited with team: and linked under the team dir', needsPython, async () => {
    const team = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ask-team-'));
    try {
      fs.writeFileSync(path.join(team, 'rules.md'), '# Tests\nnever edit existing tests to make them pass\n');
      const provider = new MockProvider('mock', ['Existing tests must not be edited to pass: team:rules.md:L1-L2.']);
      const answer = await answerQuestion('Can I edit existing tests?', { ...options(provider), teamDir: team });
      assert.match(provider.callHistory[0].messages[1].content, /### team:rules\.md:L1-L2 \(Tests\)/);
      assert.deepEqual(answer.citations, [{ path: 'rules.md', startLine: 1, endLine: 2, source: 'team' }]);
      const link = fileLink(root, answer.citations[0], team);
      assert.ok(link.includes(`${pathToFileURL(path.join(team, 'rules.md')).href}#L1`) && link.includes('team:rules.md:L1-L2'));
    } finally {
      fs.rmSync(team, { recursive: true, force: true });
    }
  });

  it('fileLink wraps the citation in OSC 8', () => {
    const c = { path: 'db/table.py', startLine: 4, endLine: 6 };
    const url = `${pathToFileURL(path.resolve(root, 'db/table.py')).href}#L4`;
    assert.equal(fileLink(root, c), `\x1b]8;;${url}\x1b\\db/table.py:L4-L6\x1b]8;;\x1b\\`);
    assert.equal(linkCitations('a db/table.py:L4-6 b db/table.py:L8-L9', root, [c]), `a ${fileLink(root, c)} b db/table.py:L8-L9`);
    assert.equal(linkCitations('x team:db/table.py:L4-L6', root, [c]), 'x team:db/table.py:L4-L6', 'a team citation never links to the repo file of the same path');
  });

  it('the command without modelRoles.embed fails with the fix', async () => {
    const ui = fakeUI(['Where is insert?']);
    const ctx: CommandContext = {
      ...createExecutionContext(),
      config: { ...DEFAULT_CONFIG, modelRoles: {} },
      workspaceRoot: root,
      ui,
      signal: new AbortController().signal,
      session: { model: {} as ModelInfo, setModel() {} },
    };
    await assert.rejects(askCommand.run('  ', ctx), { message: MISSING_EMBED_MESSAGE });
    assert.deepEqual(ui.asked, ['Question: ']);
  });
});

describe('rerankedSearch', () => {
  const chunk = (id: string, score: number): ScoredChunk => ({
    id: `db/${id}.py:1-2`, path: `db/${id}.py`, symbol: id, kind: 'function', startLine: 1, endLine: 2, fileType: 'python', text: `def ${id}():\n    pass`, score,
  });
  const [a, b, c, d] = [chunk('a', 0.6), chunk('b', 0.5), chunk('c', 0.4), chunk('d', 0.3)];
  function fakeIndex(results: Record<string, ScoredChunk[]>): { index: RepoIndex; searched: string[] } {
    const searched: string[] = [];
    const index = { search: async (query: string) => { searched.push(query); return results[query] ?? []; } } as unknown as RepoIndex;
    return { index, searched };
  }
  function scripted(rewrite: string, rerank: string): MockProvider {
    const provider = new MockProvider('mock');
    provider.setHandler((params) => (params.messages[0].content === REWRITE_PROMPT ? rewrite : params.messages[0].content === RERANK_PROMPT ? rerank : 'unexpected'));
    return provider;
  }

  it('searches every rewritten query and returns the reranked picks first', async () => {
    const { index, searched } = fakeIndex({ q: [a, b], 'sub one': [c, a], 'sub two': [d] });
    const provider = scripted('1. sub one\n- sub two', '3, 4, 1');
    const tracker = new CostTracker();
    const top = await rerankedSearch('q', index, { provider, model: 'mock-model', costTracker: tracker });
    assert.deepEqual(searched, ['q', 'sub one', 'sub two']);
    assert.deepEqual(top.map((x) => x.symbol), ['c', 'd', 'a', 'b']);
    assert.match(provider.callHistory[1].messages[1].content, /\[3\] db\/c\.py:L1-L2 \(c\)\ndef c\(\):/);
    assert.equal(tracker.getSessionSummary().byModel['mock-model'].calls, 2);
  });

  it('an unreadable rerank reply keeps the order of the first search', async () => {
    const { index } = fakeIndex({ q: [a, b], other: [c] });
    const top = await rerankedSearch('q', index, { provider: scripted('other', 'none of them'), model: 'mock-model', costTracker: new CostTracker() });
    assert.deepEqual(top.map((x) => x.symbol), ['a', 'b']);
  });

  it('a question with no relevant chunk costs no model call', async () => {
    const { index, searched } = fakeIndex({ q: [chunk('weak', 0.1)] });
    const provider = scripted('other', '1');
    const top = await rerankedSearch('q', index, { provider, model: 'mock-model', costTracker: new CostTracker() });
    assert.deepEqual(top.map((x) => x.symbol), ['weak']);
    assert.deepEqual(searched, ['q']);
    assert.equal(provider.callHistory.length, 0);
  });

  it('answerQuestion answers from the chunks that retrieve returns', needsPython, async () => {
    const provider = new MockProvider('mock');
    provider.setHandler(() => 'Remove is at db/table.py:L8-L10.');
    const answer = await answerQuestion('Where is insert?', {
      ...options(provider),
      retrieve: async (_q, index) => (await index.search('remove', 5)).filter((x) => x.symbol === 'Table.remove'),
    });
    assert.match(provider.callHistory[0].messages[1].content, /\(Table\.remove\)/);
    assert.doesNotMatch(provider.callHistory[0].messages[1].content, /\(Table\.insert\)/);
    assert.deepEqual(answer.citations, [{ path: 'db/table.py', startLine: 8, endLine: 10 }]);
  });
});
