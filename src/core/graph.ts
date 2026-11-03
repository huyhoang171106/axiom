// src/core/graph.ts - Shared LangGraph pieces: checkpointer, thread IDs, node tracing

import crypto from 'node:crypto';
import path from 'node:path';
import { MemorySaver, type BaseCheckpointSaver, type LangGraphRunnableConfig } from '@langchain/langgraph';
import type { EventBus } from './event-bus.js';
import { axiomHome } from './paths.js';

export type GraphNode<S> = (s: S, config: LangGraphRunnableConfig) => Promise<Partial<S>>;

/** Every workflow compiles with this, so resume works the same for all of them. */
export function createCheckpointer(dbPath: string = path.join(axiomHome(), 'checkpoints.db')): BaseCheckpointSaver {
  // TODO(D2): SqliteSaver.fromConnString(dbPath); until then checkpoints live only as long as the process.
  return new MemorySaver();
}

/** `<kind>-YYYYMMDD-HHmmss-<6 hex>` in UTC: sortable by start time, unique within a second. */
export function newThreadId(kind: 'triage' | 'fix' | 'feature'): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${kind}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Wraps a node body so the trace shows where a workflow is. No `exit` on throw: `interrupt()` throws to pause,
 * and the node runs again from `enter` on resume.
 */
export function traceNode<S>(bus: EventBus, graph: string, node: string, fn: GraphNode<S>): GraphNode<S> {
  return async (s, config) => {
    const threadId = typeof config?.configurable?.thread_id === 'string' ? config.configurable.thread_id : undefined;
    bus.emit('node', { graph, node, phase: 'enter', threadId });
    const update = await fn(s, config);
    bus.emit('node', { graph, node, phase: 'exit', threadId });
    return update;
  };
}
