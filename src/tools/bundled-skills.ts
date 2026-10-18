// src/tools/bundled-skills.ts - Locate bundled skill files for the prompt and read policy
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url));

export function isBundledSkillFile(target: string): boolean {
  if (!path.isAbsolute(target)) return false;
  const relative = path.relative(BUNDLED_SKILLS_DIR, target);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || parts[0] === '..' || parts[1] !== 'SKILL.md') return false;
  try {
    return fs.lstatSync(path.join(BUNDLED_SKILLS_DIR, parts[0])).isDirectory() &&
      fs.lstatSync(target).isFile() && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}
