import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pythonBin } from '../src/core/paths.js';
import { fakeEmbedder } from '../src/core/rag/embedder.js';
import { RepoIndex } from '../src/core/rag/index.js';
import type { Embedder } from '../src/core/rag/types.js';

const hasPython = !spawnSync(pythonBin(), ['-c', 'import ast'], { windowsHide: true }).error;
const needsPython = { skip: !hasPython && 'needs python' };

let root: string;
let embeddedTexts: string[];
const counting: Embedder = async (texts) => {
  embeddedTexts.push(...texts);
  return fakeEmbedder()(texts);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-incremental-'));
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.writeFileSync(path.join(root, 'pkg/alpha.py'), 'def alpha():\n    return "first version"\n');
  fs.writeFileSync(path.join(root, 'pkg/beta.py'), 'def beta():\n    return 2\n\ndef gamma():\n    return 3\n');
  embeddedTexts = [];
});
afterEach(() => {
  mock.timers.reset();
  fs.rmSync(root, { recursive: true, force: true });
});

const open = () => RepoIndex.open(root, counting, { dir: path.join(root, '.idx'), embedModel: 'fake' });

describe('rag incremental index', () => {
  it('editing one file re-embeds only that file', needsPython, async () => {
    const index = await open();
    assert.deepEqual((await index.update()).added.sort(), ['pkg/alpha.py', 'pkg/beta.py']);
    embeddedTexts = [];
    fs.writeFileSync(path.join(root, 'pkg/alpha.py'), 'def alpha():\n    return "second version"\n');
    assert.deepEqual(await index.update(), { added: [], changed: ['pkg/alpha.py'], removed: [] });
    assert.equal(embeddedTexts.length, 1);
    assert.match(embeddedTexts[0], /second version/);
  });

  it('deleted file chunks disappear from search', needsPython, async () => {
    const index = await open();
    await index.update();
    fs.rmSync(path.join(root, 'pkg/beta.py'));
    assert.deepEqual(await index.update(), { added: [], changed: [], removed: ['pkg/beta.py'] });
    const hits = await index.search('beta gamma', 10);
    assert.deepEqual([...new Set(hits.map((h) => h.path))], ['pkg/alpha.py']);
    const reopened = await open();
    assert.deepEqual(await reopened.update(), { added: [], changed: [], removed: [] }, 'the removal was saved to disk');
  });

  it('question after an edit returns the new content', needsPython, async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const index = await open();
    assert.match((await index.search('alpha', 1))[0].text, /first version/);
    fs.writeFileSync(path.join(root, 'pkg/alpha.py'), 'def alpha():\n    return "edited version"\n');
    mock.timers.tick(2001);
    assert.match((await index.search('alpha', 1))[0].text, /edited version/);
  });

  it('unchanged repo embeds nothing on update', needsPython, async () => {
    await (await open()).update();
    embeddedTexts = [];
    const index = await open();
    assert.deepEqual(await index.update(), { added: [], changed: [], removed: [] });
    await index.search('alpha');
    assert.deepEqual(embeddedTexts, ['alpha'], 'only the query itself is embedded');
  });

  it('publishes the whole index as one file without leaving temp files', needsPython, async () => {
    await (await open()).update();
    assert.deepEqual(fs.readdirSync(path.join(root, '.idx')), ['index.json']);
  });
});

describe('rag index crash safety', () => {
  const indexFile = () => path.join(root, '.idx', 'index.json');
  const editAlpha = () => fs.writeFileSync(path.join(root, 'pkg/alpha.py'), 'def alpha():\n    return "second version"\n');

  it('a crash before the rename keeps the previous index whole', needsPython, async () => {
    await (await open()).update();
    const before = fs.readFileSync(indexFile(), 'utf8');
    editAlpha();
    const rename = mock.method(fs, 'renameSync', () => {
      throw new Error('simulated crash');
    });
    try {
      await assert.rejects((await open()).update(), /simulated crash/);
    } finally {
      rename.mock.restore();
    }
    assert.equal(fs.readFileSync(indexFile(), 'utf8'), before, 'the published index is untouched');
    assert.deepEqual(fs.readdirSync(path.join(root, '.idx')), ['index.json'], 'the temp file is removed');

    embeddedTexts = [];
    assert.deepEqual(await (await open()).update(), { added: [], changed: ['pkg/alpha.py'], removed: [] }, 'the next run sees the old generation and redoes only the edit');
    assert.equal(embeddedTexts.length, 1);
  });

  it('a temp file left by a killed process is ignored', needsPython, async () => {
    await (await open()).update();
    fs.writeFileSync(`${indexFile()}.99999.tmp`, '{"meta":{"embedModel":"fake"');
    embeddedTexts = [];
    assert.deepEqual(await (await open()).update(), { added: [], changed: [], removed: [] });
    assert.equal(embeddedTexts.length, 0);
  });

  it('a truncated index file is rebuilt from scratch', needsPython, async () => {
    await (await open()).update();
    const text = fs.readFileSync(indexFile(), 'utf8');
    fs.writeFileSync(indexFile(), text.slice(0, text.length / 2));
    embeddedTexts = [];
    assert.deepEqual((await (await open()).update()).added.sort(), ['pkg/alpha.py', 'pkg/beta.py']);
    assert.equal(embeddedTexts.length, 3, 'every chunk embedded again');
  });

  it('an index whose chunks and vectors disagree is rebuilt from scratch', needsPython, async () => {
    await (await open()).update();
    const stored = JSON.parse(fs.readFileSync(indexFile(), 'utf8')) as { vectors: Record<string, number[]> };
    delete stored.vectors[Object.keys(stored.vectors)[0]];
    fs.writeFileSync(indexFile(), JSON.stringify(stored));
    embeddedTexts = [];
    assert.deepEqual((await (await open()).update()).added.sort(), ['pkg/alpha.py', 'pkg/beta.py']);
    assert.equal(embeddedTexts.length, 3);
  });

  it('a four-file index from before #13 is rebuilt and its files removed', needsPython, async () => {
    const dir = path.join(root, '.idx');
    fs.mkdirSync(dir);
    for (const name of ['chunks.json', 'vectors.json', 'files.json', 'meta.json']) fs.writeFileSync(path.join(dir, name), '{}');
    assert.deepEqual((await (await open()).update()).added.sort(), ['pkg/alpha.py', 'pkg/beta.py']);
    assert.deepEqual(fs.readdirSync(dir), ['index.json']);
  });
});

describe('rag team docs source', () => {
  it('team docs are indexed as source team with a clean path, apart from a repo file of the same name', needsPython, async () => {
    const team = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-team-'));
    try {
      fs.writeFileSync(path.join(root, 'README.md'), '# Repo\nrepo readme text\n');
      fs.writeFileSync(path.join(team, 'README.md'), '# Review\nevery patch needs a failing test first\n');
      const index = await RepoIndex.open(root, counting, { dir: path.join(root, '.idx'), embedModel: 'fake', teamDir: team });
      assert.deepEqual((await index.update()).added.sort(), ['README.md', 'pkg/alpha.py', 'pkg/beta.py', 'team:README.md']);
      const hits = await index.search('failing test first patch', 10);
      const teamHit = hits.find((c) => c.source === 'team');
      assert.deepEqual([teamHit?.path, teamHit?.id], ['README.md', 'team:README.md:1-2']);
      assert.ok(hits.some((c) => c.path === 'README.md' && c.source === undefined), 'the repo README stays a repo chunk');

      embeddedTexts = [];
      fs.writeFileSync(path.join(team, 'README.md'), '# Review\nevery patch needs a failing test and a review\n');
      assert.deepEqual(await index.update(), { added: [], changed: ['team:README.md'], removed: [] });
      assert.equal(embeddedTexts.length, 1, 'only the edited team doc is re-embedded');
    } finally {
      fs.rmSync(team, { recursive: true, force: true });
    }
  });
});
