// src/core/execution-context.ts - Per-session state shared by chat, slash commands and every workflow node

import { CostTracker } from '../llm/cost-tracker.js';
import { ToolRegistry } from '../tools/registry.js';
import { EventBus } from './event-bus.js';
import { startTrace } from './trace.js';

/** TUI and headless each implement this; a command or workflow never knows which one it runs in. */
export interface CommandUI {
  print(text: string): void;
  ask(question: string, opts?: { secret?: boolean }): Promise<string>; // headless without a TTY: throws
  confirm(question: string): Promise<boolean>;                          // headless without a TTY: false (true with --yes)
}

/**
 * One per TUI or headless session, created before the first input, so a slash command run before any chat
 * already has the approver, denials and trace. Workflow nodes take `tools.scoped([...])`, never a new registry.
 */
export interface ExecutionContext {
  /** Session registry: approver, unattended opt-out (and later mode, denials) live here. */
  tools: ToolRegistry;
  /** Traced: chat, commands and workflow nodes all emit here. */
  bus: EventBus;
  costTracker: CostTracker;
  runId: string;
}

export function createExecutionContext(): ExecutionContext {
  const bus = new EventBus();
  const { runId } = startTrace(bus);
  const tools = new ToolRegistry();
  tools.bus = bus;
  tools.runId = runId;
  return { tools, bus, costTracker: new CostTracker(), runId };
}
