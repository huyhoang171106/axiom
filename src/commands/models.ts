// src/commands/models.ts - `models` command: models of the supported providers grouped by provider; find, refresh, --json data

import { loadCatalog, type Catalog, type ModelInfo } from '../llm/catalog/index.js';
import { refreshDiscovery } from '../llm/discovery.js';
import { similarProviders } from './login.js';
import type { Command } from './types.js';

export interface ModelRow {
  provider: string;
  id: string;
  selector: string;
  name: string;
  contextWindow: number;
  maxTokens?: number;
  cost?: ModelInfo['cost'];
  available: boolean;
}

export function modelRows(catalog: Catalog, keep: (m: ModelInfo, available: boolean) => boolean = () => true): ModelRow[] {
  return catalog.providers().filter((p) => p.available !== false).flatMap((p) => {
    const available = catalog.isAvailable(p.id);
    return catalog.models(p.id).filter((m) => keep(m, available)).map((m) => ({
      provider: m.provider, id: m.id, selector: `${m.provider}/${m.id}`, name: m.name,
      contextWindow: m.contextWindow, maxTokens: m.maxTokens, cost: m.cost, available,
    }));
  });
}

const tokens = (n: number): string => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

/** One block per provider: a status header, then `selector  context  $in/$out per 1M`. */
export function formatRows(rows: ModelRow[]): string {
  const width = Math.max(0, ...rows.map((r) => r.selector.length));
  const blocks: string[] = [];
  for (const provider of [...new Set(rows.map((r) => r.provider))]) {
    const group = rows.filter((r) => r.provider === provider);
    const lines = group.map((r) => `  ${r.selector.padEnd(width)}  ${tokens(r.contextWindow).padStart(5)}  ${r.cost ? `$${r.cost.input}/$${r.cost.output}` : '-'}`);
    blocks.push([`${provider} (${group[0].available ? 'connected' : 'not connected'})`, ...lines].join('\n'));
  }
  return blocks.join('\n\n');
}

export const modelsCommand: Command = {
  name: 'models',
  summary: 'List models by provider (find <text>, refresh)',
  usage: '/models [provider | find <text> | refresh]',
  async run(args) {
    const [first = '', ...rest] = args.trim().split(/\s+/);
    if (first === 'refresh') {
      const { updated, errors } = await refreshDiscovery({ force: true });
      const text = [updated.length > 0 ? `Refreshed: ${updated.join(', ')}` : 'Nothing refreshed (no connected provider lists models).', ...errors].join('\n');
      return { kind: 'models-refresh', data: { updated, errors }, text };
    }
    const catalog = loadCatalog();
    let rows: ModelRow[];
    if (first === 'find') {
      const wanted = rest.join(' ').toLowerCase();
      if (!wanted) throw new Error('Usage: /models find <text>');
      rows = modelRows(catalog, (m) => [m.provider, m.id, m.name].some((s) => s.toLowerCase().includes(wanted)));
    } else if (first) {
      if (!catalog.providers().some((p) => p.id === first)) throw new Error(`Unknown provider ${first}.${similarProviders(catalog, first)}`);
      rows = modelRows(catalog, (m) => m.provider === first);
    } else {
      rows = modelRows(catalog);
    }
    return { kind: 'models', data: rows, text: rows.length > 0 ? formatRows(rows) : 'No models match.' };
  },
};
