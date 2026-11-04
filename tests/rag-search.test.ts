import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { pythonBin } from '../src/core/paths.js';
import { Bm25, tokenize } from '../src/core/rag/bm25.js';
import { createEmbedder, embedderFromConfig, fakeEmbedder, MISSING_EMBED_MESSAGE } from '../src/core/rag/embedder.js';
import { RepoIndex } from '../src/core/rag/index.js';
import type { Embedder } from '../src/core/rag/types.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { ProviderError } from '../src/llm/provider-error.js';
import { startFakeServer } from './fake-server.js';

const hasPython = !spawnSync(pythonBin(), ['-c', 'import ast'], { windowsHide: true }).error;
const needsPython = { skip: !hasPython && 'needs python' };

let home: string;
const savedHome = process.env.AXIOM_HOME;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-search-home-'));
  process.env.AXIOM_HOME = home;
});
after(() => {
  if (savedHome === undefined) delete process.env.AXIOM_HOME;
  else process.env.AXIOM_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function tempRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-search-repo-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const REPO = {
  'db/table.py': [
    'class Table:',
    '    """Stores documents."""',
    '',
    '    def insert(self, document):',
    '        """Insert a new document into the table."""',
    '        return self._write(document)',
    '',
    '    def remove(self, cond):',
    '        """Remove documents matching a condition."""',
    '        return self._delete(cond)',
  ].join('\n'),
  'db/storage.py': 'def write_json(path, data):\n    """Write data to a JSON file."""\n    return open(path, "w").write(data)\n',
  'README.md': '# Tiny\n\nA small document database.\n',
};

function model(api: ModelInfo['api'], baseUrl: string, provider = 'openai'): ModelInfo {
  return { provider, id: 'embed-test', name: 'embed-test', api, baseUrl, contextWindow: 8192, reasoning: false, input: ['text'] };
}

describe('rag search', () => {
  it('splits identifiers into lower-case words and drops one-character tokens', () => {
    assert.deepEqual(tokenize('insertMultiple read_JSON a HTTPServer'), ['insert', 'multiple', 'read', 'json', 'http', 'server']);
  });

  it('query with a symbol name ranks that chunk first', needsPython, async () => {
    const root = tempRepo(REPO);
    try {
      const index = await RepoIndex.open(root, fakeEmbedder(), { dir: path.join(root, '.idx') });
      const hits = await index.search('Where is insert?', 3);
      assert.equal(hits[0].symbol, 'Table.insert');
      assert.equal(hits[0].path, 'db/table.py');
      assert.ok(hits[0].score > hits[1].score);
      assert.equal((await index.search('anything', 10)).length, 5, 'k caps the result, here at the 5 chunks the repo has');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('bm25 favors rare terms', () => {
    const bm25 = new Bm25([
      { id: 'a', text: 'table table rare' },
      { id: 'b', text: 'table table common' },
      { id: 'c', text: 'table common common' },
    ]);
    const rare = bm25.score('rare');
    const common = bm25.score('common');
    assert.deepEqual([...rare.keys()], ['a']);
    assert.ok(rare.get('a')! > common.get('b')!, 'one hit of a rare term outweighs one hit of a common term');
    assert.ok(bm25.score('table').get('a')! < rare.get('a')!);
  });

  it('ollama api posts to /api/embed', async () => {
    const server = await startFakeServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ embeddings: [[1, 0], [0, 1]], prompt_eval_count: 7 }));
    });
    try {
      const tracker = new CostTracker();
      const embed = createEmbedder(model('ollama-chat', `${server.url}/`, 'ollama'), { costTracker: tracker });
      assert.deepEqual(await embed(['a', 'b']), [[1, 0], [0, 1]]);
      assert.equal(server.seen[0].url, '/api/embed');
      assert.deepEqual(JSON.parse(server.seen[0].body.toString()), { model: 'embed-test', input: ['a', 'b'] });
      assert.equal(tracker.getSessionSummary().totalPromptTokens, 7);
    } finally {
      await server.close();
    }
  });

  it('openai-compatible api posts to /embeddings with bearer key', async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'fake-embed-key-123';
    const server = await startFakeServer((req, res) => {
      const { input } = JSON.parse(req.body.toString()) as { input: string[] };
      res.setHeader('content-type', 'application/json');
      // Reversed on purpose: the embedder must order by `index`, not by position.
      res.end(JSON.stringify({ data: input.map((_, i) => ({ index: i, embedding: [i] })).reverse(), usage: { prompt_tokens: 3 } }));
    });
    try {
      const embed = createEmbedder(model('openai-completions', `${server.url}/v1`));
      const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);
      const vectors = await embed(texts);
      assert.deepEqual(vectors.map((v) => v[0]), [...Array.from({ length: 64 }, (_, i) => i), ...Array.from({ length: 6 }, (_, i) => i)]);
      assert.equal(server.seen.length, 2, 'sent in batches of 64');
      assert.equal(server.seen[0].url, '/v1/embeddings');
      assert.equal(server.seen[0].headers.authorization, 'Bearer fake-embed-key-123');
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
      await server.close();
    }
  });

  it('http errors become a ProviderError without the key', async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'fake-embed-key-456';
    const server = await startFakeServer((_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'bad key fake-embed-key-456' } }));
    });
    try {
      const embed = createEmbedder(model('openai-completions', server.url));
      await assert.rejects(embed(['x']), (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.status, 401);
        assert.doesNotMatch(error.message, /fake-embed-key-456/);
        return true;
      });
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
      await server.close();
    }
  });

  it('missing modelRoles.embed throws a fix-it message', () => {
    assert.throws(() => embedderFromConfig({ ...DEFAULT_CONFIG, modelRoles: { default: 'openai/gpt-4o' } }), { message: MISSING_EMBED_MESSAGE });
  });

  it('changing embed model rebuilds the index', needsPython, async () => {
    const root = tempRepo(REPO);
    const dir = path.join(root, '.idx');
    let embedded = 0;
    const counting: Embedder = async (texts) => {
      embedded += texts.length;
      return fakeEmbedder()(texts);
    };
    try {
      const first = await RepoIndex.open(root, counting, { dir, embedModel: 'model-a' });
      await first.update();
      const chunkCount = embedded;
      assert.ok(chunkCount > 0);

      const same = await RepoIndex.open(root, counting, { dir, embedModel: 'model-a' });
      assert.deepEqual(await same.update(), { added: [], changed: [], removed: [] });

      embedded = 0;
      const other = await RepoIndex.open(root, counting, { dir, embedModel: 'model-b' });
      const diff = await other.update();
      assert.deepEqual(diff.added.sort(), ['README.md', 'db/storage.py', 'db/table.py']);
      assert.equal(embedded, chunkCount, 'every chunk embedded again');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).embedModel, 'model-b');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('vectors of another dimension rebuild the index', needsPython, async () => {
    const root = tempRepo(REPO);
    const dir = path.join(root, '.idx');
    try {
      await (await RepoIndex.open(root, fakeEmbedder(64), { dir })).update();
      const hits = await (await RepoIndex.open(root, fakeEmbedder(32), { dir })).search('insert', 1);
      assert.equal(hits[0].symbol, 'Table.insert');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).dim, 32);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
