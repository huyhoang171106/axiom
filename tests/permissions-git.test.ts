import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decide } from '../src/tools/permissions.js';
test('push destinations include configured upstream and multiple refspecs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  try {
    git('init', '-b', 'feature');
    git('config', 'branch.feature.remote', 'origin');
    git('config', 'branch.feature.merge', 'refs/heads/main');
    for (const command of ['git push', 'git push origin HEAD:main', 'git push origin HEAD:refs/heads/main', 'git push origin feature HEAD:master', 'git push --mirror origin', 'git push origin refs/heads/*:refs/heads/*']) {
      assert.equal(decide('run_command', { command }, root).verdict, 'deny', command);
    }
    assert.equal(decide('run_command', { command: 'git push origin feature' }, root).verdict, 'ask');
    git('config', 'remote.origin.push', 'HEAD:refs/heads/master');
    assert.equal(decide('run_command', { command: 'git push origin' }, root).verdict, 'deny');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
