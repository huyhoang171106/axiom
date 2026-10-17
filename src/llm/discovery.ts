// src/llm/discovery.ts - Model discovery via GET <baseUrl>/models, cached in models-cache.json for 24 hours (providers.md section 7.3)

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { axiomHome } from '../core/paths.js';
import { resolveCredential } from './auth/resolve.js';
import { ensureHome } from './auth/store.js';
import { loadCatalog, readModelsCache, type ModelsCache, type ProviderEntry } from './catalog/index.js';

export const DISCOVERY_TIMEOUT_MS = 5000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const modelsResponseSchema = z.object({ data: z.array(z.looseObject({ id: z.string().min(1) })) });

/** IDs the provider lists; throws a one-line reason that names the provider. */
export async function discoverModels(provider: ProviderEntry, credential: string | undefined, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<{ id: string }[]> {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', ...provider.headers, ...(credential && { authorization: `Bearer ${credential}` }) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`${provider.id}: cannot connect to ${new URL(url).host}`);
  }
  if (!response.ok) throw new Error(`${provider.id}: GET /models returned HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${provider.id}: /models did not return JSON`);
  }
  const parsed = modelsResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error(`${provider.id}: /models returned an unexpected shape`);
  return parsed.data.data.map((m) => ({ id: m.id }));
}

/**
 * Refresh the cache of every available provider that supports discovery. A fresh entry (under 24 h) is kept unless
 * `force`; a failed provider keeps its old entry, and its reason is returned instead of thrown.
 */
export async function refreshDiscovery(opts: { home?: string; force?: boolean; providers?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ updated: string[]; errors: string[] }> {
  const home = opts.home ?? axiomHome();
  const catalog = loadCatalog(home);
  const cache: ModelsCache = readModelsCache(home);
  const targets = catalog.providers().filter((p) =>
    p.discovery && p.available !== false && (!opts.providers || opts.providers.includes(p.id)) && catalog.isAvailable(p.id, opts.env)
    && (opts.force || !cache[p.id] || Date.now() - cache[p.id].fetchedAt > CACHE_TTL_MS));
  const updated: string[] = [];
  const errors: string[] = [];
  await Promise.all(targets.map(async (p) => {
    try {
      const credential = await resolveCredential(p.id, { env: opts.env, home });
      if (!credential && !p.discovery?.allowUnauthenticated && p.auth !== 'none') return;
      cache[p.id] = { fetchedAt: Date.now(), models: await discoverModels(p, credential?.value, opts.timeoutMs) };
      updated.push(p.id);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }));
  if (updated.length > 0) {
    ensureHome(home);
    fs.writeFileSync(path.join(home, 'models-cache.json'), `${JSON.stringify(cache, null, 2)}\n`);
  }
  return { updated: updated.sort(), errors: errors.sort() };
}
