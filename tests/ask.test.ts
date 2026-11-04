import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { answerQuestion, NOT_FOUND_TEXT, type AskOptions } from '../src/agents/ask.js';
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
  it('answer keeps only validated citations', needsPython, async () => {
    const bad = 'Insert is at db/table.py:L4-L6 and db/nowhere.py:L1-L2.';
    const provider = new MockProvider('mock', [bad, bad]);
    const answer = await answerQuestion('Where is insert?', options(provider));
    assert.equal(answer.found, true);
    assert.deepEqual(answer.citations, [{ path: 'db/table.py', startLine: 4, endLine: 6 }]);
    assert.match(answer.text, /db\/nowhere\.py:L1-L2: file not found/);
    assert.match(answer.text.split('\n').at(-1) ?? '', /Đã bỏ 1 trích dẫn/);
  });

  it('invalid citation triggers exactly one retry', needsPython, async () => {
    const provider = new MockProvider('mock', ['See db/table.py:L4-L40.', 'See db/table.py:L4-L6.', 'never used']);
    const tracker = new CostTracker();
    const answer = await answerQuestion('Where is insert?', options(provider, tracker));
    assert.equal(provider.callHistory.length, 2);
    assert.match(provider.callHistory[1].messages.at(-1)?.content ?? '', /db\/table\.py:L4-L40: line out of range/);
    assert.deepEqual(answer, { text: 'See db/table.py:L4-L6.', citations: [{ path: 'db/table.py', startLine: 4, endLine: 6 }], found: true });
    assert.equal(tracker.getSessionSummary().byModel['mock-model'].calls, 2);

    const stubborn = new MockProvider('mock', ['db/table.py:L99-L100', 'db/table.py:L99-L100', 'never used']);
    const failed = await answerQuestion('Where is insert?', options(stubborn));
    assert.equal(stubborn.callHistory.length, 2);
    assert.deepEqual(failed, { text: NOT_FOUND_TEXT, citations: [], found: false });
  });

  it('the prompt carries each chunk with its path and line range', needsPython, async () => {
    const provider = new MockProvider('mock', ['db/table.py:L4-L6']);
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

  it('fileLink wraps the citation in OSC 8', () => {
    const c = { path: 'db/table.py', startLine: 4, endLine: 6 };
    const url = `${pathToFileURL(path.resolve(root, 'db/table.py')).href}#L4`;
    assert.equal(fileLink(root, c), `\x1b]8;;${url}\x1b\\db/table.py:L4-L6\x1b]8;;\x1b\\`);
    assert.equal(linkCitations('a db/table.py:L4-6 b db/table.py:L8-L9', root, [c]), `a ${fileLink(root, c)} b db/table.py:L8-L9`);
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
