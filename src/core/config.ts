// src/core/config.ts - Config from <AXIOM_HOME>/config.json (or AXIOM_CONFIG_PATH), overridden by env API keys

import fs from 'node:fs';
import path from 'node:path';
import { axiomHome } from './paths.js';
import type { AxiomConfig } from './types.js';

export const DEFAULT_CONFIG: AxiomConfig = {
  activeProvider: 'anthropic',
  providers: {},
  budgetLimitDollars: 5,
  autoVerify: false,
  mode: 'adaptive',
  workspaceRoot: process.cwd(),
};

export function loadConfig(file = process.env.AXIOM_CONFIG_PATH || path.join(axiomHome(), 'config.json')): AxiomConfig {
  let saved: Partial<AxiomConfig> = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // no config yet: defaults + env keys
  }
  const config: AxiomConfig = { ...DEFAULT_CONFIG, ...saved, workspaceRoot: process.cwd(), providers: { ...saved.providers } };
  const { ANTHROPIC_API_KEY: anthropic, OPENAI_API_KEY: openai } = process.env;
  if (anthropic) config.providers.anthropic = { ...config.providers.anthropic, apiKey: anthropic };
  if (openai) config.providers.openai = { ...config.providers.openai, apiKey: openai };
  return config;
}
