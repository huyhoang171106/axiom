// src/core/config.ts - Config from ~/.axiom/config.json (or AXIOM_CONFIG_PATH), overridden by env API keys

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AxiomConfig } from './types.js';

export const DEFAULT_CONFIG: AxiomConfig = {
  activeProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-5',
  providers: {},
  budgetLimitDollars: 5,
  autoVerify: false,
  mode: 'adaptive',
  workspaceRoot: process.cwd(),
};

export function loadConfig(file = process.env.AXIOM_CONFIG_PATH || path.join(os.homedir(), '.axiom', 'config.json')): AxiomConfig {
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
