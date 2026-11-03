// src/agents/route.ts - Run the workflow an IssueTicket routes to (UC-01 -> UC-02/03/04)

import type { CommandUI, ExecutionContext } from '../core/execution-context.js';
import type { AxiomConfig } from '../core/types.js';
import type { IssueTicket } from './triage.js';

/** Session `tools`, `bus`, `costTracker`, `runId` come with it, so routed workflows ask and trace like chat. */
export interface RouteContext extends ExecutionContext {
  workspaceRoot: string;
  config: AxiomConfig;
  ui: CommandUI;
  signal: AbortSignal;
}

export interface RouteResult {
  route: IssueTicket['route'];
  text: string;
  data?: unknown;
}

export async function runRoute(ticket: IssueTicket, issue: string, ctx: RouteContext): Promise<RouteResult> {
  // TODO(A2)
  return { route: ticket.route, text: 'chưa làm (A2)' };
}
