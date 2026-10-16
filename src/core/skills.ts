// src/core/skills.ts - Skill index for the system prompt (name, description, path)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * One line per skill: name, description and the path to read. The prompt carries only the index;
 * the agent read_file's the skill itself when it decides to use it.
 */
export function skillsIndexFrom(dir: string): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return '';
    throw error;
  }
  const lines: { name: string; line: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, entry.name, 'SKILL.md'), 'utf8');
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    const name = text.match(/^-\s*\*\*name:\*\*\s*(.+)$/m)?.[1]?.trim() || entry.name;
    const description = text.match(/^-\s*\*\*description:\*\*\s*(.+)$/m)?.[1]?.trim() ?? '';
    const label = description ? `${name}: ${description}` : name;
    lines.push({ name, line: `- ${label} (skills/${entry.name}/SKILL.md)` });
  }
  lines.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return lines.map((l) => l.line).join('\n');
}

/** Bundled skills live in the repo's `skills/`, at the same depth under `src/` and `dist/`. */
export function skillsIndex(): string {
  return skillsIndexFrom(fileURLToPath(new URL('../../skills/', import.meta.url)));
}
