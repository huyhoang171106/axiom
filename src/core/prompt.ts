// src/core/prompt.ts - System prompt = role prompt + skill index + target repo rules

import { skillsIndex } from './skills.js';
import { loadProjectRules } from './project-rules.js';

export function buildSystemPrompt(base: string, workspaceRoot: string): string {
  const index = skillsIndex();
  const skills = index ? `Available skills: use read_file on the listed path when a skill is relevant.\n${index}` : '';
  return [base, skills, loadProjectRules(workspaceRoot)].filter(Boolean).join('\n\n');
}
