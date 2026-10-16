// src/core/project-rules.ts - Target repo AGENTS.md for the system prompt

import fs from 'node:fs';
import path from 'node:path';
import { isSecretPath } from '../tools/permissions.js';

/** The target repo's own rules for the system prompt; '' when the repo has no AGENTS.md. */
export function loadProjectRules(workspaceRoot: string): string {
  try {
    const root = fs.realpathSync(workspaceRoot);
    const target = fs.realpathSync(path.join(root, 'AGENTS.md'));
    const relative = path.relative(root, target);
    // Không nạp symlink dẫn ra ngoài workspace hoặc trỏ tới file nhạy cảm.
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || isSecretPath(target)) {
      throw new Error('AGENTS.md resolves outside the workspace or to a secret file');
    }
    return fs.readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
