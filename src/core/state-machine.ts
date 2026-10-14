// src/core/state-machine.ts - Finite State Machine for Execution Lifecycle

import type { ExecutionState } from './types.js';
import { EventBus, defaultEventBus } from './event-bus.js';

export interface StateTransitionRecord {
  from: ExecutionState;
  to: ExecutionState;
  timestamp: number;
  reason?: string;
}

export const VALID_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  idle: ['analyzing', 'planning', 'executing', 'waiting_user', 'failed'],
  analyzing: ['planning', 'executing', 'waiting_user', 'failed'],
  planning: ['executing', 'waiting_user', 'failed', 'completed'],
  // 'analyzing' is accepted from every mid-run state: a turn that throws between two non-terminal
  // states used to leave the machine stuck there, and the next turn's opening transitionTo('analyzing')
  // was then rejected forever (a permanent lock on a long-lived REPL AgentLoop).
  executing: ['verifying', 'recovering', 'waiting_user', 'completed', 'failed', 'executing', 'analyzing'],
  verifying: ['completed', 'recovering', 'executing', 'failed', 'waiting_user', 'analyzing'],
  recovering: ['executing', 'planning', 'waiting_user', 'failed', 'analyzing'],
  waiting_user: ['analyzing', 'planning', 'executing', 'completed', 'failed', 'idle'],
  completed: ['idle', 'analyzing', 'planning', 'executing'],
  failed: ['idle', 'recovering', 'analyzing', 'planning', 'executing'],
};

export class ExecutionStateMachine {
  private currentState: ExecutionState = 'idle';
  private history: StateTransitionRecord[] = [];
  private eventBus: EventBus;

  constructor(eventBus?: EventBus, initialState: ExecutionState = 'idle') {
    this.eventBus = eventBus || defaultEventBus;
    this.currentState = initialState;
  }

  public getState(): ExecutionState {
    return this.currentState;
  }

  public canTransitionTo(next: ExecutionState): boolean {
    const allowed = VALID_TRANSITIONS[this.currentState];
    return Array.isArray(allowed) && allowed.includes(next);
  }

  public transitionTo(next: ExecutionState, reason?: string): boolean {
    if (this.currentState === next) {
      return true;
    }

    if (!this.canTransitionTo(next)) {
      const err = `Invalid state transition from '${this.currentState}' to '${next}'`;
      this.eventBus.emit('error', { message: err });
      return false;
    }

    const from = this.currentState;
    this.currentState = next;

    const record: StateTransitionRecord = {
      from,
      to: next,
      timestamp: Date.now(),
      reason,
    };
    this.history.push(record);

    this.eventBus.emit('state_change', { from, to: next, reason });
    return true;
  }

  public reset(): void {
    if (this.currentState === 'idle') {
      return;
    }
    const from = this.currentState;
    this.currentState = 'idle';
    const record: StateTransitionRecord = {
      from,
      to: 'idle',
      timestamp: Date.now(),
      reason: 'Reset state machine',
    };
    this.history.push(record);
    this.eventBus.emit('state_change', { from, to: 'idle', reason: 'Reset state machine' });
  }

  public getHistory(): StateTransitionRecord[] {
    return [...this.history];
  }
}
