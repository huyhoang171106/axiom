// src/llm/auth/store.ts - Stored credentials (auth.json) and ~/.axiom/.env under AXIOM_HOME (providers.md section 8)

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { axiomHome } from '../../core/paths.js';
import { registerSecret, SECRET_NAME } from '../../core/secrets.js';
import type { Credential } from './engines/index.js';

export type StoredCredential = Credential;

const AUTH_FILE = 'auth.json';

const credentialSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('api_key'), key: z.string() }),
  z.object({
    type: z.literal('oauth'),
    access: z.string(),
    refresh: z.string().optional(),
    expires: z.number().optional(),
    email: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    baseUrl: z.url().optional(),
  }),
  z.object({ type: z.literal('fields'), values: z.record(z.string(), z.string()) }),
]);

/** Undefined when there is no auth.json yet; throws when it exists but cannot be parsed. */
function loadAuthFile(home: string): Record<string, StoredCredential> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(home, AUTH_FILE), 'utf8');
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${path.join(home, AUTH_FILE)} is not valid JSON. Fix or delete it, then run /login again.`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path.join(home, AUTH_FILE)} must be a JSON object.`);
  const credentials: Record<string, StoredCredential> = {};
  for (const [provider, value] of Object.entries(raw)) {
    const parsed = credentialSchema.safeParse(value);
    if (parsed.success) credentials[provider] = parsed.data;
  }
  return credentials;
}

/** Every stored credential; key and token values are registered so redact() hides them. */
export function readAuth(home = axiomHome()): Record<string, StoredCredential> {
  let credentials: Record<string, StoredCredential>;
  try {
    credentials = loadAuthFile(home) ?? {};
  } catch (error) {
    // Reading must not stop the agent; saving still refuses so a broken file is never overwritten.
    console.warn(`axiom: ${(error as Error).message}`);
    return {};
  }
  for (const c of Object.values(credentials)) {
    if (c.type === 'api_key') registerSecret(c.key);
    if (c.type === 'oauth') [c.access, c.refresh].forEach((v) => v && registerSecret(v));
  }
  return credentials;
}

export function saveCredential(provider: string, credential: StoredCredential, home = axiomHome()): void {
  writeAuth({ ...loadAuthFile(home), [provider]: credential }, home);
}

/** False when nothing was stored for `provider`. */
export function removeCredential(provider: string, home = axiomHome()): boolean {
  const credentials = loadAuthFile(home);
  if (!credentials || !(provider in credentials)) return false;
  delete credentials[provider];
  writeAuth(credentials, home);
  return true;
}

/** `~/.axiom` holds keys, so only the owner may enter it. */
export function ensureHome(home = axiomHome()): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
}

// Temp file + rename, so a crash mid-write never leaves a half-written auth.json.
function writeAuth(credentials: Record<string, StoredCredential>, home: string): void {
  ensureHome(home);
  const file = path.join(home, AUTH_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** KEY=VALUE pairs from `~/.axiom/.env` (never the project's .env, providers.md section 5). */
export function readAxiomEnv(home = axiomHome()): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(path.join(home, '.env'), 'utf8');
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, '$2');
    values[match[1]] = value;
    if (SECRET_NAME.test(match[1]) && value) registerSecret(value);
  }
  return values;
}
