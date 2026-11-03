// src/commands/types.ts - Command contract shared by TUI slash commands and headless `axiom <command>` (tui.md section 9)

import type { CommandUI, ExecutionContext } from '../core/execution-context.js';
import type { AxiomConfig } from '../core/types.js';
import type { ModelInfo } from '../llm/catalog/index.js';

// Lives in core so agents (workflows) can take a UI without importing commands.
export type { CommandUI } from '../core/execution-context.js';

/** `tools`, `bus`, `costTracker`, `runId` come from the session (`ExecutionContext`), shared with chat. */
export interface CommandContext extends ExecutionContext {
  config: AxiomConfig;
  workspaceRoot: string;
  ui: CommandUI;
  signal: AbortSignal;
  session: { model: ModelInfo; setModel(info: ModelInfo): void };
}

/** Kết quả có cấu trúc. TUI vẽ theo `kind`. Headless in `text`, hoặc in `data` nếu có `--json`. */
export interface CommandResult {
  kind: string;   // ví dụ 'issue-ticket', 'review-report'
  data: unknown;
  text: string;
}

export interface Command {
  name: string;          // không có dấu '/'
  summary: string;       // 1 dòng, hiện trong gợi ý và /help
  usage: string;         // ví dụ '/triage <nội dung issue>'
  requires?: string[];   // connector cần có (Phase 3)
  run(args: string, ctx: CommandContext): Promise<CommandResult | void>;
}
