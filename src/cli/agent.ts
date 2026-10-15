// src/cli/agent.ts - The one place headless and TUI build the chat agent

import { AgentLoop, DEFAULT_SYSTEM_PROMPT } from '../core/agent-loop.js';
import { loadConfig } from '../core/config.js';
import { EventBus } from '../core/event-bus.js';
import { buildSystemPrompt } from '../core/prompt.js';
import { startTrace } from '../core/trace.js';
import { loadCatalog } from '../llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../llm/model-resolver.js';
import { MockProvider } from '../llm/providers/mock.js';

export async function createAgent(opts: { workspaceRoot: string; mock?: boolean; signal?: AbortSignal }): Promise<AgentLoop> {
  const config = { ...loadConfig(), workspaceRoot: opts.workspaceRoot };
  // --mock has to work with no provider set up (CI, eval), so it skips model resolution entirely.
  const info = opts.mock ? undefined : resolveModel('@default', loadCatalog(), config);
  const agent = new AgentLoop({
    config,
    provider: info ? await createProviderFor(info) : new MockProvider('mock', ['mock reply']),
    model: info?.id ?? 'mock',
    systemPrompt: buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, opts.workspaceRoot),
    // Own bus per agent, so its trace never picks up another agent's events.
    eventBus: new EventBus(),
    signal: opts.signal,
  });
  startTrace(agent.eventBus);
  return agent;
}
