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

const configFile = (): string => process.env.AXIOM_CONFIG_PATH || path.join(axiomHome(), 'config.json');

/** Merge `patch` into the saved file only, so defaults and env keys from loadConfig never get written to disk. */
export function saveConfig(patch: Partial<AxiomConfig>, file = configFile()): void {
  let saved: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} is not valid JSON. Fix it before changing settings from Axiom.`);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...saved, ...patch }, null, 2)}\n`);
}

export function loadConfig(file = configFile()): AxiomConfig {
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
