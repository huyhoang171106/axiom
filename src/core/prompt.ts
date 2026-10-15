// src/core/prompt.ts - System prompt = role prompt + skill index + target repo rules

import { skillsIndex } from './skills.js';
import { loadProjectRules } from './project-rules.js';

export function buildSystemPrompt(base: string, workspaceRoot: string): string {
  return [base, skillsIndex(), loadProjectRules(workspaceRoot)].filter(Boolean).join('\n\n');
}
