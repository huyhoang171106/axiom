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

  it('writes the index without leaving temp files', needsPython, async () => {
    await (await open()).update();
    assert.deepEqual(fs.readdirSync(path.join(root, '.idx')).sort(), ['chunks.json', 'files.json', 'meta.json', 'vectors.json']);
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
