import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt } from '../src/core/prompt.js';
import { loadProjectRules } from '../src/core/project-rules.js';
import { skillsIndex, skillsIndexFrom } from '../src/core/skills.js';
import { ToolRegistry } from '../src/tools/registry.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkill(skillsDir: string, id: string, name: string, description: string): void {
  const dir = path.join(skillsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `# Skill: ${name}\n\n## Metadata\n\n- **name:** ${name}\n- **description:** ${description}\n`);
}

test('skillsIndexFrom lists each skill once, sorted, with name, description and path', () => {
  const dir = tempDir('axiom-skills-');
  writeSkill(dir, 'zebra', 'zebra-sort', 'Sorts things');
  writeSkill(dir, 'alpha', 'alpha-triage', 'Triages issues');
  const index = skillsIndexFrom(dir);
  const lines = index.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^- alpha-triage: Triages issues \(skills\/alpha\/SKILL\.md\)$/);
  assert.match(lines[1], /^- zebra-sort: Sorts things \(skills\/zebra\/SKILL\.md\)$/);
});

test('skillsIndexFrom keeps only the index, never the skill body', () => {
  const dir = tempDir('axiom-skills-');
  writeSkill(dir, 'issue-triage', 'issue-triage', 'Classifies issues');
  const index = skillsIndexFrom(dir);
  assert.ok(!index.includes('## Steps'));
  assert.ok(!index.includes('# Skill:'));
});

test('skillsIndexFrom falls back to the directory name when metadata is missing', () => {
  const dir = tempDir('axiom-skills-');
  const skillDir = path.join(dir, 'bare-skill');
  fs.mkdirSync(skillDir);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'no metadata here\n');
  assert.match(skillsIndexFrom(dir), /^- bare-skill \(skills\/bare-skill\/SKILL\.md\)$/);
});

test('skillsIndexFrom skips plain files and missing SKILL.md, and tolerates an empty dir', () => {
  const dir = tempDir('axiom-skills-');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a skill');
  fs.mkdirSync(path.join(dir, 'no-skill-file'));
  assert.equal(skillsIndexFrom(dir), '');
});

test('skillsIndexFrom returns empty for a missing dir', () => {
  assert.equal(skillsIndexFrom(path.join(os.tmpdir(), 'axiom-skills-does-not-exist')), '');
});

test('skillsIndex reads the bundled skills shipped with the harness', () => {
  const index = skillsIndex();
  assert.match(index, /issue-triage/);
  assert.ok(index.includes(path.join('skills', 'issue-triage', 'SKILL.md')));
});

test('indexed bundled skill can be read through policy from a separate workspace', async () => {
  const root = tempDir('axiom-workspace-');
  const skillPath = skillsIndex().match(/\(([^()]*)\)$/)?.[1];
  assert.ok(skillPath && path.isAbsolute(skillPath));
  const registry = new ToolRegistry(['read_file']);
  const result = await registry.executeTool('read_file', { path: skillPath }, { workspaceRoot: root });
  assert.equal(result.isError, false);
  assert.match(result.output, /issue-triage/);
  const other = await registry.executeTool('read_file', { path: path.join(path.dirname(skillPath), '..', '..', 'AGENTS.md') }, { workspaceRoot: root });
  assert.equal(other.isError, true);
  const write = new ToolRegistry();
  const denied = await write.executeTool('write_file', { path: skillPath, content: 'changed' }, { workspaceRoot: root });
  assert.equal(denied.isError, true);
});

test('loadProjectRules returns the AGENTS.md of the workspace', () => {
  const root = tempDir('axiom-workspace-');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\nAlways be nice.\n');
  assert.equal(loadProjectRules(root), '# Rules\nAlways be nice.\n');
});

test('loadProjectRules returns empty when the workspace has no AGENTS.md', () => {
  assert.equal(loadProjectRules(tempDir('axiom-workspace-')), '');
});

test('buildSystemPrompt joins base, the bundled skill index and the target repo rules', () => {
  const workspace = tempDir('axiom-workspace-');
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Target rules');
  const prompt = buildSystemPrompt('You are a coding agent.', workspace);
  assert.ok(prompt.startsWith('You are a coding agent.\n\n'));
  assert.ok(prompt.includes(path.join('skills', 'issue-triage', 'SKILL.md')));
  assert.ok(prompt.endsWith('\n\nTarget rules'));
});

test('buildSystemPrompt adds no blank section when the workspace has no rules', () => {
  const workspace = tempDir('axiom-workspace-');
  const prompt = buildSystemPrompt('Base only', workspace);
  assert.ok(prompt.startsWith('Base only\n\n- issue-triage: '));
  assert.ok(!prompt.includes('\n\n\n'));
  assert.ok(!prompt.endsWith('\n'));
});
