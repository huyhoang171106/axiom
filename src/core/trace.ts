// src/core/trace.ts - JSONL trace of one run: nodes, tool calls with policy, tokens, cost, errors

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AxiomEvents, EventBus } from './event-bus.js';
import { axiomHome } from './paths.js';
import { redact } from './secrets.js';

const TRACED_EVENTS = [
  'state_change',
  'step',
  'tool_call_start',
  'tool_call_end',
  'verify_start',
  'verify_end',
  'recovery_attempt',
  'cost_update',
  'error',
] as const satisfies readonly (keyof AxiomEvents)[];

/**
 * Appends every bus event to `<AXIOM_HOME>/traces/<runId>.jsonl`, one `{ t, event, data }` per line.
 * Streamed deltas are joined into one `text` / `thinking` line instead of one line per token.
 */
export function startTrace(bus: EventBus): { runId: string; close(): void } {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(axiomHome(), 'traces');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${runId}.jsonl`);

  // Each string is redacted on its own, so a secret is caught however JSON would have escaped it.
  const write = (event: string, data: unknown) =>
    fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), event, data }, (_key, value: unknown) => (typeof value === 'string' ? redact(value) : value))}\n`);

  const pending = { text: '', thinking: '' };
  const flush = () => {
    for (const kind of ['thinking', 'text'] as const) {
      if (pending[kind]) write(kind, pending[kind]);
      pending[kind] = '';
    }
  };

  const offs: (() => void)[] = [];
  const on = <K extends keyof AxiomEvents>(event: K, listener: AxiomEvents[K]) => {
    bus.on(event, listener);
    offs.push(() => bus.off(event, listener));
  };
  on('stream_token', ({ delta }) => void (pending.text += delta));
  on('thinking', ({ delta }) => void (pending.thinking += delta));
  for (const event of TRACED_EVENTS) {
    on(event, (data: unknown) => {
      flush();
      // An Error serializes to {}; keep its message.
      write(event, event === 'error' ? { message: (data as { message: string }).message } : data);
    });
  }

  write('run_start', { runId, cwd: process.cwd() });
  return {
    runId,
    close() {
      flush();
      for (const off of offs) off();
    },
  };
}
