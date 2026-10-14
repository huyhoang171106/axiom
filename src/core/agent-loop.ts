// src/core/agent-loop.ts - Core tool-use loop: LLM call -> tool calls -> repeat, under a step/budget/abort limit

import type { AxiomConfig, Message, TokenUsage, ToolCall, ToolResult } from './types.js';
import { EventBus, defaultEventBus } from './event-bus.js';
import { ExecutionStateMachine } from './state-machine.js';
import { SessionManager } from './session.js';
import { RepetitionGuard } from './repetition-guard.js';
import { CostTracker, defaultCostTracker } from '../llm/cost-tracker.js';
import { BaseLLMProvider } from '../llm/base-provider.js';
import { defaultProviderRegistry, type ProviderRegistry } from '../llm/provider-factory.js';
import { ToolRegistry } from '../tools/registry.js';
import type { BaseTool } from '../tools/base-tool.js';

export interface AgentLoopOptions {
  config: AxiomConfig;
  provider?: BaseLLMProvider;
  providerRegistry?: ProviderRegistry;
  toolRegistry?: ToolRegistry;
  sessionManager?: SessionManager;
  costTracker?: CostTracker;
  eventBus?: EventBus;
  maxSteps?: number;
  budgetLimitDollars?: number;
  signal?: AbortSignal;
}

export interface TaskResult {
  status: 'completed' | 'failed' | 'aborted';
  filesChanged: string[];
  totalCostDollars: number;
  totalTokens: TokenUsage;
  error?: string;
}

const SYSTEM_PROMPT = [
  'You are Axiom, an autonomous software engineering agent running in the user\'s workspace with bash and file tools.',
  '1. Ground every claim in actual file contents or command output; read before you edit.',
  '2. To fix a bug or implement a feature you MUST modify files with the "edit" or "write" tool, not just describe changes.',
  '3. Make surgical changes; do not restyle unrelated code.',
  '4. Verify changes by running tests or a typecheck before declaring completion.',
  '5. When done, summarize the result concisely.',
].join('\n');

export class AgentLoop {
  public readonly config: AxiomConfig;
  public readonly eventBus: EventBus;
  public readonly stateMachine: ExecutionStateMachine;
  public readonly sessionManager: SessionManager;
  public readonly costTracker: CostTracker;
  public readonly toolRegistry: ToolRegistry;
  private readonly providerRegistry: ProviderRegistry;
  private readonly provider?: BaseLLMProvider;
  private readonly guard = new RepetitionGuard();
  private readonly maxSteps: number;
  private readonly budgetLimitDollars: number;
  private signal?: AbortSignal;

  constructor(options: AgentLoopOptions) {
    this.config = options.config;
    this.eventBus = options.eventBus ?? defaultEventBus;
    this.stateMachine = new ExecutionStateMachine(this.eventBus);
    this.sessionManager = options.sessionManager ?? new SessionManager({ workspaceRoot: this.config.workspaceRoot });
    this.costTracker = options.costTracker ?? defaultCostTracker;
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry(true);
    this.providerRegistry = options.providerRegistry ?? defaultProviderRegistry;
    this.provider = options.provider;
    this.maxSteps = options.maxSteps ?? 60;
    this.budgetLimitDollars = options.budgetLimitDollars ?? this.config.budgetLimitDollars ?? 5;
    this.signal = options.signal;
  }

  public registerTool(tool: BaseTool): void {
    this.toolRegistry.registerTool(tool);
  }

  public transcript(): Message[] {
    return this.sessionManager.getSession()?.messages ?? [];
  }

  public async runTask(prompt: string, signal?: AbortSignal): Promise<TaskResult> {
    this.signal = signal ?? this.signal;
    this.guard.reset();
    const session = this.sessionManager.getSession() ?? this.sessionManager.createSession(prompt);
    if (!session.messages.some((m) => m.role === 'system')) {
      session.messages.unshift({ role: 'system', content: SYSTEM_PROMPT, timestamp: Date.now() });
    }
    this.sessionManager.addMessage({ role: 'user', content: prompt });

    // A previous turn that threw mid-run must not lock this one out of the state machine.
    this.stateMachine.transitionTo('failed', 'reset');
    this.stateMachine.transitionTo('analyzing', 'New task');
    this.stateMachine.transitionTo('executing', 'Starting agent loop');
    await this.sessionManager.createCheckpoint({ step: 0, description: `Task: ${prompt.slice(0, 80)}` });

    const provider =
      this.provider ?? this.providerRegistry.getOrCreate(this.config.activeProvider, this.config.providers[this.config.activeProvider]);
    const model = this.config.defaultModel ?? 'claude-sonnet-4-5';

    for (let step = 1; step <= this.maxSteps; step++) {
      if (this.signal?.aborted) return this.finish('aborted', 'Task aborted via AbortSignal');

      const cost = this.costTracker.getSessionSummary().totalCost;
      if (cost >= this.budgetLimitDollars) {
        return this.finish('failed', `Budget limit reached: $${cost.toFixed(4)} >= $${this.budgetLimitDollars.toFixed(4)}`);
      }

      let response;
      try {
        response = await provider.chat({
          model,
          messages: this.sessionManager.requireSession().messages,
          tools: this.toolRegistry.getDefinitions(),
          signal: this.signal,
          onToken: (delta) => this.eventBus.emit('stream_token', { delta }),
          onThinking: (delta) => this.eventBus.emit('thinking', { delta }),
        });
      } catch (err) {
        if (this.signal?.aborted) return this.finish('aborted', 'Task aborted via AbortSignal');
        return this.finish('failed', `LLM provider error: ${err instanceof Error ? err.message : String(err)}`);
      }

      this.costTracker.record(model, response.usage);
      this.sessionManager.updateCost(response.usage.costEstimate, response.usage);
      this.eventBus.emit('cost_update', response.usage);
      this.sessionManager.addMessage({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length === 0) {
        this.sessionManager.saveSession();
        return this.finish('completed');
      }
      await this.runTools(toolCalls);
    }
    return this.finish('failed', `Exceeded maximum steps (${this.maxSteps}).`);
  }

  /** Adjacent read-only calls run concurrently; everything else stays sequential and in order. */
  private async runTools(toolCalls: ToolCall[]): Promise<void> {
    const run = (tc: ToolCall) =>
      this.toolRegistry.executeTool(tc.name, tc.arguments, { workspaceRoot: this.config.workspaceRoot });
    const parallelSafe = (tc: ToolCall) => !!this.toolRegistry.getTool(tc.name)?.isReadOnly;
    const started: Promise<ToolResult>[] = [];

    for (const [i, tc] of toolCalls.entries()) {
      this.eventBus.emit('tool_call_start', tc);
      if (parallelSafe(tc) && !started[i]) {
        for (let j = i; j < toolCalls.length && parallelSafe(toolCalls[j]); j++) started[j] = run(toolCalls[j]);
      }
      const result = await (started[i] ?? run(tc));
      this.eventBus.emit('tool_call_end', result);

      const target = tc.arguments['path'];
      if ((tc.name === 'write' || tc.name === 'edit') && typeof target === 'string' && !result.isError) {
        this.sessionManager.trackActiveFiles([target]);
      }
      // A model re-issuing the identical call is stuck; say so in the result it will read next.
      const warning = this.guard.record(tc.name, tc.arguments);
      this.sessionManager.addMessage({
        role: 'tool',
        content: warning ? `${result.output}\n\n${warning}` : result.output,
        toolCallId: tc.id,
        name: tc.name,
        isError: result.isError || undefined,
      });
    }
  }

  private finish(status: TaskResult['status'], error?: string): TaskResult {
    if (error) this.eventBus.emit('error', { message: error });
    this.stateMachine.transitionTo(status === 'completed' ? 'completed' : 'failed', error ?? 'Task completed');
    const session = this.sessionManager.requireSession();
    return {
      status,
      filesChanged: [...session.activeFiles],
      totalCostDollars: session.totalCostDollars,
      totalTokens: { ...session.totalTokens },
      error,
    };
  }
}
