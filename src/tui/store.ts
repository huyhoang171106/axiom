// src/tui/store.ts - EventBus state for the TUI, published at most 30 times per second

import type { AxiomEvents, EventBus } from '../core/event-bus.js';
import type { ExecutionState, TokenUsage, ToolCall, ToolResult } from '../core/types.js';
import type { ModelInfo } from '../llm/catalog/index.js';
import type { ApprovalRequest, ApprovalDecision } from '../tools/permissions.js';
import type { EditorState } from './editor.js';

// Round up: 33 ms would allow more than 30 notifications in one second.
const FRAME_MS = Math.ceil(1000 / 30);

export interface TuiToolRow {
  readonly call: Readonly<ToolCall>;
  readonly result: Readonly<ToolResult> | null;
}

export interface TuiTurn {
  readonly prompt?: string;
  readonly id: number;
  readonly status: ExecutionState;
  readonly text: string;
  readonly thinking: string;
  readonly tools: readonly TuiToolRow[];
  readonly usage: Readonly<TokenUsage> | null;
  readonly error: string | null;
}

export interface TuiState {
  readonly editor: EditorState;
  readonly busy: boolean;
  readonly expanded: boolean;
  readonly notice: string;
  readonly question: { text: string; secret: boolean } | null;
  readonly revision: number;
  readonly entries: readonly TuiTurn[];
  readonly live: TuiTurn | null;
  readonly status: ExecutionState;
  readonly error: string | null;
  readonly usage: {
    readonly latest: Readonly<TokenUsage> | null;
    readonly total: Readonly<TokenUsage> | null;
  };
  // These fields are populated by the app/approval integration in E4, not by bus events.
  readonly model: Readonly<ModelInfo> | null;
  readonly mode: 'read-only' | 'edit' | 'auto';
  readonly pendingApproval: Readonly<ApprovalRequest> | null;
}

function addUsage(total: Readonly<TokenUsage> | null, next: TokenUsage): TokenUsage {
  if (!total) return { ...next };
  const sumOptional = (a: number | undefined, b: number | undefined) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    costEstimate: total.costEstimate + next.costEstimate,
    cacheReadInputTokens: sumOptional(total.cacheReadInputTokens, next.cacheReadInputTokens),
    cacheCreationInputTokens: sumOptional(total.cacheCreationInputTokens, next.cacheCreationInputTokens),
  };
}

export class TuiStore {
  private snapshot: TuiState = {
    editor: { text: '', cursor: 0 }, busy: false, expanded: false, notice: '', question: null, revision: 0,
    entries: [], live: null, status: 'idle', error: null,
    usage: { latest: null, total: null }, model: null, mode: 'edit', pendingApproval: null,
  };
  private pending = this.snapshot;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private detachBus: (() => void) | undefined;
  private textBuffer = '';
  private thinkingBuffer = '';
  private nextTurnId = 1;
  private prompt = '';
  private approvalResolve?: (decision: ApprovalDecision) => void;
  private answerResolve?: (answer: string) => void;
  private answerReject?: (error: Error) => void;

  public update(patch: Partial<Pick<TuiState, 'editor' | 'busy' | 'expanded' | 'notice' | 'model'>>): void {
    this.pending = { ...this.pending, ...patch };
    this.schedule();
  }

  public prepareTurn(prompt: string): void { this.prompt = prompt; }

  public print(text: string, prompt?: string): void {
    const turn: TuiTurn = { id: this.nextTurnId++, prompt, text, thinking: '', tools: [], usage: null, error: null, status: 'completed' };
    this.pending = { ...this.pending, entries: [...this.pending.entries, turn] };
    this.schedule();
  }

  public clear(): void {
    this.pending = { ...this.pending, entries: [], revision: this.pending.revision + 1 };
    this.schedule();
  }

  public requestApproval(request: ApprovalRequest, resolve: (decision: ApprovalDecision) => void): void {
    this.resolveApproval('deny');
    this.approvalResolve = resolve;
    this.pending = { ...this.pending, pendingApproval: structuredClone(request) };
    this.schedule();
  }

  public resolveApproval(decision: ApprovalDecision): void {
    const resolve = this.approvalResolve;
    this.approvalResolve = undefined;
    if (!resolve) return;
    this.pending = { ...this.pending, pendingApproval: null };
    this.schedule();
    resolve(decision);
  }

  public ask(text: string, secret = false): Promise<string> {
    return new Promise((resolve, reject) => {
      this.answerResolve = resolve;
      this.answerReject = reject;
      this.pending = { ...this.pending, question: { text, secret }, editor: { text: '', cursor: 0 } };
      this.schedule();
    });
  }

  public answer(text: string): void {
    const resolve = this.answerResolve;
    this.answerResolve = undefined;
    this.answerReject = undefined;
    this.pending = { ...this.pending, question: null, editor: { text: '', cursor: 0 } };
    this.schedule();
    resolve?.(text);
  }

  public cancelInteraction(): void {
    this.resolveApproval('deny');
    const reject = this.answerReject;
    this.answerResolve = undefined;
    this.answerReject = undefined;
    this.pending = { ...this.pending, question: null, editor: { text: '', cursor: 0 } };
    this.schedule();
    reject?.(new Error('Cancelled'));
  }

  public dispose(): void {
    this.cancelInteraction();
    this.detachBus?.();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  // Bound functions can be passed directly to useSyncExternalStore.
  public getSnapshot = (): TuiState => this.snapshot;
  public getEditor = (): EditorState => this.pending.editor;

  public subscribe = (fn: () => void): (() => void) => {
    const listener = () => fn();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Attach to one agent at a time; reattaching removes only this store's old listeners. */
  public attach(bus: EventBus): () => void {
    this.detachBus?.();
    const offs: (() => void)[] = [];
    const on = <K extends keyof AxiomEvents>(event: K, listener: AxiomEvents[K]) => {
      bus.on(event, listener);
      offs.push(() => bus.off(event, listener));
    };
    on('stream_token', ({ delta }) => {
      if (!delta) return;
      this.textBuffer += delta;
      this.schedule();
    });
    on('thinking', ({ delta }) => {
      if (!delta) return;
      this.thinkingBuffer += delta;
      this.schedule();
    });
    on('state_change', ({ to, reason }) => {
      this.flushStream();
      const live = this.pending.live;
      const terminal = to === 'completed' || to === 'failed';
      if (terminal) {
        // AgentLoop emits failed/reset before analyzing, even on its first task.
        // A terminal event without a live turn must not invent a transcript entry.
        if (live) {
          const error = to === 'failed' ? live.error ?? reason ?? null : live.error;
          this.pending = {
            ...this.pending,
            entries: [...this.pending.entries, { ...live, status: to, error }],
            live: null,
            error,
          };
        }
      } else if (live) {
        if (live.status !== to) this.pending = { ...this.pending, live: { ...live, status: to } };
      } else if (to !== 'idle') {
        this.createTurn(to);
      }
      if (this.pending.status !== to) this.pending = { ...this.pending, status: to };
      this.schedule();
    });
    on('tool_call_start', (call) => {
      this.flushStream();
      const live = this.pending.live ?? this.createTurn('executing');
      this.pending = {
        ...this.pending,
        live: { ...live, tools: [...live.tools, { call: structuredClone(call), result: null }] },
      };
      this.schedule();
    });
    on('tool_call_end', (result) => {
      this.flushStream();
      const live = this.pending.live;
      if (!live) return;
      const index = live.tools.findIndex((row) => row.call.id === result.toolCallId && row.result === null);
      if (index < 0) return;
      const tools = live.tools.map((row, i) => i === index ? { ...row, result: structuredClone(result) } : row);
      this.pending = { ...this.pending, live: { ...live, tools } };
      this.schedule();
    });
    on('cost_update', (usage) => {
      this.flushStream();
      this.pending = {
        ...this.pending,
        usage: { latest: { ...usage }, total: addUsage(this.pending.usage.total, usage) },
        live: this.pending.live ? { ...this.pending.live, usage: addUsage(this.pending.live.usage, usage) } : null,
      };
      this.schedule();
    });
    on('error', ({ message }) => {
      this.flushStream();
      if (this.pending.error === message && (!this.pending.live || this.pending.live.error === message)) return;
      this.pending = {
        ...this.pending,
        error: message,
        live: this.pending.live ? { ...this.pending.live, error: message } : null,
      };
      this.schedule();
    });

    const detach = () => {
      for (const off of offs) off();
      if (this.detachBus === detach) this.detachBus = undefined;
      // Already received events still publish on their scheduled frame, including the last tokens.
    };
    this.detachBus = detach;
    return detach;
  }

  private createTurn(status: ExecutionState): TuiTurn {
    const live: TuiTurn = {
      id: this.nextTurnId++, prompt: this.prompt || undefined, status, text: '', thinking: '', tools: [], usage: null, error: null,
    };
    this.prompt = '';
    this.pending = { ...this.pending, live, status, error: null };
    return live;
  }

  private flushStream(): void {
    if (!this.textBuffer && !this.thinkingBuffer) return;
    const live = this.pending.live ?? this.createTurn('executing');
    this.pending = {
      ...this.pending,
      live: { ...live, text: live.text + this.textBuffer, thinking: live.thinking + this.thinkingBuffer },
    };
    this.textBuffer = '';
    this.thinkingBuffer = '';
  }

  private schedule(): void {
    if (this.timer !== undefined || (this.pending === this.snapshot && !this.textBuffer && !this.thinkingBuffer)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushStream();
      if (this.pending === this.snapshot) return;
      this.snapshot = this.pending;
      for (const listener of [...this.listeners]) listener();
    }, FRAME_MS);
  }
}
