// src/core/project-rules.ts - Target repo AGENTS.md for the system prompt

import fs from 'node:fs';
import path from 'node:path';

/** The target repo's own rules for the system prompt; '' when the repo has no AGENTS.md. */
export function loadProjectRules(workspaceRoot: string): string {
  try {
    return fs.readFileSync(path.join(workspaceRoot, 'AGENTS.md'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
