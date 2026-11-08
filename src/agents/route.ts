// src/agents/route.ts - Chọn workflow đích từ IssueTicket, chạy ngoài graph triage.
import { answerQuestion } from './ask.js';
import { fixIssue } from './fix.js';
import { runFeature } from './feature.js';
import { loadCatalog } from '../llm/catalog/index.js';
import { resolveModel, createProviderFor } from '../llm/model-resolver.js';
import { createEmbedder, embedIdentity, embedModelFromConfig } from '../core/rag/embedder.js';

import type { CommandUI, ExecutionContext } from '../core/execution-context.js';
import type { AxiomConfig } from '../core/types.js';
import type { IssueTicket } from './triage.js';

/** Dùng context của phiên để workflow giữ quyền duyệt, trace và chi phí chung với chat. */
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

// Seam cho test: thay workflow bằng spy/fake nhưng vẫn kiểm resolver và context thật.
// Khi không truyền deps, ứng dụng gọi các workflow thật do B/C/D sở hữu.
export interface RouteDeps {
  answer: typeof answerQuestion;
  fix: typeof fixIssue;
  feature: typeof runFeature;
}

export async function runRoute(ticket: IssueTicket, issue: string, ctx: RouteContext,
  deps: RouteDeps = { answer: answerQuestion, fix: fixIssue, feature: runFeature }): Promise<RouteResult> {
  // Hai route thụ động không cần provider hay embedding; chỉ hiển thị field có trong schema.
  if (ticket.route === 'ask_user' || ticket.route === 'reject') {
    return { route: ticket.route, text: `[${ticket.type}] ${ticket.priority}\n${ticket.missing_info.map(q => `- ${q}`).join('\n')}` };
  }
  // Resolve trước khi gọi provider: API nhận ID thật, không nhận selector @role.
  const info = resolveModel(ticket.route === 'answer' ? '@default' : '@code', loadCatalog(), ctx.config);
  const provider = await createProviderFor(info);
  // Không dựng registry/tracker mới: duyệt tool và tổng chi phí phải tiếp tục thuộc cùng phiên.
  const opts = { workspaceRoot: ctx.workspaceRoot, provider, model: info.id, bus: ctx.bus,
    tools: ctx.tools, costTracker: ctx.costTracker, ui: ctx.ui, signal: ctx.signal };
  if (ticket.route === 'answer') {
    // Chỉ RAG cần @embed; fix/implement vẫn chạy được khi chưa cấu hình model embedding.
    // Resolve một lần để embedder và định danh index luôn cùng provider, wire, endpoint và model.
    // Selector/alias không đủ: đổi endpoint mà giữ selector vẫn phải dựng lại index.
    const embedInfo = embedModelFromConfig(ctx.config);
    const data = await deps.answer(issue, { ...opts,
      embedder: createEmbedder(embedInfo, { costTracker: ctx.costTracker, signal: ctx.signal }),
      embedModel: embedIdentity(embedInfo) });
    return { route: ticket.route, text: data.text, data };
  }
  if (ticket.route === 'fix') {
    const data = await deps.fix({ ...opts, issue });
    return { route: ticket.route, text: data.summary, data };
  }
  const data = await deps.feature(issue, opts);
  return { route: ticket.route, text: data.summary, data };
}
