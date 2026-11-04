import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, escapesWorkspace } from '../src/tools/permissions.js';

test('paths are revalidated when a directory becomes an outside junction', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-path-'));
  const root = path.join(base, 'root');
  const link = path.join(root, 'link');
  fs.mkdirSync(link, { recursive: true });
  try {
    assert.equal(escapesWorkspace('link/new', root), false);
    fs.rmdirSync(link);
    fs.symlinkSync(base, link, 'junction');
    assert.equal(escapesWorkspace('link/new', root), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
test('canonical secret traversal is denied', () => {
  assert.equal(decide('read_file', { path: '.ssh/../.env' }, process.cwd()).verdict, 'deny');
});
