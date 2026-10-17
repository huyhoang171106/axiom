// src/llm/auth/resolve.ts - The credential for a provider; the first source that has one wins (providers.md section 5)

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { axiomHome } from '../../core/paths.js';
import { registerSecret } from '../../core/secrets.js';
import { loadCatalog, readUserProviders, type ProviderEntry } from '../catalog/index.js';
import { refreshIfNeeded } from './refresh.js';
import { readAuth, readAxiomEnv } from './store.js';

export type CredentialSource = 'cli' | 'models.json' | 'oauth' | 'login' | 'env' | 'axiom-env';

const COMMAND_TIMEOUT_MS = 5000;

const loginFieldSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  prompt: z.string().min(1),
  secret: z.boolean().optional(),
  optional: z.boolean().optional(),
}).strict();
export type LoginField = z.infer<typeof loginFieldSchema>;

/**
 * Fields a `cloud-fields` provider asks for. Field names are the provider's env names, so a login record and the
 * environment produce the same JSON credential.
 */
export function loginFields(provider: ProviderEntry): LoginField[] {
  if (provider.login?.type !== 'cloud-fields' || provider.login.fields === undefined) return [];
  return z.array(loginFieldSchema).min(1).parse(provider.login.fields);
}

/** `apiKey` in models.json: an env name with a value, `!command` (stdout, 5 s), or the key itself. */
async function resolveConfigKey(apiKey: string, provider: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (apiKey.startsWith('!')) {
    try {
      const { stdout } = await promisify(exec)(apiKey.slice(1), { timeout: COMMAND_TIMEOUT_MS, windowsHide: true });
      return stdout.trim();
    } catch (error) {
      // The command's own output could hold the secret, so only the exit reason is reported.
      throw new Error(`models.json: apiKey command for ${provider} failed (${(error as { code?: unknown }).code ?? 'timeout'})`);
    }
  }
  return /^[A-Z_][A-Z0-9_]*$/.test(apiKey) && env[apiKey] ? env[apiKey]! : apiKey;
}

/** First env name with a value, or for cloud providers every set field as JSON. */
function fromEnv(provider: ProviderEntry, values: Record<string, string | undefined>): string | undefined {
  const fields = loginFields(provider);
  if (fields.length === 0) return provider.env.map((name) => values[name]).find(Boolean);
  if (!provider.env.some((name) => values[name])) return undefined;
  const set = Object.fromEntries(fields.filter((f) => values[f.name]).map((f) => [f.name, values[f.name]!]));
  fields.filter((f) => f.secret && set[f.name]).forEach((f) => registerSecret(set[f.name]));
  // Only a non-field name was set (AWS_PROFILE, a credentials file path): the wire's own chain takes over.
  return Object.keys(set).length > 0 ? JSON.stringify(set) : undefined;
}

async function find(provider: string, opts: { cliKey?: string; env: NodeJS.ProcessEnv; home: string }): Promise<{ value: string; source: CredentialSource } | null> {
  if (opts.cliKey) return { value: opts.cliKey, source: 'cli' };
  const apiKey = readUserProviders(opts.home)[provider]?.apiKey;
  if (apiKey) return { value: await resolveConfigKey(apiKey, provider, opts.env), source: 'models.json' };
  const entry = loadCatalog(opts.home).providers().find((p) => p.id === provider);
  const stored = readAuth(opts.home)[provider];
  if (stored?.type === 'oauth' && entry) return { value: (await refreshIfNeeded(entry, stored, opts.home)).access, source: 'oauth' };
  if (stored?.type === 'api_key') return { value: stored.key, source: 'login' };
  if (stored?.type === 'fields' && entry) {
    loginFields(entry).filter((f) => f.secret && stored.values[f.name]).forEach((f) => registerSecret(stored.values[f.name]));
    return { value: JSON.stringify(stored.values), source: 'login' };
  }
  if (!entry) return null;
  const fromProcess = fromEnv(entry, opts.env);
  if (fromProcess) return { value: fromProcess, source: 'env' };
  const fromFile = fromEnv(entry, readAxiomEnv(opts.home));
  return fromFile ? { value: fromFile, source: 'axiom-env' } : null;
}

/** null when no source has a credential; every value returned is registered for redact(). */
export async function resolveCredential(
  provider: string,
  opts: { cliKey?: string; env?: NodeJS.ProcessEnv; home?: string },
): Promise<{ value: string; source: CredentialSource } | null> {
  const found = await find(provider, { cliKey: opts.cliKey, env: opts.env ?? process.env, home: opts.home ?? axiomHome() });
  if (found) registerSecret(found.value);
  return found;
}
