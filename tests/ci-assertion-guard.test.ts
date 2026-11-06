// tests/ci-assertion-guard.test.ts - Kiểm tra ngoại lệ E3 và các trường hợp CI phải chặn.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const script = fs.readFileSync(new URL('../scripts/ci-local.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const guard = script.slice(script.indexOf('check_anti_cheat() {'), script.indexOf('run_stage "2/6"'));
const before = "  assert.deepEqual(ui.asked, ['Approve the plan? (1/2/cancel)']);";
const after = "  assert.deepEqual(ui.asked, Array(4).fill('Approve the plan? (1/2/cancel)'));";
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

for (const scenario of [
  { name: 'accepts the contracted E3 retry assertion', file: 'human-gate.test.ts', replacement: after, pass: true },
  { name: 'rejects deleting an assertion', file: 'human-gate.test.ts', replacement: '', pass: false },
  { name: 'rejects weakening an assertion', file: 'human-gate.test.ts', replacement: '  assert.ok(true);', pass: false },
  { name: 'rejects the exception in another file', file: 'other.test.ts', replacement: after, pass: false },
  { name: 'rejects another removal beside the E3 exception', file: 'human-gate.test.ts', replacement: after, extraRemoval: true, pass: false },
  { name: 'rejects focused tests beside the E3 exception', file: 'human-gate.test.ts', replacement: after + '\ntest.' + 'only("hidden", () => {});', pass: false },
]) {
  test(`CI guard ${scenario.name}`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ci-guard-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init');
    git('config', 'user.name', 'Guard Test');
    git('config', 'user.email', 'guard@example.invalid');
    fs.mkdirSync(path.join(root, 'tests'));
    const file = path.join(root, 'tests', scenario.file);
    fs.writeFileSync(file, before + '\n  assert.equal(executions, 1);\n');
    git('add', '.');
    git('commit', '-m', 'test: baseline');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    fs.writeFileSync(file, scenario.replacement + (scenario.extraRemoval ? '\n' : '\n  assert.equal(executions, 1);\n'));
    git('add', '.');
    git('commit', '-m', 'test: candidate');
    const result = spawnSync(bash, ['-c', guard + '\ncheck_anti_cheat\n'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status === 0, scenario.pass, result.stdout + result.stderr);
  });
}
