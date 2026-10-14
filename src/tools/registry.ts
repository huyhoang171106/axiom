// src/tools/registry.ts - ToolRegistry for managing and executing deterministic tools
import crypto from 'node:crypto';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { BaseTool, type ToolExecutionContext, type ToolSummarizer } from './base-tool.js';
import { BashTool } from './bash.js';
import { ReadTool } from './read.js';
import { WriteTool } from './write.js';
import { EditTool } from './edit.js';
import { needsApproval, type Approver } from './permissions.js';

export class ToolRegistry {
  private readonly tools: Map<string, BaseTool> = new Map();
  /** When set, risky calls (see permissions.ts) are only executed if this resolves true. */
  public approver?: Approver;
  /**
   * Explicit opt-out for callers that run unattended on purpose: the CLI with `--yes`, unattended callers and
   * sandboxes. Without it — or an approver — a risky call is refused rather than executed, because
   * the old default (no approver ⇒ no gate at all) silently un-gated every embedding that forgot to
   * install one.
   */
  public allowWithoutApprover = false;

  constructor(registerStandardTools = true) {
    if (registerStandardTools) {
      this.registerTool(new BashTool());
      this.registerTool(new ReadTool());
      this.registerTool(new WriteTool());
      this.registerTool(new EditTool());
    }
  }

  registerTool(tool: BaseTool): void {
    this.tools.set(tool.name, tool);
  }

  /** Removes a tool again, so a per-run tool (goal_complete) cannot leak into later turns. */
  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  getTool(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      definitions.push(tool.toDefinition());
    }
    return definitions;
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    context: { workspaceRoot: string; summarize?: ToolSummarizer }
  ): Promise<ToolResult> {
    const toolCallId = `call_${crypto.randomUUID()}`;
    const startTime = Date.now();

    const tool = this.tools.get(name);
    if (!tool) {
      const durationMs = Date.now() - startTime;
      return {
        toolCallId,
        name,
        output: `Error: Unknown tool "${name}". Available tools: ${Array.from(this.tools.keys()).join(', ')}`,
        error: `Tool "${name}" not found`,
        isError: true,
        metadata: {
          durationMs,
          success: false,
        },
      };
    }

    try {
      // Providers mark tool arguments they could not parse (a truncated stream, a malformed frame) instead of
      // silently running the tool with a `{ raw }` object that means nothing to it.
      if (args && (args as Record<string, unknown>).__invalidJson === true) {
        throw new Error(
          `Tool arguments were not valid JSON (stream truncated?). Re-issue the call with complete JSON arguments. Received: ${String(
            (args as Record<string, unknown>).raw ?? ''
          ).slice(0, 200)}`
        );
      }
      const reason = needsApproval(name, args, context.workspaceRoot);
      if (reason) {
        if (!this.approver) {
          if (!this.allowWithoutApprover) {
            throw new Error(
              `Refusing "${name}" (${reason}): no approver is installed and unattended execution was not enabled.`
            );
          }
        } else if (!(await this.approver({ name, args, reason }))) {
          throw new Error(`Denied by user (${reason}). Do not retry the same action; choose a safer alternative or ask the user.`);
        }
      }
      const output = await tool.execute(args, context as ToolExecutionContext);
      const durationMs = Date.now() - startTime;

      return {
        toolCallId,
        name,
        output,
        isError: false,
        metadata: {
          durationMs,
          success: true,
        },
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      return {
        toolCallId,
        name,
        output: `Error executing ${name}: ${errorMessage}`,
        error: errorMessage,
        isError: true,
        metadata: {
          durationMs,
          success: false,
        },
      };
    }
  }
}
