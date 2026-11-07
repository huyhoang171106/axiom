// src/commands/permission-session.ts - Nối trạng thái mode/plan vào API phiên mà không đổi CommandContext.
import path from 'node:path';
import type { AgentLoop } from '../core/agent-loop.js';
import { SessionManager } from '../core/session.js';
import { axiomHome } from '../core/paths.js';
import { PLAN_MODE_SYSTEM_DIRECTIVE } from '../tools/permissions.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { CommandContext, CommandResult } from './types.js';

type Mode = 'read-only' | 'edit';
const sessions = new WeakMap<ToolRegistry, PermissionSession>();

export class PermissionSession {
  private agent?: AgentLoop;
  constructor(private manager: SessionManager, private readonly tools: ToolRegistry) {}

  get mode(): Mode { return this.manager.getPermissionMode() === 'read-only' ? 'read-only' : 'edit'; }
  get planning(): boolean { return this.manager.getPlanMode(); }

  /** Agent được tạo lười; chuyển state đã đặt bằng slash command sang phiên chat thật. */
  bind(agent: AgentLoop): void {
    const mode = this.mode;
    const planning = this.planning;
    const previous = this.manager.requireSession().previousMode;
    if (!agent.sessionManager.getSession()) agent.sessionManager.createSession();
    this.manager = agent.sessionManager;
    this.manager.setPermissionMode(mode);
    this.manager.setPlanMode(planning, previous);
    this.agent = agent;
    this.sync();
  }

  setMode(mode: Mode): void {
    // Chọn mode tường minh kết thúc plan; /plan off về sau không ghi đè lựa chọn mới.
    this.manager.setPlanMode(false);
    this.manager.setPermissionMode(mode);
    this.sync();
  }

  setPlan(enabled: boolean): void {
    if (enabled && !this.planning) {
      this.manager.setPlanMode(true, this.mode);
      this.manager.setPermissionMode('read-only');
    } else if (!enabled && this.planning) {
      const previous = this.manager.requireSession().previousMode;
      this.manager.setPlanMode(false);
      this.manager.setPermissionMode(previous === 'read-only' ? 'read-only' : 'edit');
    }
    this.sync();
  }

  private sync(): void {
    this.tools.setPermissionMode(this.mode);
    if (this.planning) this.agent?.appendSystemPrompt(PLAN_MODE_SYSTEM_DIRECTIVE);
    else this.agent?.removeSystemPromptDirective(PLAN_MODE_SYSTEM_DIRECTIVE);
  }

  result(): CommandResult {
    return { kind: 'mode', data: { mode: this.mode, planMode: this.planning },
      text: `Mode: ${this.mode}${this.planning ? ' (plan)' : ''}` };
  }
}

/** Cùng registry phiên = cùng state cho mọi CommandContext, kể cả slash command đầu tiên. */
export function permissionSession(ctx: Pick<CommandContext, 'tools' | 'workspaceRoot'>): PermissionSession {
  let session = sessions.get(ctx.tools);
  if (!session) {
    // Transient holder until bind(): autoSave would leave empty sessions in /resume listings.
    const manager = new SessionManager({ workspaceRoot: ctx.workspaceRoot, sessionsDir: path.join(axiomHome(), 'sessions'), autoSave: false });
    manager.createSession();
    session = new PermissionSession(manager, ctx.tools);
    sessions.set(ctx.tools, session);
  }
  return session;
}
