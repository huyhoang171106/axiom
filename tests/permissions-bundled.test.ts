import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { BUNDLED_SKILLS_DIR, isBundledSkillFile } from '../src/tools/bundled-skills.js';
import { decide } from '../src/tools/permissions.js';
test('only packaged skill documents get outside workspace read permission', () => {
  const skill = path.join(BUNDLED_SKILLS_DIR, 'issue-triage', 'SKILL.md');
  assert.equal(isBundledSkillFile(skill), true);
  assert.equal(decide('read_file', { path: skill }, os.tmpdir()).verdict, 'allow');
  for (const name of ['write_file', 'edit', 'list_dir']) {
    assert.equal(decide(name, { path: skill }, os.tmpdir()).verdict, 'deny');
  }
  for (const target of [path.join(BUNDLED_SKILLS_DIR, 'forged', 'SKILL.md'), path.join(BUNDLED_SKILLS_DIR, '..', 'package.json'), BUNDLED_SKILLS_DIR]) {
    assert.equal(isBundledSkillFile(target), false);
    assert.equal(decide('read_file', { path: target }, os.tmpdir()).verdict, 'deny');
  }
});
test('an outside junction alias does not acquire bundled resource trust', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-alias-'));
  try {
    fs.symlinkSync(BUNDLED_SKILLS_DIR, path.join(base, 'skills'), 'junction');
    const alias = path.join(base, 'skills', 'issue-triage', 'SKILL.md');
    assert.equal(isBundledSkillFile(alias), false);
    assert.equal(decide('read_file', { path: alias }, path.join(base, 'workspace')).verdict, 'deny');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
