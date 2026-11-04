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
    git('-c', 'user.name=Policy Test', '-c', 'user.email=policy@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    git('config', 'branch.feature.remote', 'origin');
    git('config', 'branch.feature.merge', 'refs/heads/main');
    for (const command of ['git push', 'git push origin HEAD:main', 'git push origin HEAD:refs/heads/main', 'git push origin feature HEAD:master', 'git push --mirror origin', 'git push origin refs/heads/*:refs/heads/*']) {
      assert.equal(decide('run_command', { command }, root).verdict, 'deny', command);
    }
    assert.equal(decide('run_command', { command: 'git push origin feature' }, root).verdict, 'ask');
    for (const command of ['ls * && git push origin main', 'git push --force-with-lease origin main', 'git push -u origin HEAD:refs/heads/master', 'git push --atomic origin feature HEAD:main']) {
      assert.equal(decide('run_command', { command }, root).verdict, 'deny', command);
    }
    git('config', 'remote.origin.push', 'HEAD:refs/heads/master');
    assert.equal(decide('run_command', { command: 'git push origin' }, root).verdict, 'deny');
    git('worktree', 'add', '-b', 'main', path.join(root, 'worktree'));
    assert.equal(decide('run_command', { command: 'git -C worktree push origin HEAD' }, root).verdict, 'deny');
    git('-C', root, 'init', '-b', 'master', 'nested');
    assert.equal(decide('run_command', { command: 'git -C nested push' }, root).verdict, 'deny');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
