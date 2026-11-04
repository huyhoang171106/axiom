// src/commands/cost.ts - `cost` command (session)

import type { Command } from './types.js';

export const costCommand: Command = {
  name: 'cost',
  summary: 'Show tokens and cost of this session',
  usage: '/cost',
  async run(_args, ctx) {
    // Context mang tracker của phiên hiện tại, kể cả khi /cost là lệnh đầu tiên.
    // Chỉ đọc snapshot; không gọi model, ghi usage hay reset tổng phiên.
    const summary = ctx.costTracker.getSessionSummary();
    const rows = Object.entries(summary.byModel).map(([model, usage]) =>
      `${model}: input ${usage.promptTokens}, output ${usage.completionTokens}, $${usage.cost.toFixed(6)}`);
    rows.push(`Session: input ${summary.totalPromptTokens}, output ${summary.totalCompletionTokens}, total ${summary.totalTokens}, $${summary.totalCost.toFixed(6)}`);
    // Headless và TUI có thể dùng text ngay; data giữ số liệu có cấu trúc.
    return { kind: 'cost', data: summary, text: rows.join('\n') };
  },
};
