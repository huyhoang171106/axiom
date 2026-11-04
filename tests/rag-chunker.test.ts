import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, chunkPython, chunkRepo } from '../src/core/rag/chunker.js';
import { pythonBin } from '../src/core/paths.js';

const python = pythonBin();
const hasPython = !spawnSync(python, ['-c', 'import ast'], { windowsHide: true }).error;
const needsPython = { skip: !hasPython && 'needs python' };

function tempRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-chunker-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const SOURCE = [
  'import os',                       // 1
  'LIMIT = 3',                       // 2
  '',                                // 3
  'def first(a):',                   // 4
  '    return a + 1',                // 5
  '',                                // 6
  'class Table:',                    // 7
  '    """A table."""',              // 8
  '',                                // 9
  '    @property',                   // 10
  '    @staticmethod',               // 11
  '    def insert(doc):',            // 12
  '        return doc',              // 13
  '',                                // 14
  'async def second():',             // 15
  '    pass',                        // 16
].join('\n');

describe('rag chunker', () => {
  it('each top-level function is one chunk with exact line range', needsPython, async () => {
    const chunks = await chunkPython('pkg/a.py', SOURCE, python);
    const first = chunks.find((c) => c.symbol === 'first');
    assert.deepEqual([first?.kind, first?.startLine, first?.endLine], ['function', 4, 5]);
    assert.equal(first?.id, 'pkg/a.py:4-5');
    assert.equal(first?.text, 'def first(a):\n    return a + 1');
    const second = chunks.find((c) => c.symbol === 'second');
    assert.deepEqual([second?.startLine, second?.endLine], [15, 16]);
  });

  it('methods are named Class.method and include decorators', needsPython, async () => {
    const chunks = await chunkPython('pkg/a.py', SOURCE, python);
    const method = chunks.find((c) => c.symbol === 'Table.insert');
    assert.deepEqual([method?.kind, method?.startLine, method?.endLine], ['method', 10, 13]);
    const cls = chunks.find((c) => c.symbol === 'Table');
    assert.equal(cls?.kind, 'class');
    assert.equal(cls?.startLine, 7);
    assert.ok(cls && cls.endLine < 10, 'class chunk stops before its first method');
    assert.match(cls?.text ?? '', /A table/);
  });

  it('module-level code becomes one module chunk', needsPython, async () => {
    const chunks = await chunkPython('pkg/a.py', SOURCE, python);
    const modules = chunks.filter((c) => c.kind === 'module');
    assert.equal(modules.length, 1);
    assert.deepEqual([modules[0].symbol, modules[0].startLine, modules[0].endLine, modules[0].text], [null, 1, 2, 'import os\nLIMIT = 3']);
  });

  it('a file with a syntax error becomes one module chunk', needsPython, async () => {
    const chunks = await chunkPython('bad.py', 'def broken(:\n    pass\n', python);
    assert.equal(chunks.length, 1);
    assert.deepEqual([chunks[0].kind, chunks[0].startLine, chunks[0].endLine], ['module', 1, 2]);
  });

  it('markdown is split at headings', () => {
    const md = ['intro', '# Title', 'text', '## Usage', '```sh', '# not a heading', '```', '#### deep stays inside', '### API'].join('\n');
    const chunks = chunkMarkdown('README.md', md);
    assert.deepEqual(
      chunks.map((c) => [c.symbol, c.startLine, c.endLine]),
      [[null, 1, 1], ['Title', 2, 3], ['Usage', 4, 8], ['API', 9, 9]]
    );
    assert.ok(chunks.every((c) => c.kind === 'doc' && c.fileType === 'markdown'));
  });

  it('chunks longer than 120 lines are split and keep the symbol', needsPython, async () => {
    const body = Array.from({ length: 200 }, (_, i) => `    x${i} = ${i}`);
    const chunks = await chunkPython('big.py', ['def big():', ...body].join('\n'), python);
    assert.deepEqual(chunks.map((c) => [c.symbol, c.startLine, c.endLine]), [['big', 1, 120], ['big', 121, 201]]);
  });

  it('secret files and .venv are skipped', needsPython, async () => {
    const root = tempRepo({
      'pkg/ok.py': 'def ok():\n    return 1\n',
      '.venv/lib/site.py': 'def hidden():\n    pass\n',
      'pkg/__pycache__/x.py': 'def cached():\n    pass\n',
      '.env': 'API_KEY=x\n',
      'keys/server.pem': 'secret\n',
      'docs/guide.rst': 'Guide\n=====\n',
      'notes.txt': 'not a doc file\n',
      'big.py': `X = "${'a'.repeat(210 * 1024)}"\n`,
    });
    try {
      const paths = [...new Set((await chunkRepo(root, { python })).map((c) => c.path))];
      assert.deepEqual(paths, ['docs/guide.rst', 'pkg/ok.py']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
