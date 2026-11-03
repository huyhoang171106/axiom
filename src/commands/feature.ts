// src/commands/feature.ts - `feature` command (UC-04)

import type { Command } from './types.js';

export const featureCommand: Command = {
  name: 'feature',
  summary: 'Plan a feature, approve the plan, build it step by step',
  usage: '/feature <request>',
  async run() {
    throw new Error('chưa làm (D1)');
  },
};
