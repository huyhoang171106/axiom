// src/commands/resume.ts - `resume` command (UC-04)

import type { Command } from './types.js';

export const resumeCommand: Command = {
  name: 'resume',
  summary: 'Continue an unfinished /feature task',
  usage: '/resume [threadId]',
  async run() {
    throw new Error('chưa làm (D2)');
  },
};
