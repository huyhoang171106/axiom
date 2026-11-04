import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCitations, validateCitation } from '../src/core/rag/citations.js';
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
    assert.equal(validateCitation({ path: 'tinydb/table.py', startLine: 21, endLine: 30 }, root, retrieved), 'not from retrieved context');
  });

  it('valid citation passes', () => {
    assert.equal(validateCitation({ path: 'tinydb/table.py', startLine: 15, endLine: 25 }, root, retrieved), null);
    assert.equal(validateCitation({ path: 'tinydb/table.py', startLine: 30, endLine: 30 }, root, [{ ...retrieved[0], startLine: 30, endLine: 30 }]), null);
  });
});
