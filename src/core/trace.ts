// src/core/trace.ts - JSONL trace of one run; stub until D3

import type { EventBus } from './event-bus.js';

// TODO(D3): one run ID per run, append every event to ~/.axiom/traces/<runId>.jsonl through redact().
export function startTrace(bus: EventBus): { runId: string; close(): void } {
  return { runId: '', close() {} };
}
