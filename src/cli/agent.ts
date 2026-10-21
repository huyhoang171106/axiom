// src/cli/agent.ts - The one place headless and TUI build the chat agent

import { AgentLoop, DEFAULT_SYSTEM_PROMPT } from '../core/agent-loop.js';
import { loadConfig } from '../core/config.js';
import { EventBus } from '../core/event-bus.js';
import { buildSystemPrompt } from '../core/prompt.js';
import { startTrace } from '../core/trace.js';
import { loadCatalog, type ModelInfo } from '../llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../llm/model-resolver.js';
import { MockProvider } from '../llm/providers/mock.js';

/** Stands in for a catalog model under --mock, so nothing needs a configured provider. */
export const MOCK_MODEL: ModelInfo = {
  provider: 'mock', id: 'mock', name: 'Mock', api: 'openai-completions', baseUrl: '', contextWindow: 128000, reasoning: false, input: ['text'],
};

export async function createAgent(opts: { workspaceRoot: string; mock?: boolean; signal?: AbortSignal; model?: string }): Promise<AgentLoop> {
  const config = { ...loadConfig(), workspaceRoot: opts.workspaceRoot };
  // --mock has to work with no provider set up (CI, eval), so it skips model resolution entirely.
  const info = opts.mock ? MOCK_MODEL : resolveModel(opts.model ?? '@default', loadCatalog(), config);
  const agent = new AgentLoop({
    config,
    provider: opts.mock ? new MockProvider('mock', ['mock reply']) : await createProviderFor(info),
    model: info.id,
    systemPrompt: buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, opts.workspaceRoot),
    // Own bus per agent, so its trace never picks up another agent's events.
    eventBus: new EventBus(),
    signal: opts.signal,
  });
  startTrace(agent.eventBus);
  return agent;
}
