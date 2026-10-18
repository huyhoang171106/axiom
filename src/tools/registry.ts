// src/tools/registry.ts - ToolRegistry for managing and executing deterministic tools
import crypto from 'node:crypto';
import { redact } from '../core/secrets.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { BaseTool, type ToolExecutionContext, type ToolSummarizer } from './base-tool.js';
import { BashTool } from './bash.js';
import { ReadTool } from './read.js';
import { WriteTool } from './write.js';
import { EditTool } from './edit.js';
import { ListDirTool } from './list-dir.js';
import { SearchCodeTool } from './search-code.js';
import { decide, type Approver, type PolicyDecision } from './permissions.js';

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

  /**
   * Tools outside this list cannot be registered at all: a role-scoped registry (Reviewer, plan mode) is
   * enforced by what the model is offered, not by asking it nicely in the prompt. Undefined = no limit.
   */
  private readonly allowed?: ReadonlySet<string>;

  /** `allowed` limits the registry to those tool names; omit it for the full standard set. */
  constructor(allowed?: readonly string[]) {
    this.allowed = allowed ? new Set(allowed) : undefined;
    for (const tool of [new BashTool(), new ReadTool(), new WriteTool(), new EditTool(), new ListDirTool(), new SearchCodeTool()]) {
      if (!this.allowed || this.allowed.has(tool.name)) this.registerTool(tool);
    }
  }

  registerTool(tool: BaseTool): void {
    if (this.allowed && !this.allowed.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is not allowed in this registry (allowed: ${[...this.allowed].join(', ')})`);
    }
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
    context: { workspaceRoot: string; summarize?: ToolSummarizer; toolCallId?: string }
  ): Promise<ToolResult> {
    // Keep the model's call id so trace lines join a tool call to its result; mint one only for direct calls.
    const toolCallId = context.toolCallId ?? `call_${crypto.randomUUID()}`;
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

    let policy: PolicyDecision | undefined;
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
      const gate = await this.gate(name, args, context.workspaceRoot);
      policy = gate.policy;
      if (gate.refusal) throw new Error(gate.refusal);
      args = gate.args;
      // Tool output goes to the model and the trace; a key a tool happened to print must not travel with it.
      const output = redact(await tool.execute(args, context as ToolExecutionContext));
      const durationMs = Date.now() - startTime;

      return {
        toolCallId,
        name,
        output,
        isError: false,
        metadata: {
          durationMs,
          success: true,
          policy,
        },
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      // A failed command carries its output in the error message too.
      const errorMessage = redact(err instanceof Error ? err.message : String(err));

      return {
        toolCallId,
        name,
        output: `Error executing ${name}: ${errorMessage}`,
        error: errorMessage,
        isError: true,
        metadata: {
          durationMs,
          success: false,
          policy,
        },
      };
    }
  }

  /**
   * The single policy checkpoint every tool call passes. `deny` never reaches a human; `ask` needs an approver
   * (or the explicit unattended opt-out). Human-edited arguments are checked again, so an edit cannot turn an
   * approved call into a denied one.
   */
  private async gate(
    name: string,
    args: Record<string, unknown>,
    workspaceRoot: string
  ): Promise<{ args: Record<string, unknown>; policy: PolicyDecision & { approval?: string }; refusal?: string }> {
    const policy = decide(name, args, workspaceRoot);
    if (policy.verdict === 'deny') {
      return { args, policy, refusal: `Blocked by policy (${policy.reason}). This action is never allowed; do not retry it in another form.` };
    }
    if (policy.verdict === 'allow') return { args, policy };
    if (!this.approver) {
      if (this.allowWithoutApprover) return { args, policy: { ...policy, approval: 'unattended' } };
      return {
        args,
        policy,
        refusal: `Refusing "${name}" (${policy.reason}): no approver is installed and unattended execution was not enabled.`,
      };
    }
    const answer = await this.approver({ name, args, reason: policy.reason });
    if (answer === 'deny') {
      return {
        args,
        policy: { ...policy, approval: 'denied' },
        refusal: `Denied by user (${policy.reason}). Do not retry the same action; choose a safer alternative or ask the user.`,
      };
    }
    if (answer === 'approve') return { args, policy: { ...policy, approval: 'approved' } };
    const recheck = decide(name, answer.editedArgs, workspaceRoot);
    if (recheck.verdict === 'deny') {
      return { args, policy: recheck, refusal: `Blocked by policy after edit (${recheck.reason}).` };
    }
    return { args: answer.editedArgs, policy: { ...policy, approval: 'edited' } };
  }
}
