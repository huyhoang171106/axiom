// src/tools/base-tool.ts - Abstract BaseTool class for Axiom deterministic tools
import path from 'node:path';
import type { ToolDefinition } from '../core/types.js';

/** A cheap-tier model call exposed to tools that need to process fetched content (web_fetch). */
export type ToolSummarizer = (request: {
  content: string;
  prompt: string;
}) => Promise<{ text: string; model: string } | null>;

export interface ToolExecutionContext {
  workspaceRoot: string;
  /** Set by the agent loop; absent when a tool runs outside a session (tests, one-shot utilities). */
  summarize?: ToolSummarizer;
  [key: string]: unknown;
}

export abstract class BaseTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: Record<string, unknown>;
  /** Side-effect free and approval-free, so the agent loop may run adjacent calls of this kind concurrently. */
  readonly isReadOnly: boolean = false;

  abstract execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<string>;

  toDefinition(): ToolDefinition {
    const raw = this.parameters as {
      type?: 'object';
      properties?: Record<string, unknown>;
      required?: string[];
    };

    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: raw?.properties ?? {},
        ...(Array.isArray(raw?.required) ? { required: raw.required } : {}),
      },
    };
  }

  protected resolvePath(filePath: string, context?: { workspaceRoot?: string }): string {
    const root = context?.workspaceRoot ?? process.cwd();
    return path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  }
}
