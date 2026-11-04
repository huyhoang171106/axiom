import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSupport, findCitations, parseCitations, validateCitation } from '../src/core/rag/citations.js';
import type { Chunk } from '../src/core/rag/types.js';

let root: string;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-citations-'));
  fs.mkdirSync(path.join(root, 'tinydb'));
  fs.writeFileSync(path.join(root, 'tinydb/table.py'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const retrieved: Chunk[] = [
  { id: 'tinydb/table.py:10-20', path: 'tinydb/table.py', symbol: 'Table.insert', kind: 'method', startLine: 10, endLine: 20, fileType: 'python', text: '' },
];

describe('rag citations', () => {
  it('parses both L10-L25 and L10-25 forms', () => {
    assert.deepEqual(parseCitations('See tinydb/table.py:L10-L25 and tinydb/queries.py:L3-7, also README.rst:L4. Again tinydb/table.py:L10-L25.'), [
      { path: 'tinydb/table.py', startLine: 10, endLine: 25 },
      { path: 'tinydb/queries.py', startLine: 3, endLine: 7 },
      { path: 'README.rst', startLine: 4, endLine: 4 },
    ]);
  });

  it('nonexistent file is rejected', () => {
    assert.equal(validateCitation({ path: 'tinydb/missing.py', startLine: 1, endLine: 2 }, root, retrieved), 'file not found');
    assert.equal(validateCitation({ path: '../outside.py', startLine: 1, endLine: 2 }, root, retrieved), 'file not found');
  });

  it('line past end of file is rejected', () => {
    assert.equal(validateCitation({ path: 'tinydb/table.py', startLine: 10, endLine: 31 }, root, retrieved), 'line out of range');
    assert.equal(validateCitation({ path: 'tinydb/table.py', startLine: 0, endLine: 3 }, root, retrieved), 'line out of range');
    assert.equal(validateCitation({ path: 'tinydb/table.py', startLine: 12, endLine: 11 }, root, retrieved), 'line out of range');
  });

  it('range outside retrieved chunks is rejected', () => {
    assert.equal(validateCitation({ path: 'tinydb/table.py', startLine: 21, endLine: 30 }, root, retrieved), 'not inside a retrieved chunk');
  });

  it('a range that only overlaps a retrieved chunk is rejected', () => {
    assert.equal(validateCitation({ path: 'tinydb/table.py', startLine: 15, endLine: 25 }, root, retrieved), 'not inside a retrieved chunk');
  });

  it('valid citation passes', () => {
    assert.equal(validateCitation({ path: 'tinydb/table.py', startLine: 12, endLine: 18 }, root, retrieved), null);
    assert.equal(validateCitation({ path: 'tinydb/table.py', startLine: 30, endLine: 30 }, root, [{ ...retrieved[0], startLine: 30, endLine: 30 }]), null);
  });

  it('team citations keep a plain path and resolve under the team dir, not the repo', () => {
    const team = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-citations-team-'));
    try {
      fs.writeFileSync(path.join(team, 'rules.md'), '# Tests\nnever edit existing tests\n');
      const [c] = parseCitations('Rule team:rules.md:L1-L2.');
      assert.deepEqual(c, { path: 'rules.md', startLine: 1, endLine: 2, source: 'team' });
      const teamChunk: Chunk = { id: 'team:rules.md:1-2', path: 'rules.md', source: 'team', symbol: 'Tests', kind: 'doc', startLine: 1, endLine: 2, fileType: 'markdown', text: '' };
      assert.equal(validateCitation(c, root, [teamChunk], team), null);
      assert.equal(validateCitation(c, root, [{ ...teamChunk, source: undefined }], team), 'not inside a retrieved chunk', 'a repo chunk of the same path does not back a team citation');
      assert.equal(validateCitation({ path: 'tinydb/table.py', startLine: 1, endLine: 2, source: 'team' }, root, retrieved, team), 'file not found', 'a team citation never reads the repo');
    } finally {
      fs.rmSync(team, { recursive: true, force: true });
    }
  });

  it('each citation is paired with the sentence it ends', () => {
    const found = findCitations('Insert writes a row (tinydb/table.py:L10-L12). Remove deletes rows, see tinydb/table.py:L14-15!\n- team:rules.md:L1');
    assert.deepEqual(found.map((f) => [f.citation.path, f.claim.replace(/\s+/g, ' ').trim()]), [
      ['tinydb/table.py', 'Insert writes a row ( )'],
      ['tinydb/table.py', 'Remove deletes rows, see'],
      ['rules.md', '-'],
    ]);
  });

  it('cited lines must mention what the sentence says', () => {
    const chunk: Chunk = { ...retrieved[0], startLine: 10, endLine: 13, text: 'def insert(self, document):\n    """Insert one document."""\n    return self._write(document)\n' };
    const c = { path: 'tinydb/table.py', startLine: 10, endLine: 12 };
    assert.equal(checkSupport('Insert stores a document', c, [chunk]), null);
    assert.equal(checkSupport('Search filters with a regex', c, [chunk]), 'cited lines do not mention what the sentence says');
    assert.equal(checkSupport('See it in', c, [chunk]), 'no claim next to the citation', 'filler words alone are no claim');
    assert.equal(checkSupport('Table holds rows', c, [chunk]), null, 'the chunk symbol Table.insert counts as cited content');
  });
});
