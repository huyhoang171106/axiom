// src/tools/registry.ts - ToolRegistry for managing and executing deterministic tools
import crypto from 'node:crypto';
import path from 'node:path';
import { redact } from '../core/secrets.js';
import { recordDecision, redactAuditEntry, type AuditActor, type AuditDecision } from '../core/audit.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import type { EventBus } from '../core/event-bus.js';
import { BaseTool, type ToolExecutionContext, type ToolSummarizer } from './base-tool.js';
import { BashTool } from './bash.js';
import { ReadTool } from './read.js';
import { WriteTool } from './write.js';
import { EditTool } from './edit.js';
import { ListDirTool } from './list-dir.js';
import { SearchCodeTool } from './search-code.js';
import { ApplyPatchTool } from './apply-patch.js';
import { RunTestsTool } from './run-tests.js';
import { decide, READ_ONLY_TOOLS, type Approver, type PolicyDecision } from './permissions.js';
import { actionKeys, canonicalActionPath, commandActions, DeniedActions } from './denied-actions.js';
import { parseUnifiedDiff } from './apply-patch.js';
import { findTestTampering, isTestPath } from './test-guard.js';

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

  /** Set on `scoped()` views: approval state is read from the session registry at call time, never copied. */
  private session?: ToolRegistry;
  private readonly sessionDenied = new DeniedActions();
  private eventBus?: EventBus;
  private sessionRunId?: string;
  private sessionMode: 'read-only' | 'edit' = 'edit';

  /** Đổi quyền tại registry gốc để view cũ và denial cùng giữ nguyên phiên. */
  get permissionMode(): 'read-only' | 'edit' { return (this.session ?? this).sessionMode; }
  setPermissionMode(mode: 'read-only' | 'edit'): void {
    if (mode !== 'read-only' && mode !== 'edit') throw new Error('Only read-only and edit modes are supported.');
    (this.session ?? this).sessionMode = mode;
  }

  private modeAllows(name: string): boolean {
    return this.permissionMode === 'edit' || (READ_ONLY_TOOLS as readonly string[]).includes(name);
  }

  /** Mọi view cùng phiên đọc trực tiếp state gốc; đổi view không làm mất denial. */
  get denied(): DeniedActions { return (this.session ?? this).sessionDenied; }

  /** Session event bus: views created via scoped() inherit this automatically. */
  get bus(): EventBus | undefined { return (this.session ?? this).eventBus; }
  set bus(b: EventBus | undefined) { (this.session ?? this).eventBus = b; }

  /** Session runId: views created via scoped() inherit this automatically. */
  get runId(): string | undefined { return (this.session ?? this).sessionRunId; }
  set runId(id: string | undefined) { (this.session ?? this).sessionRunId = id; }

  /** `allowed` limits the registry to those tool names; omit it for the full standard set. */
  constructor(allowed?: readonly string[]) {
    this.allowed = allowed ? new Set(allowed) : undefined;
    for (const tool of [
      new BashTool(), new ReadTool(), new WriteTool(), new EditTool(), new ListDirTool(), new SearchCodeTool(),
      new ApplyPatchTool(), new RunTestsTool(),
    ]) {
      if (!this.allowed || this.allowed.has(tool.name)) this.registerTool(tool);
    }
  }

  /**
   * A view for one workflow node: only `allowed` tools (never more than this registry allows; tools not in it
   * may be registered on the view, e.g. `submit_*`), sharing this registry's tool instances and its approver
   * and unattended opt-out as they are when a call is made, not when the view was created.
   */
  scoped(allowed: readonly string[]): ToolRegistry {
    const names = this.allowed
      ? allowed.filter((name) => this.allowed!.has(name) || name.startsWith('submit_'))
      : allowed;
    const view = new ToolRegistry(names);
    view.session = this.session ?? this;
    view.tools.clear();
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) view.tools.set(name, tool);
    }
    return view;
  }

  /** Trả về true nếu registry ở chế độ chỉ đọc (không chứa hoặc không cho phép write_file, edit, apply_patch). */
  public isReadOnly(): boolean {
    if (this.permissionMode === 'read-only') return true;
    if (this.allowed) {
      return !this.allowed.has('write_file') && !this.allowed.has('edit') && !this.allowed.has('apply_patch');
    }
    return !this.tools.has('write_file') && !this.tools.has('edit') && !this.tools.has('apply_patch');
  }

  registerTool(tool: BaseTool): void {
    if (this.allowed && !this.allowed.has(tool.name) && !tool.name.startsWith('submit_')) {
      throw new Error(`Tool "${tool.name}" is not allowed in this registry (allowed: ${[...this.allowed].join(', ')})`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Removes a tool again, so a per-run tool (goal_complete) cannot leak into later turns. */
  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  getTool(name: string): BaseTool | undefined {
    return this.modeAllows(name) ? this.tools.get(name) : undefined;
  }

  hasTool(name: string): boolean {
    return this.modeAllows(name) && this.tools.has(name);
  }

  getDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      if (this.modeAllows(tool.name)) definitions.push(tool.toDefinition());
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
      // Gate có await; kiểm lại ngay trước execution, kể cả khi nhánh đầu là allow.
      const finalPolicy = this.checkPolicy(name, args, context.workspaceRoot);
      this.auditPolicyChange(name, args, policy, finalPolicy);
      if (finalPolicy.verdict === 'deny') {
        policy = finalPolicy;
        throw new Error(`Blocked by policy before execution (${finalPolicy.reason}).`);
      }
      if (finalPolicy.verdict === 'ask' && policy.verdict === 'allow') {
        policy = finalPolicy;
        this.audit(name, args, { ...policy, reason: 'Policy changed before execution; approval required.' }, 'auto-deny', 'policy');
        throw new Error('Policy changed before execution; submit the action again for approval.');
      }
      if (['edit', 'write_file'].includes(name) && typeof args.path === 'string') {
        // Pin path trước I/O async; C2 kiểm test guard trên tên thật thay vì alias.
        args = { ...args, path: canonicalActionPath(args.path.trim(), context.workspaceRoot) };
      }
      // Tool output goes to the model and the trace; a key a tool happened to print must not travel with it.
      const output = redact(await tool.execute(args, context as ToolExecutionContext));
      const durationMs = Date.now() - startTime;
      // Tools that report a failure as an `Error: ...` string instead of throwing must not count as a success.
      const isError = /^Error\b/.test(output);

      return {
        toolCallId,
        name,
        output,
        ...(isError && { error: output }),
        isError,
        metadata: {
          durationMs,
          success: !isError,
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
    const policy = this.checkPolicy(name, args, workspaceRoot);
    this.audit(name, args, policy, policy.verdict, 'policy');
    if (policy.verdict === 'deny') {
      return { args, policy, refusal: `Blocked by policy (${policy.reason}). This action is never allowed; do not retry it in another form.` };
    }
    if (policy.verdict === 'allow') return { args, policy };
    const { approver, allowWithoutApprover } = this.session ?? this;
    if (!approver) {
      if (allowWithoutApprover) {
        this.audit(name, args, policy, 'unattended', 'headless');
        return { args, policy: { ...policy, approval: 'unattended' } };
      }
      this.audit(name, args, { ...policy, reason: `No approver installed: ${policy.reason}` }, 'auto-deny', 'headless');
      return {
        args,
        policy,
        refusal: `Refusing "${name}" (${policy.reason}): no approver is installed and unattended execution was not enabled.`,
      };
    }
    const originalKeys = actionKeys(name, args, workspaceRoot);
    let answer;
    try {
      answer = await approver({ name, args: structuredClone(args), reason: policy.reason, risk: policy.risk });
    } catch (error) {
      this.audit(name, args, { ...policy, reason: `Approval failed: ${error instanceof Error ? error.message : String(error)}` }, 'auto-deny', 'policy');
      throw error;
    }
    if (answer === 'deny') {
      for (const key of originalKeys) {
        // Từ chối lệnh ghép không cấm luôn đoạn đọc vô hại đứng cạnh hành động rủi ro.
        if (name === 'run_command' && key.startsWith('run_command:[')) {
          const [, words] = JSON.parse(key.slice('run_command:'.length)) as [string, string[]];
          if (['ls', 'cat', 'head', 'tail', 'stat', 'wc', 'pwd', 'echo', 'whoami', 'id', 'which'].includes(words[0])) continue;
        }
        this.denied.add(key);
      }
      this.audit(name, args, policy, 'reject', 'user');
      return {
        args,
        policy: { ...policy, approval: 'denied' },
        refusal: `Denied by user (${policy.reason}). Do not retry the same action; choose a safer alternative or ask the user.`,
      };
    }
    if (answer === 'approve') {
      // Path có thể đổi qua symlink trong lúc chờ duyệt; approval không vượt hard deny mới.
      const recheck = this.checkPolicy(name, args, workspaceRoot);
      this.audit(name, args, recheck, 'approve', 'user');
      this.auditPolicyChange(name, args, policy, recheck);
      if (recheck.verdict === 'deny') {
        return { args, policy: recheck, refusal: `Blocked by policy after approval (${recheck.reason}).` };
      }
      return { args, policy: { ...recheck, approval: 'approved' } };
    }
    const recheck = this.checkPolicy(name, answer.editedArgs, workspaceRoot);
    this.audit(name, answer.editedArgs, recheck, 'edited', 'user');
    this.auditPolicyChange(name, answer.editedArgs, policy, recheck);
    if (recheck.verdict === 'deny') {
      return { args, policy: recheck, refusal: `Blocked by policy after edit (${recheck.reason}).` };
    }
    return { args: answer.editedArgs, policy: { ...recheck, approval: 'edited' } };
  }

  /** Ghi trước khi chạy tool; lỗi lưu audit phải chặn hành động, không bỏ qua. */
  private audit(name: string, args: Record<string, unknown>, policy: PolicyDecision, decision: AuditDecision, approver: AuditActor): void {
    // Caller độc lập vẫn có định danh ổn định; context phiên cung cấp runId của trace.
    this.runId ??= crypto.randomUUID();
    const entry = redactAuditEntry({ at: new Date().toISOString(), runId: this.runId,
      tool: name, args, reason: policy.reason, risk: policy.risk ?? 'high', decision, approver });
    recordDecision(entry);
    this.bus?.emit('approval', entry);
  }

  /** Chỉ thêm quyết định policy mới khi recheck đổi kết quả, tránh ghi lặp quyết định cũ. */
  private auditPolicyChange(name: string, args: Record<string, unknown>, before: PolicyDecision, after: PolicyDecision): void {
    if (before.verdict !== after.verdict || before.risk !== after.risk || before.reason !== after.reason) {
      this.audit(name, args, after, after.verdict, 'policy');
    }
  }

  /** Một checkpoint cho args gốc, args edited và filesystem hiện tại, không đường tắt approver. */
  private checkPolicy(name: string, args: Record<string, unknown>, workspaceRoot: string): PolicyDecision {
    // Kiểm cả lúc recheck sau approval: view đã tạo trước đổi mode không được giữ quyền ghi.
    if (!this.modeAllows(name)) return { verdict: 'deny', risk: 'high', reason: `tool ${name} is unavailable in read-only mode` };
    let keys: string[];
    try { keys = actionKeys(name, args, workspaceRoot); }
    catch (error) {
      return { verdict: 'deny', risk: 'high', reason: `cannot identify actions: ${error instanceof Error ? error.message : String(error)}` };
    }
    const denied = keys.find((key) => this.denied.has(key));
    if (denied) return { verdict: 'deny', risk: 'high', reason: `same action was denied earlier in this session: ${denied}` };
    let commandPolicy: PolicyDecision | undefined;
    if (name === 'run_command') {
      const actions = commandActions(String(args.command ?? ''), workspaceRoot);
      if (this.denied.size && actions.opaque) {
        return { verdict: 'deny', risk: 'high', reason: 'cannot establish command identity while this session has denied actions' };
      }
      for (const key of actions.keys) {
        if (!key.startsWith('run_command:[')) continue;
        const [, words] = JSON.parse(key.slice('run_command:'.length)) as [string, string[]];
        if (!/^[a-zA-Z0-9_-]+$/.test(words[0])) continue;
        const command = [words[0], ...words.slice(1).map((word) => `'${word.replace(/'/g, `'\\''`)}'`)].join(' ');
        const inner = decide(name, { command }, workspaceRoot);
        if (inner.verdict === 'deny') return inner;
        if (inner.verdict === 'ask' && (!commandPolicy || inner.risk === 'high')) commandPolicy = inner;
      }
      for (const target of actions.mutationPaths) {
        const policy = decide('write_file', { path: target }, workspaceRoot);
        if (policy.verdict === 'deny') return policy;
        if (isTestPath(path.relative(workspaceRoot, target))) {
          return { verdict: 'deny', risk: 'high', reason: `shell mutation of test path (${target}); use a guarded file tool` };
        }
      }
    }
    const policy = decide(name, args, workspaceRoot);
    if (policy.verdict === 'deny') return policy;
    if (name === 'apply_patch') {
      // C2 nhận cả path thật để alias symlink không che được tên tests/ hoặc conftest.py.
      const original = parseUnifiedDiff(String(args.patch ?? ''));
      const patches = original.map((patch) => ({
        ...patch,
        oldPath: patch.oldPath === null ? null : canonicalActionPath(patch.oldPath, workspaceRoot),
        newPath: patch.newPath === null ? null : canonicalActionPath(patch.newPath, workspaceRoot),
      }));
      const hasAlias = original.some((patch) => [patch.oldPath, patch.newPath].some((p) => {
        if (p === null) return false;
        const lexical = path.resolve(workspaceRoot, p);
        return path.relative(workspaceRoot, canonicalActionPath(p, workspaceRoot)) !== path.relative(workspaceRoot, lexical);
      }));
      const tamper = hasAlias ? findTestTampering(patches, workspaceRoot) : null;
      if (tamper) return { verdict: 'deny', risk: 'high', reason: tamper };
    }
    if (['edit', 'write_file'].includes(name) && typeof args.path === 'string') {
      // Policy phải thấy tên thật của cấu hình nhạy cảm qua alias.
      const canonical = canonicalActionPath(args.path.trim(), workspaceRoot);
      const canonicalPolicy = decide(name, { ...args, path: canonical }, workspaceRoot);
      if (canonicalPolicy.verdict === 'deny') return canonicalPolicy;
      if (canonicalPolicy.risk === 'high') return canonicalPolicy;
    }
    return policy.risk === 'high' ? policy : commandPolicy ?? policy;
  }
}
