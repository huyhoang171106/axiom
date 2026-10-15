// src/commands/types.ts - Command contract shared by TUI slash commands and headless `axiom <command>` (tui.md section 9)

import type { AxiomConfig } from '../core/types.js';
import type { ModelInfo } from '../llm/catalog/index.js';

/** TUI và headless mỗi bên có một bản cài đặt riêng. Command không biết mình chạy ở đâu. */
export interface CommandUI {
  print(text: string): void;
  ask(question: string, opts?: { secret?: boolean }): Promise<string>; // headless không có TTY: throw
  confirm(question: string): Promise<boolean>;                          // headless không có TTY: false
}

export interface CommandContext {
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
