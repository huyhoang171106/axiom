// evals/registry.ts - UC number -> runner; each lane appends its own line

import { fileURLToPath } from 'node:url';
import { runTriage, TriageSchemaError } from '../src/agents/triage.js';
import { loadCatalog } from '../src/llm/catalog/index.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { createProviderFor, resolveModel } from '../src/llm/model-resolver.js';
import { hasProvider, loadCases, mockProvider, workspaceRoot } from './run.js';
import type { UcCaseResult, UcRunner } from './types.js';

/** The Phase 1 UC-01 eval behind the shared contract. TODO(A3): move to evals/uc01/run.ts. */
const runUc01: UcRunner = async ({ mock, config }) => {
  const catalog = loadCatalog();
  const info = mock ? undefined : resolveModel('@smol', catalog, config);
  if (info && !hasProvider(config, info, catalog)) throw new Error(`UC 01: provider ${info.provider} is not set up; run /login or pass --mock`);
  const root = workspaceRoot('01');
  const cases: UcCaseResult[] = [];
  for (const evalCase of loadCases(fileURLToPath(new URL('./uc01/', import.meta.url)))) {
    const tracker = new CostTracker();
    const started = performance.now();
    const measured = () => {
      const s = tracker.getSessionSummary();
      return { tokens: s.totalPromptTokens + s.totalCompletionTokens, costDollars: s.totalCostDollars, latencyMs: performance.now() - started };
    };
    try {
      const provider = info ? await createProviderFor(info) : mockProvider();
      const { ticket } = await runTriage({ issue: evalCase.input, workspaceRoot: root, provider, model: info?.id, costTracker: tracker });
      const typeCorrect = ticket.type === evalCase.expected.type;
      const routeCorrect = ticket.route === evalCase.expected.route;
      cases.push({ id: evalCase.id, passed: typeCorrect && routeCorrect, metrics: { schemaValid: true, typeCorrect, routeCorrect }, ...measured() });
    } catch (error) {
      const schemaValid = error instanceof TriageSchemaError ? false : null;
      cases.push({ id: evalCase.id, passed: false, metrics: { schemaValid, typeCorrect: false, routeCorrect: false }, ...measured(), error: error instanceof Error ? error.message : String(error) });
    }
  }
  const rate = (key: string) => cases.length ? cases.filter((c) => c.metrics[key] === true).length / cases.length : null;
  return { uc: '01', cases, summary: { schemaValidRate: rate('schemaValid'), typeAccuracy: rate('typeCorrect'), routeAccuracy: rate('routeCorrect') } };
};

export const UC_RUNNERS: Record<string, UcRunner> = {
  '01': runUc01,
};
