// src/commands/login.ts - `login` command: list providers in /login order, or run one provider's login engine and store the result

import { LOGIN_ENGINES } from '../llm/auth/engines/index.js';
import { readAuth, saveCredential } from '../llm/auth/store.js';
import { loadCatalog, type Catalog, type ProviderEntry } from '../llm/catalog/index.js';
import type { Command } from './types.js';

const HOW: Record<string, string> = {
  'api-key': 'API key',
  'oauth-code': 'sign in (browser)',
  'device-code': 'sign in (device code)',
  'cloud-fields': 'cloud credentials',
  hook: 'sign in',
};

function connection(p: ProviderEntry): string {
  if (p.login) return HOW[p.login.type];
  return p.auth === 'none' ? 'local, no key' : `env ${p.env.join(' / ')}`;
}

function status(p: ProviderEntry, catalog: Catalog, stored: Set<string>): string {
  if (p.available === false) return `unsupported: ${p.reason}`;
  if (stored.has(p.id)) return 'logged in';
  return catalog.isAvailable(p.id) ? 'available' : 'not connected';
}

/** Closest IDs for a typo: prefix first, then substring. */
export function similarProviders(catalog: Catalog, id: string): string {
  const ids = catalog.providers().map((p) => p.id);
  const near = [...ids.filter((x) => x.startsWith(id.slice(0, 3))), ...ids.filter((x) => x.includes(id))].filter((x, i, all) => all.indexOf(x) === i).slice(0, 5);
  return near.length > 0 ? ` Did you mean ${near.join(', ')}?` : ' Type /login to list providers.';
}

export const loginCommand: Command = {
  name: 'login',
  summary: 'Connect a provider',
  usage: '/login [provider]',
  async run(args, ctx) {
    const catalog = loadCatalog();
    const id = args.trim();
    if (!id) {
      const stored = new Set(Object.keys(readAuth()));
      const rows = catalog.providers().map((p) => ({ id: p.id, name: p.name, connection: connection(p), status: status(p, catalog, stored) }));
      const width = Math.max(...rows.map((r) => r.id.length));
      return { kind: 'login-list', data: rows, text: rows.map((r) => `${r.id.padEnd(width)}  ${r.name} · ${r.connection} · ${r.status}`).join('\n') };
    }
    const provider = catalog.providers().find((p) => p.id === id);
    if (!provider) throw new Error(`Unknown provider ${id}.${similarProviders(catalog, id)}`);
    if (provider.available === false) throw new Error(`${id} is not supported in Axiom: ${provider.reason}`);
    if (!provider.login) {
      const text = provider.auth === 'none'
        ? `${id} needs no login: it talks to the local server at ${provider.baseUrl}.`
        : `${id} has no /login flow. Set ${provider.env.join(' or ')} instead.`;
      return { kind: 'login', data: { provider: id, stored: false }, text };
    }
    const credential = await LOGIN_ENGINES[provider.login.type](provider, ctx.ui);
    saveCredential(id, credential);
    return { kind: 'login', data: { provider: id, stored: true }, text: `Connected ${provider.name}. Pick a model with /model.` };
  },
};
