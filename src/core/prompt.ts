// src/core/prompt.ts - System prompt = role prompt + skill index + target repo rules + project memory

import { skillsIndex } from './skills.js';
import { loadProjectRules } from './project-rules.js';
import { loadMemory } from './memory.js';

export function buildSystemPrompt(base: string, workspaceRoot: string): string {
  const index = skillsIndex();
  const skills = index ? `Available skills: use read_file on the listed path when a skill is relevant.\n${index}` : '';
  const rules = loadProjectRules(workspaceRoot);
  const memory = loadMemory(workspaceRoot);
  const memorySection = memory ? `# Project memory\n${memory}` : '';
  return [base, skills, rules, memorySection].filter(Boolean).join('\n\n');
}
