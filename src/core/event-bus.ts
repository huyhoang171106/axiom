// src/core/event-bus.ts - Typed Event Bus for Axiom Lifecycle

import { EventEmitter } from 'node:events';
import type { AuditDecision, AuditActor } from './audit.js';
import { redact } from './secrets.js';
import type {
  ExecutionState,
  AgentStepEvent,
  ToolCall,
  ToolResult,
  VerificationEvidence,
  FailureDiagnosis,
  TokenUsage,
} from './types.js';
import type { Risk } from '../tools/permissions.js';

export interface AxiomEvents {
  state_change: (data: { from: ExecutionState; to: ExecutionState; reason?: string }) => void;
  step: (event: AgentStepEvent) => void;
  thinking: (data: { delta: string }) => void;
  stream_token: (data: { delta: string }) => void;
  tool_call_start: (toolCall: ToolCall) => void;
  tool_call_end: (toolResult: ToolResult) => void;
  verify_start: (data: { checkName: string }) => void;
  verify_end: (evidence: VerificationEvidence) => void;
  recovery_attempt: (diagnosis: FailureDiagnosis) => void;
  cost_update: (usage: TokenUsage) => void;
  error: (data: { message: string; error?: Error }) => void;
  node: (data: { graph: string; node: string; phase: 'enter' | 'exit'; threadId?: string }) => void;
  issue_ticket: (data: { ticket: unknown; warnings: string[]; workspaceRoot: string }) => void;
  approval: (data: {
    at?: string;
    runId?: string;
    tool: string;
    args?: Record<string, unknown>;
    reason: string;
    risk?: Risk;
    decision: AuditDecision;
    approver: AuditActor | string;
  }) => void;
}

export class EventBus {
  private emitter = new EventEmitter();

  private installDefaultErrorHandler(): void {
    this.emitter.on('error', (data: { message?: string }) => {
      if (data?.message) console.error(redact(`[Axiom Error] ${data.message}`));
    });
  }

  constructor() {
    this.emitter.setMaxListeners(50);
    // Node's EventEmitter throws ERR_UNHANDLED_ERROR when 'error' is emitted with no listener. Axiom
    // emits 'error' for budget breaches and invalid state transitions that the caller recovers from
    // (the emit is followed by a transitionTo('failed') and a returned result), so an unhandled emit
    // used to replace that graceful path with a rejected promise. Keep the event observable without
    // letting Node's special-case make it fatal.
    this.installDefaultErrorHandler();
  }

  public on<K extends keyof AxiomEvents>(event: K, listener: AxiomEvents[K]): this {
    this.emitter.on(event, listener as (...args: any[]) => void);
    return this;
  }

  public once<K extends keyof AxiomEvents>(event: K, listener: AxiomEvents[K]): this {
    this.emitter.once(event, listener as (...args: any[]) => void);
    return this;
  }

  public off<K extends keyof AxiomEvents>(event: K, listener: AxiomEvents[K]): this {
    this.emitter.off(event, listener as (...args: any[]) => void);
    return this;
  }

  public emit<K extends keyof AxiomEvents>(event: K, ...args: Parameters<AxiomEvents[K]>): boolean {
    return this.emitter.emit(event, ...args);
  }

  public removeAllListeners(event?: keyof AxiomEvents): void {
    if (event) {
      this.emitter.removeAllListeners(event);
      if (event === 'error') {
        this.installDefaultErrorHandler();
      }
    } else {
      this.emitter.removeAllListeners();
      this.installDefaultErrorHandler();
    }
  }
}

export const defaultEventBus = new EventBus();
