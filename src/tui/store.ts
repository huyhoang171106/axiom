// src/tui/store.ts - EventBus state for the TUI, published at most 30 times per second

import type { AxiomEvents, EventBus } from '../core/event-bus.js';
import type { CommandResult } from '../commands/types.js';
import type { ExecutionState, TokenUsage, ToolCall, ToolResult } from '../core/types.js';
import type { ModelInfo } from '../llm/catalog/index.js';
import type { ApprovalRequest, ApprovalDecision } from '../tools/permissions.js';
import type { EditorState } from './editor.js';
import type { TuiMenuItem, TuiMenuState } from './select-menu.js';
import { computeTelemetry, type GitStatus, type TurnTelemetry, type TurnTiming } from './layout.js';
import { issueTicketSchema } from '../agents/triage.js';
import { redact } from '../core/secrets.js';

// Round up: 33 ms would allow more than 30 notifications in one second.
const FRAME_MS = Math.ceil(1000 / 30);

export interface TuiToolRow {
  readonly call: Readonly<ToolCall>;
  readonly result: Readonly<ToolResult> | null;
}

export interface TuiTurn {
  readonly kind?: string;
  readonly data?: unknown;
  readonly prompt?: string;
  readonly id: number;
  readonly status: ExecutionState;
  readonly text: string;
  readonly thinking: string;
  readonly tools: readonly TuiToolRow[];
  readonly usage: Readonly<TokenUsage> | null;
  readonly error: string | null;
  /** Set when a turn sent through `prepareTurn` finishes. */
  readonly telemetry?: Readonly<TurnTelemetry>;
}

export interface TuiState {
  readonly editor: EditorState;
  readonly busy: boolean;
  readonly expanded: boolean;
  readonly notice: string;
  readonly question: { text: string; secret: boolean; hint?: string } | null;
  readonly menu: Readonly<TuiMenuState> | null;
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
  readonly mode: 'read-only' | 'edit';
  readonly planMode: boolean;
  readonly approvalEdit: EditorState | null;
  readonly approvalExpanded: boolean;
  readonly approvalEditError: string;
  readonly pendingApproval: Readonly<ApprovalRequest> | null;
  /** Cached `git status` for the footer; null until known. */
  readonly git: Readonly<GitStatus> | null;
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
    editor: { text: '', cursor: 0 }, busy: false, expanded: false, notice: '', question: null, menu: null, revision: 0,
    entries: [], live: null, status: 'idle', error: null,
    usage: { latest: null, total: null }, model: null, mode: 'edit', planMode: false, pendingApproval: null, approvalEdit: null, approvalEditError: '', approvalExpanded: false, git: null,
  };
  private pending = this.snapshot;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private detachBus: (() => void) | undefined;
  private textBuffer = '';
  private thinkingBuffer = '';
  private nextTurnId = 1;
  private prompt = '';
  private timing: TurnTiming | null = null;
  private readonly toolStarts = new Map<string, number>();
  private approvalResolve?: (decision: ApprovalDecision) => void;
  private answerResolve?: (answer: string) => void;
  private answerReject?: (error: Error) => void;
  private menuResolve?: (value: string | null) => void;

  public update(patch: Partial<Pick<TuiState, 'editor' | 'busy' | 'expanded' | 'notice' | 'model' | 'git' | 'mode' | 'planMode'>>): void {
    this.pending = { ...this.pending, ...patch };
    this.schedule();
  }

  private markFirstOutput(): void {
    if (this.timing && this.timing.firstTokenAt === undefined) this.timing.firstTokenAt = Date.now();
  }

  /** Marks the send time of the next turn; TTFT and TPS are measured from here. */
  public prepareTurn(prompt: string): void {
    this.prompt = prompt;
    this.timing = { sentAt: Date.now(), toolMs: 0 };
    this.toolStarts.clear();
  }

  public print(text: string, prompt?: string, result?: CommandResult): void {
    const turn: TuiTurn = { ...(result && { kind: result.kind, data: result.data }), id: this.nextTurnId++, prompt, text, thinking: '', tools: [], usage: null, error: null, status: 'completed' };
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
    this.pending = { ...this.pending, pendingApproval: structuredClone(request), approvalEdit: null, approvalEditError: '', approvalExpanded: false };
    this.schedule();
  }

  public resolveApproval(decision: ApprovalDecision): void {
    const resolve = this.approvalResolve;
    this.approvalResolve = undefined;
    if (!resolve) return;
    this.pending = { ...this.pending, pendingApproval: null, approvalEdit: null, approvalEditError: '', approvalExpanded: false };
    this.schedule();
    resolve(decision);
  }

  public toggleApprovalExpanded(): void {
    if (!this.pending.pendingApproval) return;
    this.pending = { ...this.pending, approvalExpanded: !this.pending.approvalExpanded };
    this.schedule();
  }

  public beginApprovalEdit(): void {
    const request = this.pending.pendingApproval;
    if (!request || request.name === 'confirm') return;
    const text = JSON.stringify(request.args);
    this.pending = { ...this.pending, approvalEdit: { text, cursor: text.length }, approvalEditError: '', approvalExpanded: false };
    this.schedule();
  }

  public updateApprovalEdit(value: EditorState): void {
    if (!this.pending.approvalEdit) return;
    this.pending = { ...this.pending, approvalEdit: value };
    this.schedule();
  }

  public getApprovalEdit = (): EditorState => this.pending.approvalEdit ?? { text: '', cursor: 0 };

  public cancelApprovalEdit(): void {
    this.pending = { ...this.pending, approvalEdit: null, approvalEditError: '', approvalExpanded: false };
    this.schedule();
  }

  public submitApprovalEdit(text: string): void {
    if (!this.pending.pendingApproval || !this.pending.approvalEdit) return;
    try {
      const args: unknown = JSON.parse(text);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be a JSON object');
      this.resolveApproval({ editedArgs: args as Record<string, unknown> });
    } catch {
      // Editor clears its buffer on submit; retain invalid JSON so the user can correct it.
      this.pending = { ...this.pending, approvalEdit: { text, cursor: text.length }, approvalEditError: 'Arguments must be a valid JSON object' };
      this.schedule();
    }
  }

  public ask(text: string, secret = false, hint?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.answerResolve = resolve;
      this.answerReject = reject;
      this.pending = {
        ...this.pending,
        question: { text, secret, ...(hint ? { hint } : {}) },
        editor: { text: '', cursor: 0 },
      };
      this.schedule();
    });
  }

  public setQuestionHint(hint: string): void {
    if (!this.pending.question) return;
    this.pending = { ...this.pending, question: { ...this.pending.question, hint } };
    this.schedule();
  }

  public answer(text: string): void {
    const resolve = this.answerResolve;
    this.answerResolve = undefined;
    this.answerReject = undefined;
    this.pending = { ...this.pending, question: null, editor: { text: '', cursor: 0 } };
    this.schedule();
    resolve?.(text);
  }

  public openMenu(opts: {
    kind: 'model' | 'login' | 'logout';
    title: string;
    placeholder?: string;
    items: readonly TuiMenuItem[];
    initialValue?: string;
  }): Promise<string | null> {
    this.resolveMenu(null);
    const initialIdx = opts.initialValue
      ? Math.max(0, opts.items.findIndex((item) => item.value === opts.initialValue))
      : 0;
    const menu: TuiMenuState = {
      kind: opts.kind,
      title: opts.title,
      placeholder: opts.placeholder,
      items: [...opts.items],
      query: '',
      selectedIndex: initialIdx,
    };
    return new Promise((resolve) => {
      this.menuResolve = resolve;
      this.pending = { ...this.pending, menu, editor: { text: '', cursor: 0 } };
      this.schedule();
    });
  }

  public updateMenu(patch: { query?: string; selectedIndex?: number }): void {
    if (!this.pending.menu) return;
    this.pending = {
      ...this.pending,
      menu: {
        ...this.pending.menu,
        ...(patch.query !== undefined ? { query: patch.query } : {}),
        ...(patch.selectedIndex !== undefined ? { selectedIndex: patch.selectedIndex } : {}),
      },
    };
    this.schedule();
  }

  public resolveMenu(value: string | null): void {
    const resolve = this.menuResolve;
    this.menuResolve = undefined;
    if (this.pending.menu !== null) {
      this.pending = { ...this.pending, menu: null, editor: { text: '', cursor: 0 } };
      this.schedule();
    }
    resolve?.(value);
  }

  public cancelInteraction(): void {
    this.resolveApproval('deny');
    this.resolveMenu(null);
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
  public getMenu = (): Readonly<TuiMenuState> | null => this.pending.menu;

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
    on('issue_ticket', ({ ticket, warnings, workspaceRoot }) => {
      const parsed = issueTicketSchema.safeParse(ticket);
      if (!parsed.success) return;
      // Dữ liệu model đi vào transcript phải che secret như output text của command.
      const clean = parsed.data;
      const safeTicket = { ...clean, priority: redact(clean.priority),
        affected_files: clean.affected_files.map(redact), reproduction_steps: clean.reproduction_steps.map(redact),
        acceptance_criteria: clean.acceptance_criteria.map(redact), missing_info: clean.missing_info.map(redact) };
      this.print('', undefined, { kind: 'issue-ticket-preview', text: '', data: {
        ticket: safeTicket, warnings: warnings.map(redact), workspaceRoot: redact(workspaceRoot),
      } });
    });
    on('stream_token', ({ delta }) => {
      if (!delta) return;
      this.markFirstOutput();
      this.textBuffer += delta;
      this.schedule();
    });
    on('thinking', ({ delta }) => {
      if (!delta) return;
      this.markFirstOutput();
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
          const telemetry = this.finishTiming(live);
          this.pending = {
            ...this.pending,
            entries: [...this.pending.entries, { ...live, status: to, error, ...(telemetry ? { telemetry } : {}) }],
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
      // A tool-only model reply streams no text, so the call itself is its first visible output;
      // without this, every tool round counted as TTFT and TPS divided by the last reply only.
      this.markFirstOutput();
      if (this.timing) this.toolStarts.set(call.id, Date.now());
      const live = this.pending.live ?? this.createTurn('executing');
      this.pending = {
        ...this.pending,
        live: { ...live, tools: [...live.tools, { call: structuredClone(call), result: null }] },
      };
      this.schedule();
    });
    on('tool_call_end', (result) => {
      this.flushStream();
      const started = this.toolStarts.get(result.toolCallId);
      if (started !== undefined && this.timing) {
        this.timing.toolMs += Math.max(0, Date.now() - started);
        this.toolStarts.delete(result.toolCallId);
      }
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

    // Silence EventBus's default console.error listener while TUI owns error rendering.
    const rawEmitter = (bus as unknown as {
      emitter?: {
        listeners(event: string): ((...args: unknown[]) => void)[];
        off(event: string, fn: (...args: unknown[]) => void): void;
        on(event: string, fn: (...args: unknown[]) => void): void;
      };
    }).emitter;
    const mutedConsoleListeners =
      rawEmitter?.listeners('error').filter((fn) => fn.toString().includes('console.error')) ?? [];
    for (const fn of mutedConsoleListeners) rawEmitter?.off('error', fn);

    const detach = () => {
      for (const fn of mutedConsoleListeners) rawEmitter?.on('error', fn);
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

  private finishTiming(live: TuiTurn): TurnTelemetry | null {
    const timing = this.timing;
    this.timing = null;
    this.toolStarts.clear();
    if (!timing) return null;
    return computeTelemetry({ ...timing, endAt: Date.now() }, live.usage?.completionTokens);
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

  public flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flushStream();
    if (this.pending === this.snapshot) return;
    this.snapshot = this.pending;
    for (const listener of [...this.listeners]) listener();
  }

  private schedule(): void {
    if (this.timer !== undefined || (this.pending === this.snapshot && !this.textBuffer && !this.thinkingBuffer)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, FRAME_MS);
  }
}
