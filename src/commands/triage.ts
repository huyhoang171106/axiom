// src/commands/triage.ts - Dùng chung luồng phân loại, duyệt và dispatch cho CLI/TUI.
import { newThreadId, traceNode } from '../core/graph.js';
import { runGraph } from '../core/human-gate.js';
import { runRoute, type RouteDeps, type RouteResult } from '../agents/route.js';

import { buildTriageGraph, type TriageGraphState, type IssueTicket } from '../agents/triage.js';
import { loadCatalog } from '../llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../llm/model-resolver.js';
import type { Command, CommandResult } from './types.js';

/** Headless in bản text; TUI có thể dùng ticket có cấu trúc để render theo kind. */
export function formatIssueTicket(ticket: IssueTicket, warnings: string[]): string {
  const lines: string[] = [`[${ticket.type}] ${ticket.priority}`, `Route: ${ticket.route}`];
  const section = (title: string, items: string[], numbered = false) => {
    if (items.length === 0) return;
    lines.push('', `${title}:`);
    items.forEach((item, i) => lines.push(numbered ? `${i + 1}. ${item}` : `- ${item}`));
  };
  section('Affected files', ticket.affected_files);
  section('Reproduction steps', ticket.reproduction_steps, true);
  section('Acceptance criteria', ticket.acceptance_criteria);
  section('Missing info', ticket.missing_info);
  for (const warning of warnings) lines.push('', `Warning: ${warning}`);
  return lines.join('\n');
}

// Test thay workflow qua seam RouteDeps; graph, resolver và command vẫn chạy thật.
export function createTriageCommand(deps?: RouteDeps): Command {
  return {
    name: 'triage',
    summary: 'Turn an issue into an IssueTicket',
    usage: '/triage <issue text>',
    async run(args, ctx): Promise<CommandResult> {
      const issue = args.trim() || (await ctx.ui.ask('Issue: ')).trim();
      if (!issue) throw new Error('Issue cannot be empty. Provide issue text to /triage.');
      // Phân loại dùng @smol; model cho workflow đích được resolve riêng trong runRoute.
      const info = resolveModel('@smol', loadCatalog(), ctx.config);
      const provider = await createProviderFor(info);
      const graph = buildTriageGraph({
        issue,
        workspaceRoot: ctx.workspaceRoot,
        provider,
        model: info.id,
        signal: ctx.signal,
        bus: ctx.bus,
        costTracker: ctx.costTracker,
        tools: ctx.tools,
      });
      // runGraph xử lý interrupt/resume qua ui.confirm chung, không tự hỏi riêng cho CLI/TUI.
      const threadId = newThreadId('triage');
      const { ticket, warnings, confirmed } = await runGraph<TriageGraphState>(graph,
        { issue, ticket: null, warnings: [], confirmed: false }, { threadId, ui: ctx.ui, signal: ctx.signal });
      if (!ticket) throw new Error('Triage returned no ticket');
      let result: RouteResult = { route: ticket.route, text: 'Đã dừng theo yêu cầu.' };
      if (confirmed) {
        // Chỉ dispatch sau khi graph kết thúc để interrupt của workflow con không lặp route.
        // Bọc trace thủ công và giữ thread ID để log vẫn nối được triage -> confirm -> route.
        await traceNode(ctx.bus, 'triage', 'route', async () => {
          result = await runRoute(ticket, issue, ctx, deps);
          return {};
        })({}, { configurable: { thread_id: threadId } });
      }
      return {
        kind: 'issue-ticket',
        data: { ticket, warnings, result },
        text: `${formatIssueTicket(ticket, warnings)}\n\n${result.text}`,
      };
    },
  };
}

export const triageCommand = createTriageCommand();
