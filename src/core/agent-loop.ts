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
import type { PolicyDecision } from '../tools/permissions.js';
import type { BaseTool } from '../tools/base-tool.js';
import { compactHistory, shouldCompact } from './compaction.js';
import type { TaskState } from './task-state.js';
import { loadCatalog } from '../llm/catalog/index.js';

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
  /** Role prompt (triage, coder, reviewer, ...); defaults to the general coding agent prompt. */
  systemPrompt?: string;
  /** Model for this role; defaults to `config.defaultModel`. */
  model?: string;
  signal?: AbortSignal;
  /** Workflow xác nhận đã nhận đầu ra cuối cùng sau lượt tool; không dùng abort để báo thành công. */
  isComplete?: () => boolean;
  /** Nhắc một lần nếu model dừng sớm hoặc sắp hết lượt khi workflow chưa hoàn tất. */
  completionReminder?: string;
  /** Context window size for auto-compaction (UC-04); defaults to model's contextWindow or 1,000,000. */
  contextWindow?: number;
  /** TaskState when running under a workflow task (preserves goal and acceptance across compaction). */
  task?: TaskState;
}

export interface TaskResult {
  status: 'completed' | 'failed' | 'aborted';
  filesChanged: string[];
  totalCostDollars: number;
  totalTokens: TokenUsage;
  error?: string;
}

/** Extracts target file paths from unified diff headers (--- a/... and +++ b/...). */
export function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  const lines = patch.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next && next.startsWith('+++ ')) {
        const oldPath = line.slice(4).trim().replace(/^[ab]\//, '');
        const newPath = next.slice(4).trim().replace(/^[ab]\//, '');
        if (newPath !== '/dev/null') {
          paths.add(newPath);
        } else if (oldPath !== '/dev/null') {
          paths.add(oldPath);
        }
        i++;
      }
    }
  }
  return Array.from(paths);
}

export const DEFAULT_SYSTEM_PROMPT = [
  'You are Axiom, an autonomous software engineering agent running in the user\'s workspace with bash and file tools.',
  '1. Ground every claim in actual file contents or command output; read before you edit.',
  '2. To fix a bug or implement a feature you MUST modify files with the "edit" or "write_file" tool, not just describe changes.',
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
  public toolRegistry: ToolRegistry;
  private readonly providerRegistry: ProviderRegistry;
  private readonly provider?: BaseLLMProvider;
  private readonly isComplete?: () => boolean;
  private readonly completionReminder?: string;
  private readonly guard = new RepetitionGuard();
  private readonly maxSteps: number;
  private readonly budgetLimitDollars: number;
  private systemPrompt: string;
  private readonly model?: string;
  private readonly contextWindow?: number;
  private readonly task?: TaskState;
  private signal?: AbortSignal;

  constructor(options: AgentLoopOptions) {
    this.isComplete = options.isComplete;
    this.completionReminder = options.completionReminder;
    this.config = options.config;
    this.eventBus = options.eventBus ?? defaultEventBus;
    this.stateMachine = new ExecutionStateMachine(this.eventBus);
    this.sessionManager = options.sessionManager ?? new SessionManager({ workspaceRoot: this.config.workspaceRoot });
    this.costTracker = options.costTracker ?? defaultCostTracker;
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.providerRegistry = options.providerRegistry ?? defaultProviderRegistry;
    this.provider = options.provider;
    this.maxSteps = options.maxSteps ?? 60;
    this.budgetLimitDollars = options.budgetLimitDollars ?? this.config.budgetLimitDollars ?? 5;
    this.signal = options.signal;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.model = options.model;
    this.contextWindow = options.contextWindow;
    this.task = options.task;
  }

  public registerTool(tool: BaseTool): void {
    this.toolRegistry.registerTool(tool);
  }

  /** Thay thế ToolRegistry cho AgentLoop đang hoạt động (ví dụ khi chuyển chế độ /mode). */
  public setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  /** Lấy system prompt hiện tại của agent. */
  public getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * Cập nhật system prompt trên AgentLoop và đồng bộ vào session đang chạy.
   * Đảm bảo prompt của agent được cập nhật ngay cả khi session đã có system message từ trước.
   */
  public setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
    const session = this.sessionManager.getSession();
    if (session) {
      const idx = session.messages.findIndex((m) => m.role === 'system');
      if (idx !== -1) {
        session.messages[idx] = { ...session.messages[idx], content: prompt };
      } else {
        session.messages.unshift({ role: 'system', content: prompt, timestamp: Date.now() });
      }
      this.sessionManager.saveSession();
    }
  }

  /** Thêm chỉ thị bổ sung vào system prompt (ví dụ cho /plan mode). */
  public appendSystemPrompt(extra: string): void {
    const trimmed = extra.trim();
    if (!this.systemPrompt.includes(trimmed)) {
      this.setSystemPrompt(`${this.systemPrompt}\n\n${trimmed}`);
    }
  }

  /** Xoá chỉ thị khỏi system prompt (ví dụ khi /plan off). */
  public removeSystemPromptDirective(directive: string): void {
    const target = directive.trim();
    const updated = this.systemPrompt
      .split('\n\n')
      .filter((block) => block.trim() !== target)
      .join('\n\n');
    this.setSystemPrompt(updated);
  }

  public transcript(): Message[] {
    return this.sessionManager.getSession()?.messages ?? [];
  }

  public async runTask(prompt: string, signal?: AbortSignal): Promise<TaskResult> {
    this.signal = signal ?? this.signal;
    this.guard.reset();
    // Tracker phiên được dùng chung giữa các lượt và có thể nhận usage từ run khác.
    // Tạo tracker riêng cho lần runTask này để kiểm tra budget không tính nhầm
    // chi phí cũ hoặc chi phí phát sinh đồng thời từ một run khác.
    const runCosts = new CostTracker();
    const session = this.sessionManager.getSession() ?? this.sessionManager.createSession(prompt);
    const systemIdx = session.messages.findIndex((m) => m.role === 'system');
    if (systemIdx === -1) {
      session.messages.unshift({ role: 'system', content: this.systemPrompt, timestamp: Date.now() });
    } else {
      session.messages[systemIdx] = { ...session.messages[systemIdx], content: this.systemPrompt };
    }
    this.sessionManager.addMessage({ role: 'user', content: prompt });

    // A previous turn that threw mid-run must not lock this one out of the state machine.
    this.stateMachine.transitionTo('failed', 'reset');
    this.stateMachine.transitionTo('analyzing', 'New task');
    this.stateMachine.transitionTo('executing', 'Starting agent loop');
    await this.sessionManager.createCheckpoint({ step: 0, description: `Task: ${prompt.slice(0, 80)}` });

    const provider =
      this.provider ?? this.providerRegistry.getOrCreate(this.config.activeProvider, this.config.providers[this.config.activeProvider]);
    const model = this.model ?? this.config.defaultModel ?? 'claude-sonnet-4-5';
    let lastPromptTokens: number | undefined;
    let hasReminded = false;

    for (let step = 1; step <= this.maxSteps; step++) {
      if (this.signal?.aborted) return this.finish('aborted', 'Task aborted via AbortSignal');

      const cost = runCosts.getSessionSummary().totalCost;
      if (cost >= this.budgetLimitDollars) {
        return this.finish('failed', `Budget limit reached: $${cost.toFixed(4)} >= $${this.budgetLimitDollars.toFixed(4)}`);
      }

      // Dành lượt cuối để nhắc khi model cứ tiếp tục đọc mà chưa nộp kết quả.
      if (step === this.maxSteps && step > 1 && this.completionReminder && this.isComplete && !this.isComplete() && !hasReminded) {
        hasReminded = true;
        this.sessionManager.addMessage({ role: 'user', content: `${this.completionReminder} This is your final available turn.` });
      }

      // Ước lượng token trước mỗi lượt chat: dùng promptTokens của lượt trước nếu có,
      // không thì tính xấp xỉ ceil(độ dài ký tự / 4).
      const currentMessages = this.sessionManager.requireSession().messages;
      let promptTokens: number;
      if (lastPromptTokens !== undefined) {
        promptTokens = lastPromptTokens;
      } else {
        let chars = 0;
        for (const m of currentMessages) {
          chars += (m.content?.length ?? 0);
          if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
        }
        promptTokens = Math.ceil(chars / 4);
      }

      const effectiveContextWindow = this.contextWindow ?? this.resolveContextWindow(model);
      if (shouldCompact(promptTokens, effectiveContextWindow)) {
        const { summary, messages: compactedMessages } = await compactHistory(currentMessages, {
          provider,
          model,
          task: this.task,
          signal: this.signal,
          costTracker: this.costTracker,
          eventBus: this.eventBus,
        });
        if (summary) {
          const currentSession = this.sessionManager.requireSession();
          currentSession.messages = compactedMessages;
          this.sessionManager.saveSession();
          lastPromptTokens = undefined;
        }
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

      // Ghi vào cả hai tracker: tracker phiên phục vụ /cost, tracker run chỉ
      // phục vụ giới hạn ngân sách. Không reset tracker phiên khi bắt đầu run.
      this.costTracker.record(model, response.usage);
      runCosts.record(model, response.usage);
      this.sessionManager.updateCost(response.usage.costEstimate, response.usage);
      this.eventBus.emit('cost_update', response.usage);
      this.sessionManager.addMessage({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });
      lastPromptTokens = response.usage.promptTokens;

      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length === 0) {
        // Nhắc trong cùng run để giữ giới hạn bước và budget, không nhận text làm kết quả tool.
        if (this.completionReminder && this.isComplete && !this.isComplete() && !hasReminded && step < this.maxSteps) {
          hasReminded = true;
          this.sessionManager.addMessage({ role: 'user', content: this.completionReminder });
          continue;
        }
        this.sessionManager.saveSession();
        return this.finish('completed');
      }
      await this.runTools(toolCalls);
      // Chờ cả lượt tool ghi xong kết quả vào transcript rồi mới xét đầu ra cuối cùng.
      // Hủy thật luôn được ưu tiên; nhận được ticket không biến một lượt đã hủy thành thành công.
      if (this.signal?.aborted) return this.finish('aborted', 'Task aborted via AbortSignal');
      // Workflow có thể đã đủ đầu ra sau tool, không cần tốn thêm một lượt gọi model.
      if (this.isComplete?.()) {
        this.sessionManager.saveSession();
        return this.finish('completed');
      }
    }
    return this.finish('failed', `Exceeded maximum steps (${this.maxSteps}).`);
  }

  /** Adjacent read-only calls run concurrently; everything else stays sequential and in order. */
  private async runTools(toolCalls: ToolCall[]): Promise<void> {
    const run = (tc: ToolCall) =>
      this.toolRegistry.executeTool(tc.name, tc.arguments, { workspaceRoot: this.config.workspaceRoot, toolCallId: tc.id });
    const parallelSafe = (tc: ToolCall) => !!this.toolRegistry.getTool(tc.name)?.isReadOnly;
    const started: Promise<ToolResult>[] = [];

    for (const [i, tc] of toolCalls.entries()) {
      this.eventBus.emit('tool_call_start', tc);
      if (parallelSafe(tc) && !started[i]) {
        for (let j = i; j < toolCalls.length && parallelSafe(toolCalls[j]); j++) started[j] = run(toolCalls[j]);
      }
      const result = await (started[i] ?? run(tc));
      // Trace dùng quyết định thực tế của registry, kể cả headless và edited args.
      const policy = result.metadata?.policy as (PolicyDecision & { approval?: string }) | undefined;
      // Registry có bus phiên đã phát đủ audit; chỉ giữ event cũ cho caller chưa nối context.
      if (this.toolRegistry.bus !== this.eventBus && policy && (policy.verdict === 'deny' || policy.verdict === 'ask' || policy.approval)) {
        this.eventBus.emit('approval', {
          tool: tc.name, reason: policy.reason, risk: policy.risk,
          decision: policy.verdict === 'deny' ? 'auto-deny'
            : policy.approval === 'denied' ? 'deny'
            : policy.approval === 'edited' ? 'edited'
            : policy.approval === 'approved' || policy.approval === 'unattended' ? 'approve' : 'auto-deny',
          approver: policy.approval === 'unattended' ? 'headless' : policy.approval ? 'user' : 'policy',
        });
      }
      this.eventBus.emit('tool_call_end', result);

      const target = tc.arguments['path'];
      if ((tc.name === 'write_file' || tc.name === 'edit') && typeof target === 'string' && !result.isError) {
        this.sessionManager.trackActiveFiles([target]);
      } else if (tc.name === 'apply_patch' && typeof tc.arguments['patch'] === 'string' && !result.isError) {
        const patchPaths = extractPatchPaths(tc.arguments['patch']);
        if (patchPaths.length > 0) this.sessionManager.trackActiveFiles(patchPaths);
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

  private resolveContextWindow(modelId: string): number {
    try {
      const catalog = loadCatalog();
      for (const p of Object.values(catalog.providers)) {
        const match = p.models.find((m: { id: string; contextWindow?: number }) => m.id === modelId || `${p.id}/${m.id}` === modelId);
        if (match?.contextWindow) return match.contextWindow;
      }
    } catch {
      // ignore
    }
    return 1_000_000;
  }
}
