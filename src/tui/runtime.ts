// src/tui/runtime.ts - Lightweight project runtime detection inspired by pi-open-tui
import fs from 'node:fs';
import path from 'node:path';

export interface RuntimeInfo {
  name: string;
  symbol: string;
  version?: string;
}

let cachedRuntime: { cwd: string; runtime: RuntimeInfo | null } | null = null;

const RUNTIME_CHECKS: Array<{ name: string; symbol: string; files: string[]; version?: () => string }> = [
  {
    name: 'nodejs',
    symbol: '\uE718', // 󰎙 (Nerd font nodejs) or fallback in theme
    files: ['package.json', '.nvmrc', '.node-version'],
    version: () => process.version.replace(/^v/, ''),
  },
  {
    name: 'bun',
    symbol: '\uE76F',
    files: ['bun.lock', 'bun.lockb'],
  },
  {
    name: 'deno',
    symbol: '\uE7FB',
    files: ['deno.json', 'deno.jsonc'],
  },
  {
    name: 'rust',
    symbol: '\uE7A8',
    files: ['Cargo.toml'],
  },
  {
    name: 'go',
    symbol: '\uE626',
    files: ['go.mod'],
  },
  {
    name: 'python',
    symbol: '\uE73C',
    files: ['pyproject.toml', 'requirements.txt', 'Pipfile'],
  },
];

export function detectRuntime(cwd: string): RuntimeInfo | null {
  if (cachedRuntime && cachedRuntime.cwd === cwd) return cachedRuntime.runtime;
  try {
    for (const check of RUNTIME_CHECKS) {
      if (check.files.some((f) => fs.existsSync(path.join(cwd, f)))) {
        const version = check.version ? check.version() : undefined;
        const found: RuntimeInfo = { name: check.name, symbol: check.symbol, version };
        cachedRuntime = { cwd, runtime: found };
        return found;
      }
    }
  } catch {
    // Ignore fs errors
  }
  cachedRuntime = { cwd, runtime: null };
  return null;
}
