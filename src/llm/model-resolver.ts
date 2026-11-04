// src/llm/model-resolver.ts - Selector or role to ModelInfo (providers.md section 9), ModelInfo to a wire with its credential

import type { AxiomConfig, ModelRole } from '../core/types.js';
import { MODEL_ROLES } from '../core/types.js';
import { registerSecret } from '../core/secrets.js';
import { prepareCloud } from './auth/engines/cloud-fields.js';
import { resolveCredential } from './auth/resolve.js';
import { readAuth } from './auth/store.js';
import type { BaseLLMProvider } from './base-provider.js';
import { loadCatalog, type Catalog, type ModelInfo, type ProviderEntry } from './catalog/index.js';
import { ProviderError } from './provider-error.js';
import { WIRES } from './provider-factory.js';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
const THINKING_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** Where an unset role points (providers.md section 9); `default` falls back to the startup choice. */
const ROLE_FALLBACK: Record<ModelRole, ModelRole | undefined> = { default: undefined, smol: 'default', slow: 'default', plan: 'slow', review: 'default', task: 'default', code: 'default', embed: undefined };

export const NO_PROVIDER_MESSAGE = 'No provider is set up yet. Type /login or set the API key env var of a provider.';

type Resolved = ModelInfo & { thinking?: ThinkingLevel };

export function resolveModel(selector: string, catalog: Catalog, config: AxiomConfig): Resolved {
  return resolveList(selector, catalog, config, []);
}

function isAllowed(provider: string, config: AxiomConfig): boolean {
  if (config.disabledProviders?.includes(provider)) return false;
  return !config.enabledProviders?.length || config.enabledProviders.includes(provider);
}

/** Comma list: the first available entry, not a retry chain. A single entry only has to be enabled. */
function resolveList(selector: string, catalog: Catalog, config: AxiomConfig, roles: ModelRole[]): Resolved {
  const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('Empty model selector');
  if (parts.length === 1) {
    const info = resolveOne(parts[0], catalog, config, roles);
    if (!isAllowed(info.provider, config)) throw new Error(`Provider ${info.provider} is turned off by disabledProviders/enabledProviders in config.json`);
    return info;
  }
  for (const part of parts) {
    const info = resolveOne(part, catalog, config, roles);
    if (isAllowed(info.provider, config) && catalog.isAvailable(info.provider)) return info;
  }
  throw new Error(`None of "${selector}" is available. Type /login <provider> for one of them.`);
}

function resolveOne(selector: string, catalog: Catalog, config: AxiomConfig, roles: ModelRole[]): Resolved {
  if (selector.startsWith('@')) return resolveRole(selector.slice(1), catalog, config, roles);
  const colon = selector.lastIndexOf(':');
  // Only a known level is a suffix: in `name:20b` the `:20b` is part of the model ID.
  const thinking = colon > 0 && THINKING_LEVELS.includes(selector.slice(colon + 1)) ? (selector.slice(colon + 1) as ThinkingLevel) : undefined;
  const info = findModel(thinking ? selector.slice(0, colon) : selector, catalog, config);
  return thinking ? { ...info, thinking } : info;
}

function resolveRole(name: string, catalog: Catalog, config: AxiomConfig, roles: ModelRole[]): Resolved {
  if (!(MODEL_ROLES as readonly string[]).includes(name)) throw new Error(`Unknown model role @${name}. Roles: ${MODEL_ROLES.map((r) => `@${r}`).join(', ')}`);
  const role = name as ModelRole;
  if (roles.includes(role)) throw new Error(`Model role alias cycle: ${[...roles, role].map((r) => `@${r}`).join(' -> ')}`);
  const chain = [...roles, role];
  const value = config.modelRoles?.[role];
  if (value) return resolveList(value, catalog, config, chain);
  // Embedding cần model chuyên dụng; model chat lúc khởi động không phải
  // phương án dự phòng an toàn. Báo rõ trường config để người dùng tự sửa.
  if (role === 'embed') throw new Error('Configure modelRoles.embed in config.json before using @embed.');
  const fallback = ROLE_FALLBACK[role];
  return fallback ? resolveRole(fallback, catalog, config, chain) : startupModel(catalog, config);
}

/** Unset `default`: the model used last, then the default model of the first available provider in /login order. */
function startupModel(catalog: Catalog, config: AxiomConfig): ModelInfo {
  if (config.defaultModel) {
    try {
      const last = findModel(config.defaultModel, catalog, config);
      if (isAllowed(last.provider, config) && catalog.isAvailable(last.provider)) return last;
    } catch {
      // The last-used model left the catalog; fall through to the first available provider.
    }
  }
  const first = catalog.providers().find((p) => p.available !== false && isAllowed(p.id, config) && catalog.isAvailable(p.id));
  if (!first) throw new Error(NO_PROVIDER_MESSAGE);
  return findModel(`${first.id}/${first.defaultModel}`, catalog, config);
}

/** Exact `provider/id`, then exact `id` ignoring case; anything else is an error with suggestions, never a guess. */
function findModel(selector: string, catalog: Catalog, config: AxiomConfig): ModelInfo {
  const slash = selector.indexOf('/');
  if (slash > 0) {
    const exact = catalog.models(selector.slice(0, slash)).find((m) => m.id === selector.slice(slash + 1));
    if (exact) return exact;
  }
  const wanted = selector.toLowerCase();
  const matches = catalog.models().filter((m) => m.id.toLowerCase() === wanted);
  if (matches.length > 0) {
    const lastProvider = config.defaultModel?.split('/')[0];
    return matches.find((m) => m.provider === lastProvider) ?? matches.find((m) => catalog.isAvailable(m.provider)) ?? matches[0];
  }
  throw new Error(`Unknown model "${selector}".${suggestions(selector, catalog)} Run \`axiom models\` to list models, or \`axiom models refresh\` to fetch new ones.`);
}

function suggestions(selector: string, catalog: Catalog): string {
  const wanted = selector.toLowerCase();
  const near = catalog.models()
    .map((m) => `${m.provider}/${m.id}`)
    .map((s) => ({ s, d: Math.min(editDistance(wanted, s.toLowerCase()), editDistance(wanted, s.slice(s.indexOf('/') + 1).toLowerCase())) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .filter((x) => x.d <= Math.max(3, wanted.length / 2));
  return near.length > 0 ? ` Did you mean: ${near.map((x) => x.s).join(', ')}?` : '';
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** Local servers and cloud providers whose fields are all optional (the wire has its own credential chain) need nothing from us. */
function needsCredential(provider: ProviderEntry): boolean {
  if (provider.auth === 'none') return false;
  const fields = provider.login?.type === 'cloud-fields' && Array.isArray(provider.login.fields) ? (provider.login.fields as { optional?: boolean }[]) : [];
  return !(fields.length > 0 && fields.every((f) => f.optional));
}

export async function createProviderFor(info: ModelInfo, opts?: { cliKey?: string }): Promise<BaseLLMProvider> {
  const factory = (WIRES as Partial<Record<string, (typeof WIRES)[keyof typeof WIRES]>>)[info.api];
  if (!factory) throw new ProviderError(`${info.provider} needs wire ${info.api}, which is not supported yet`, { provider: info.provider, model: info.id, code: 'unsupported_wire' });
  const entry = loadCatalog().providers().find((p) => p.id === info.provider);
  const credential = await resolveCredential(info.provider, { cliKey: opts?.cliKey });
  // Failing here keeps a wire from falling back to another vendor's key in the environment.
  if (!credential && entry && needsCredential(entry)) {
    const hint = entry.env[0] ? ` or set ${entry.env[0]}` : '';
    throw new ProviderError(`${info.provider} is not connected. Run /login ${info.provider}${hint}.`, { provider: info.provider, model: info.id, code: 'missing_credentials' });
  }
  if (credential?.source === 'oauth') {
    // Read after resolveCredential, so a refresh that just happened is what the wire sees.
    const stored = readAuth()[info.provider];
    if (stored?.type === 'oauth' && (stored.headers || stored.baseUrl)) {
      return factory({ ...info, baseUrl: stored.baseUrl ?? info.baseUrl, headers: { ...info.headers, ...stored.headers } }, credential.value);
    }
  }
  if (entry?.login?.type !== 'cloud-fields') return factory(info, credential?.value);
  const prepared = await prepareCloud(entry, info, credential?.value);
  if (prepared.credential) registerSecret(prepared.credential);
  return factory(prepared.info, prepared.credential);
}
