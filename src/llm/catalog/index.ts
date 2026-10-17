// src/llm/catalog/index.ts - Provider and model catalog: built-in JSON, ~/.axiom/models.json and the discovery cache (providers.md section 7)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig } from '../../core/config.js';
import { axiomHome } from '../../core/paths.js';
import { readAuth, readAxiomEnv } from '../auth/store.js';

export const WIRE_APIS = [
  'openai-completions',
  'anthropic-messages',
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
  'google-generative-ai',
  'google-gemini-cli',
  'google-vertex',
  'ollama-chat',
  'bedrock-converse-stream',
  'cursor-agent',
  'devin-agent',
  'factory-droid-agent',
  'gitlab-duo-agent',
] as const;

export type WireApi = (typeof WIRE_APIS)[number];

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  api: WireApi;
  baseUrl: string;
  contextWindow: number;
  maxTokens?: number;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  headers?: Record<string, string>;
}

export const LOGIN_TYPES = ['api-key', 'oauth-code', 'device-code', 'cloud-fields', 'hook'] as const;
export type LoginType = (typeof LOGIN_TYPES)[number];

/** Both halves of a provider: `providers/<id>.json` and `auth/<id>.json`. */
export interface ProviderEntry {
  id: string;
  name: string;
  defaultModel: string;
  env: string[];
  /** A `WireApi`, or a wire Axiom does not implement when `available` is false. */
  api: string;
  baseUrl: string;
  headers?: Record<string, string>;
  /** 'none': usable without any credential (local servers). */
  auth?: 'none';
  /** Present when the provider lists models at `GET <baseUrl>/models`. */
  discovery?: { allowUnauthenticated?: boolean };
  /** false = not supported (providers.md section 4.7); `reason` says why. */
  available?: boolean;
  reason?: string;
  /** Engine-specific fields stay `unknown`: each login engine validates its own. */
  login?: { type: LoginType } & Record<string, unknown>;
  refresh?: unknown;
}

export interface Catalog {
  providers(): ProviderEntry[];
  models(provider?: string): ModelInfo[];
  isAvailable(id: string, env?: NodeJS.ProcessEnv): boolean;
}

/** Context window assumed when neither the catalog nor models.json gives one (providers.md section 7.2). */
export const DEFAULT_CONTEXT_WINDOW = 128000;

const CATALOG_DIR = path.dirname(fileURLToPath(import.meta.url));
const headersSchema = z.record(z.string(), z.string());
const costSchema = z.object({ input: z.number(), output: z.number(), cacheRead: z.number().optional(), cacheWrite: z.number().optional() }).strict();

const modelSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(['text', 'image'])).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  cost: costSchema.optional(),
  api: z.enum(WIRE_APIS).optional(),
  baseUrl: z.string().optional(),
  headers: headersSchema.optional(),
}).strict();
type ModelSpec = z.infer<typeof modelSpecSchema>;

export const providerFileSchema = z.object({
  id: z.string().regex(/^[a-z0-9.-]+$/),
  defaultModel: z.string().min(1),
  env: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
  api: z.string().min(1),
  baseUrl: z.string().min(1),
  headers: headersSchema.optional(),
  auth: z.literal('none').optional(),
  discovery: z.object({ allowUnauthenticated: z.boolean().optional() }).strict().optional(),
  available: z.literal(false).optional(),
  reason: z.string().min(1).optional(),
  seed: z.array(modelSpecSchema).min(1),
}).strict()
  .refine((p) => (p.available === false ? !!p.reason : (WIRE_APIS as readonly string[]).includes(p.api)), 'a supported provider needs a known wire; an unsupported one needs a reason')
  .refine((p) => p.seed.some((m) => m.id === p.defaultModel), 'seed must contain defaultModel');

export const authFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  login: z.looseObject({ type: z.enum(LOGIN_TYPES) }).optional(),
  refresh: z.unknown().optional(),
}).strict();

const userProviderSchema = z.object({
  baseUrl: z.string().min(1).optional(),
  api: z.enum(WIRE_APIS).optional(),
  apiKey: z.string().optional(),
  auth: z.literal('none').optional(),
  authHeader: z.boolean().optional(),
  headers: headersSchema.optional(),
  discovery: z.object({ type: z.literal('openai-models') }).optional(),
  models: z.array(modelSpecSchema.extend({ name: z.string().optional() })).optional(),
});
type UserProvider = z.infer<typeof userProviderSchema>;
const OVERRIDE_FIELDS = new Set(['baseUrl', 'apiKey', 'headers', 'authHeader']);

const cacheSchema = z.record(z.string(), z.object({ fetchedAt: z.number(), models: z.array(modelSpecSchema) }));
export type ModelsCache = z.infer<typeof cacheSchema>;

interface BuiltIn {
  entries: ProviderEntry[];
  seeds: Map<string, ModelSpec[]>;
}

let builtIn: BuiltIn | undefined;

// Static files shipped with Axiom: read and validated once per process. A bad file is our bug, so it throws.
function loadBuiltIn(): BuiltIn {
  if (builtIn) return builtIn;
  const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
  const order = z.array(z.string()).parse(readJson(path.join(CATALOG_DIR, 'auth', '_order.json')));
  const ids = fs.readdirSync(path.join(CATALOG_DIR, 'providers')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  ids.sort((a, b) => rank(order, a) - rank(order, b) || a.localeCompare(b));
  const entries: ProviderEntry[] = [];
  const seeds = new Map<string, ModelSpec[]>();
  for (const id of ids) {
    const { seed, ...provider } = providerFileSchema.parse(readJson(path.join(CATALOG_DIR, 'providers', `${id}.json`)));
    const auth = authFileSchema.parse(readJson(path.join(CATALOG_DIR, 'auth', `${id}.json`)));
    if (provider.id !== id || auth.id !== id) throw new Error(`catalog: ${id}.json has id "${provider.id}" / "${auth.id}"`);
    entries.push({ ...provider, name: auth.name, login: auth.login, refresh: auth.refresh });
    seeds.set(id, seed);
  }
  return (builtIn = { entries, seeds });
}

function rank(order: string[], id: string): number {
  const i = order.indexOf(id);
  return i === -1 ? order.length : i;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`axiom: ${message}`);
}

function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    warnOnce(`${file} is not valid JSON; ignoring the whole file.`);
    return undefined;
  }
}

/** Providers from `~/.axiom/models.json` that passed the checks of providers.md section 7.2. */
export function readUserProviders(home = axiomHome()): Record<string, UserProvider> {
  const file = path.join(home, 'models.json');
  const raw = readJsonFile(file);
  if (raw === undefined) return {};
  const root = z.object({ providers: z.record(z.string(), z.unknown()) }).safeParse(raw);
  if (!root.success) {
    warnOnce(`${file}: expected { "providers": { ... } }; ignoring the whole file.`);
    return {};
  }
  const builtInIds = new Set(loadBuiltIn().entries.map((e) => e.id));
  const result: Record<string, UserProvider> = {};
  for (const [id, value] of Object.entries(root.data.providers)) {
    const parsed = userProviderSchema.safeParse(value);
    if (!parsed.success) {
      warnOnce(`${file}: provider "${id}" skipped: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      continue;
    }
    const provider = parsed.data;
    if (provider.models) {
      const missing = (['baseUrl', 'api'] as const).filter((f) => !provider[f] && !builtInIds.has(id));
      if (missing.length > 0) {
        warnOnce(`${file}: provider "${id}" skipped: missing ${missing.join(', ')}.`);
        continue;
      }
      for (const m of provider.models) if (!m.contextWindow) warnOnce(`${file}: model "${id}/${m.id}" has no contextWindow; using ${DEFAULT_CONTEXT_WINDOW}.`);
    } else {
      const extra = Object.keys(value as object).filter((f) => !OVERRIDE_FIELDS.has(f));
      if (!builtInIds.has(id)) {
        warnOnce(`${file}: provider "${id}" skipped: a new provider needs baseUrl, api and models.`);
        continue;
      }
      if (extra.length > 0) warnOnce(`${file}: provider "${id}" override ignores ${extra.join(', ')} (allowed: ${[...OVERRIDE_FIELDS].join(', ')}).`);
    }
    result[id] = provider;
  }
  return result;
}

export function readModelsCache(home = axiomHome()): ModelsCache {
  const parsed = cacheSchema.safeParse(readJsonFile(path.join(home, 'models-cache.json')));
  return parsed.success ? parsed.data : {};
}

function toModelInfo(provider: ProviderEntry, spec: ModelSpec, override?: UserProvider): ModelInfo {
  const headers = { ...provider.headers, ...override?.headers, ...spec.headers };
  return {
    provider: provider.id,
    id: spec.id,
    name: spec.name ?? spec.id,
    api: spec.api ?? (provider.api as WireApi),
    baseUrl: override?.baseUrl ?? spec.baseUrl ?? provider.baseUrl,
    contextWindow: spec.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: spec.maxTokens,
    reasoning: spec.reasoning ?? false,
    input: spec.input ?? ['text'],
    cost: spec.cost,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

/** Reads files only, never the network (providers.md step 2). */
export function loadCatalog(home?: string): Catalog {
  const dir = home ?? axiomHome();
  const config = loadConfig(home === undefined ? undefined : path.join(home, 'config.json'));
  const user = readUserProviders(dir);
  const cache = readModelsCache(dir);
  const { entries, seeds } = loadBuiltIn();

  const providers: ProviderEntry[] = entries.map((e) => (user[e.id]?.baseUrl ? { ...e, baseUrl: user[e.id].baseUrl! } : e));
  for (const [id, u] of Object.entries(user)) {
    if (providers.some((p) => p.id === id) || !u.models?.length) continue;
    providers.push({
      id, name: id, defaultModel: u.models[0].id, env: [], api: u.api!, baseUrl: u.baseUrl!, headers: u.headers, auth: u.auth,
      discovery: u.discovery ? { allowUnauthenticated: u.auth === 'none' } : undefined,
    });
  }

  const models = new Map<string, ModelInfo[]>();
  for (const p of providers) {
    if (p.available === false) continue;
    // Seed keeps its own metadata, discovery adds only new IDs, models.json always wins.
    const specs = new Map<string, ModelSpec>();
    for (const m of [...(seeds.get(p.id) ?? []), ...(cache[p.id]?.models ?? [])]) if (!specs.has(m.id)) specs.set(m.id, m);
    for (const m of user[p.id]?.models ?? []) specs.set(m.id, m);
    models.set(p.id, [...specs.values()].map((m) => toModelInfo(p, m, user[p.id])));
  }

  return {
    providers: () => providers,
    models: (provider) => (provider === undefined ? [...models.values()].flat() : models.get(provider) ?? []),
    isAvailable(id, env = process.env) {
      const p = providers.find((x) => x.id === id);
      if (!p || p.available === false) return false;
      // Checked before credentials: a disabled provider stays off even with a key (providers.md section 8).
      if (config.disabledProviders?.includes(id)) return false;
      if (config.enabledProviders?.length && !config.enabledProviders.includes(id)) return false;
      if (p.auth === 'none' || user[id]?.apiKey || user[id]?.auth === 'none') return true;
      if (id in readAuth(dir)) return true;
      const dotenv = readAxiomEnv(dir);
      return p.env.some((name) => env[name] || dotenv[name]);
    },
  };
}
