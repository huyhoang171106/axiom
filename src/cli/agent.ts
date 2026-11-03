// src/cli/agent.ts - The one place headless and TUI build the chat agent

import { AgentLoop, DEFAULT_SYSTEM_PROMPT } from '../core/agent-loop.js';
import { loadConfig } from '../core/config.js';
import { createExecutionContext, type ExecutionContext } from '../core/execution-context.js';
import { buildSystemPrompt } from '../core/prompt.js';
import { loadCatalog, type ModelInfo } from '../llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../llm/model-resolver.js';
import { MockProvider } from '../llm/providers/mock.js';

/** Stands in for a catalog model under --mock, so nothing needs a configured provider. */
export const MOCK_MODEL: ModelInfo = {
  provider: 'mock', id: 'mock', name: 'Mock', api: 'openai-completions', baseUrl: '', contextWindow: 128000, reasoning: false, input: ['text'],
};

/** `exec` is the session the chat shares with slash commands; omit it for a one-off agent with its own trace. */
export async function createAgent(opts: { workspaceRoot: string; mock?: boolean; signal?: AbortSignal; model?: string; exec?: ExecutionContext }): Promise<AgentLoop> {
  const config = { ...loadConfig(), workspaceRoot: opts.workspaceRoot };
  // --mock has to work with no provider set up (CI, eval), so it skips model resolution entirely.
  const info = opts.mock ? MOCK_MODEL : resolveModel(opts.model ?? '@default', loadCatalog(), config);
  const provider = opts.mock ? new MockProvider('mock', ['mock reply']) : await createProviderFor(info);
  const exec = opts.exec ?? createExecutionContext();
  return new AgentLoop({
    config,
    provider,
    model: info.id,
    systemPrompt: buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, opts.workspaceRoot),
    toolRegistry: exec.tools,
    eventBus: exec.bus,
    costTracker: exec.costTracker,
    signal: opts.signal,
  });
}
