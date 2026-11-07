// src/core/session.ts - Session Persistence and Checkpoint Management

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type {
  SessionState,
  Checkpoint,
  Message,
  TaskPlan,
  VerificationReport,
  TokenUsage,
  PermissionMode,
} from './types.js';

export interface SessionManagerOptions {
  sessionsDir?: string;
  workspaceRoot?: string;
  autoSave?: boolean;
}

export interface SessionSummaryItem {
  id: string;
  createdAt: number;
  updatedAt: number;
  taskPrompt?: string;
  totalCostDollars: number;
  totalTokens: number;
  messageCount: number;
  checkpointCount: number;
}

// Checkpoints hold a full copy of the message log plus file snapshots; keeping them in the main
// session file made every per-message save O(checkpoints x messages). They live in a sidecar now.
const CHECKPOINTS_SUFFIX = '.checkpoints.json';
const MAX_CHECKPOINTS = 50;
const isSessionFile = (file: string): boolean =>
  file.endsWith('.json') && !file.endsWith(CHECKPOINTS_SUFFIX);

export class SessionManager {
  public readonly sessionsDir: string;
  public readonly workspaceRoot: string;
  public readonly autoSave: boolean;
  private currentSession: SessionState | null = null;

  constructor(options: SessionManagerOptions = {}) {
    this.sessionsDir = options.sessionsDir || path.join(os.homedir(), '.axiom', 'sessions');
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.autoSave = options.autoSave ?? true;
    this.ensureDirectoryExists(this.sessionsDir);
  }

  public getSession(): SessionState | null {
    return this.currentSession;
  }

  public getPermissionMode(): PermissionMode {
    return this.currentSession?.permissionMode ?? 'edit';
  }

  public setPermissionMode(mode: PermissionMode): void {
    const session = this.requireSession();
    session.permissionMode = mode;
    if (this.autoSave) {
      this.saveSession();
    }
  }

  public getPlanMode(): boolean {
    return this.currentSession?.planMode ?? false;
  }

  public setPlanMode(enabled: boolean, previousMode?: PermissionMode): void {
    const session = this.requireSession();
    session.planMode = enabled;
    if (previousMode !== undefined) {
      session.previousMode = previousMode;
    }
    if (this.autoSave) {
      this.saveSession();
    }
  }

  public requireSession(): SessionState {
    if (!this.currentSession) {
      throw new Error('No active session. Call createSession() or loadSession() first.');
    }
    return this.currentSession;
  }

  public createSession(taskPrompt?: string, customId?: string): SessionState {
    const now = Date.now();
    const id = customId || `session_${now}_${crypto.randomBytes(4).toString('hex')}`;

    const newSession: SessionState = {
      id,
      createdAt: now,
      updatedAt: now,
      taskPrompt,
      workspaceRoot: this.workspaceRoot,
      messages: [],
      totalCostDollars: 0,
      totalTokens: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costEstimate: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      verificationReports: [],
      checkpoints: [],
      activeFiles: [],
      permissionMode: 'edit',
      planMode: false,
    };

    this.currentSession = newSession;

    if (this.autoSave) {
      this.saveSession();
    }

    return newSession;
  }

  public saveSession(): void {
    if (!this.currentSession) {
      return;
    }

    this.currentSession.updatedAt = Date.now();
    this.ensureDirectoryExists(this.sessionsDir);

    this.writeAtomic(this.getSessionFilePath(this.currentSession.id), {
      ...this.currentSession,
      checkpoints: [],
    });
  }

  private writeAtomic(filePath: string, payload: unknown): void {
    const tempPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf-8');
    fs.renameSync(tempPath, filePath);
  }

  private getCheckpointsPath(sessionId: string): string {
    return `${this.getSessionFilePath(sessionId).replace(/\.json$/, '')}${CHECKPOINTS_SUFFIX}`;
  }

  private saveCheckpoints(): void {
    const session = this.currentSession;
    if (!session) return;
    this.writeAtomic(this.getCheckpointsPath(session.id), session.checkpoints);
  }

  private readCheckpoints(sessionId: string): Checkpoint[] {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.getCheckpointsPath(sessionId), 'utf-8'));
      return Array.isArray(parsed) ? (parsed as Checkpoint[]) : [];
    } catch {
      return []; // no sidecar yet, or unreadable: a session without checkpoints is still usable
    }
  }

  public loadSession(sessionId: string): SessionState {
    this.ensureDirectoryExists(this.sessionsDir);

    let targetFile: string | null = null;
    const directPath = this.getSessionFilePath(sessionId);

    if (fs.existsSync(directPath)) {
      targetFile = directPath;
    } else {
      const files = fs.readdirSync(this.sessionsDir).filter(isSessionFile);
      const matchingFile = files.find((file) => file.includes(sessionId));
      if (matchingFile) {
        targetFile = path.join(this.sessionsDir, matchingFile);
      }
    }

    if (!targetFile || !fs.existsSync(targetFile)) {
      throw new Error(`Session file not found for ID: "${sessionId}" in ${this.sessionsDir}`);
    }

    const content = fs.readFileSync(targetFile, 'utf-8');
    const parsed = JSON.parse(content) as SessionState;
    parsed.checkpoints = this.readCheckpoints(parsed.id || sessionId);

    this.currentSession = this.normalizeSessionState(parsed);
    return this.currentSession;
  }

  public resumeLastSession(): SessionState | null {
    this.ensureDirectoryExists(this.sessionsDir);

    // Newest by file mtime (every save rewrites the file); parse only the newest readable one instead of all of them.
    const files = fs
      .readdirSync(this.sessionsDir)
      .filter(isSessionFile)
      .flatMap((fileName) => {
        try {
          return [{ fileName, mtimeMs: fs.statSync(path.join(this.sessionsDir, fileName)).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.fileName.localeCompare(a.fileName));

    for (const { fileName } of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, fileName), 'utf-8')) as Partial<SessionState>;
        // Checkpoints live in the sidecar; without this, a resumed session always reported
        // "No checkpoints available" even though its `<id>.checkpoints.json` was on disk.
        parsed.checkpoints = this.readCheckpoints(parsed.id || fileName.replace(/\.json$/, ''));
        this.currentSession = this.normalizeSessionState(parsed);
        return this.currentSession;
      } catch {
        // malformed session file: try the next newest
      }
    }
    return null;
  }

  public listSessions(): SessionSummaryItem[] {
    this.ensureDirectoryExists(this.sessionsDir);

    const files = fs.readdirSync(this.sessionsDir).filter(isSessionFile);
    const summaries: SessionSummaryItem[] = [];

    for (const file of files) {
      try {
        const fullPath = path.join(this.sessionsDir, file);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const session = JSON.parse(content) as SessionState;

        summaries.push({
          id: session.id,
          createdAt: session.createdAt || 0,
          updatedAt: session.updatedAt || session.createdAt || 0,
          taskPrompt: session.taskPrompt,
          totalCostDollars: session.totalCostDollars || 0,
          totalTokens: session.totalTokens?.totalTokens || 0,
          messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
          // The main session file is always written with `checkpoints: []` (they live in the sidecar),
          // so counting here reported 0 for every session regardless of its real checkpoints.
          checkpointCount: this.readCheckpoints(session.id || file.replace(/\.json$/, '')).length,
        });
      } catch {
        // Skip malformed session files
      }
    }

    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public deleteSession(sessionId: string): boolean {
    const filePath = this.getSessionFilePath(sessionId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      try {
        fs.unlinkSync(this.getCheckpointsPath(sessionId));
      } catch {
        // no sidecar
      }
      if (this.currentSession?.id === sessionId) {
        this.currentSession = null;
      }
      return true;
    }
    return false;
  }

  public addMessage(message: Message): void {
    const session = this.requireSession();
    session.messages.push({
      ...message,
      timestamp: message.timestamp ?? Date.now(),
    });
    if (this.autoSave) {
      this.saveSession();
    }
  }

  public setPlan(plan: TaskPlan): void {
    const session = this.requireSession();
    session.plan = plan;
    if (this.autoSave) {
      this.saveSession();
    }
  }

  public updateCost(costDelta: number, tokenDelta?: Partial<TokenUsage>): void {
    const session = this.requireSession();
    session.totalCostDollars = Number((session.totalCostDollars + costDelta).toFixed(6));

    if (tokenDelta) {
      const current = session.totalTokens;
      current.promptTokens += tokenDelta.promptTokens || 0;
      current.completionTokens += tokenDelta.completionTokens || 0;
      current.totalTokens +=
        tokenDelta.totalTokens ||
        (tokenDelta.promptTokens || 0) + (tokenDelta.completionTokens || 0);
      current.costEstimate = Number(
        (current.costEstimate + (tokenDelta.costEstimate || costDelta)).toFixed(6)
      );

      if (tokenDelta.cacheCreationInputTokens) {
        current.cacheCreationInputTokens =
          (current.cacheCreationInputTokens || 0) + tokenDelta.cacheCreationInputTokens;
      }
      if (tokenDelta.cacheReadInputTokens) {
        current.cacheReadInputTokens =
          (current.cacheReadInputTokens || 0) + tokenDelta.cacheReadInputTokens;
      }
    }

    if (this.autoSave) {
      this.saveSession();
    }
  }

  public addVerificationReport(report: VerificationReport): void {
    const session = this.requireSession();
    session.verificationReports.push(report);
    if (this.autoSave) {
      this.saveSession();
    }
  }

  public trackActiveFiles(files: string[]): void {
    const session = this.requireSession();
    const known = new Set(session.activeFiles);
    const added = files.filter((f) => !known.has(f));
    if (added.length === 0) return; // same file touched twice in a step must not cost a rewrite
    session.activeFiles = [...session.activeFiles, ...added];
    if (this.autoSave) {
      this.saveSession();
    }
  }

  public async createCheckpoint(options: {
    step: number;
    description: string;
    filesToSnapshot?: string[];
  }): Promise<Checkpoint> {
    const session = this.requireSession();
    const checkpointId = `cp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    const filesToRead = options.filesToSnapshot || session.activeFiles;
    const filesSnapshot: Record<string, string> = {};

    for (const relPath of filesToRead) {
      try {
        const absPath = path.isAbsolute(relPath)
          ? relPath
          : path.join(this.workspaceRoot, relPath);

        if ((await fs.promises.stat(absPath)).isFile()) {
          filesSnapshot[relPath] = await fs.promises.readFile(absPath, 'utf-8');
        }
      } catch {
        // If file cannot be read, continue
      }
    }

    const stateSnapshot: Partial<SessionState> = {
      taskPrompt: session.taskPrompt,
      plan: session.plan ? structuredClone(session.plan) : undefined,
      messages: structuredClone(session.messages),
      totalCostDollars: session.totalCostDollars,
      totalTokens: { ...session.totalTokens },
      activeFiles: [...session.activeFiles],
      verificationReports: session.verificationReports ? structuredClone(session.verificationReports) : [],
    };

    const checkpoint: Checkpoint = {
      id: checkpointId,
      timestamp: Date.now(),
      step: options.step,
      description: options.description,
      stateSnapshot,
      filesSnapshot,
    };

    session.checkpoints.push(checkpoint);
    if (session.checkpoints.length > MAX_CHECKPOINTS) {
      session.checkpoints.splice(0, session.checkpoints.length - MAX_CHECKPOINTS);
    }

    if (this.autoSave) {
      this.saveSession();
      this.saveCheckpoints();
    }

    return checkpoint;
  }

  public async rollbackToCheckpoint(
    checkpointId: string,
    options: { restoreFiles?: boolean } = {}
  ): Promise<SessionState> {
    const session = this.requireSession();
    const checkpoint = session.checkpoints.find((cp) => cp.id === checkpointId);

    if (!checkpoint) {
      throw new Error(`Checkpoint "${checkpointId}" not found in current session.`);
    }

    const shouldRestoreFiles = options.restoreFiles ?? true;

    if (shouldRestoreFiles && checkpoint.filesSnapshot) {
      for (const [relPath, content] of Object.entries(checkpoint.filesSnapshot)) {
        try {
          const absPath = path.isAbsolute(relPath)
            ? relPath
            : path.join(this.workspaceRoot, relPath);

          await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
          await fs.promises.writeFile(absPath, content, 'utf-8');
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Failed to restore file ${relPath} during rollback: ${message}`);
        }
      }
    }

    if (checkpoint.stateSnapshot) {
      if (checkpoint.stateSnapshot.plan !== undefined) {
        session.plan = checkpoint.stateSnapshot.plan
          ? structuredClone(checkpoint.stateSnapshot.plan)
          : undefined;
      }
      if (checkpoint.stateSnapshot.messages) {
        session.messages = structuredClone(checkpoint.stateSnapshot.messages);
      }
      if (checkpoint.stateSnapshot.activeFiles) {
        session.activeFiles = [...checkpoint.stateSnapshot.activeFiles];
      }
      if (checkpoint.stateSnapshot.totalCostDollars !== undefined) {
        session.totalCostDollars = checkpoint.stateSnapshot.totalCostDollars;
      }
      if (checkpoint.stateSnapshot.totalTokens) {
        session.totalTokens = { ...checkpoint.stateSnapshot.totalTokens };
      }
      if (checkpoint.stateSnapshot.verificationReports !== undefined) {
        session.verificationReports = checkpoint.stateSnapshot.verificationReports
          ? structuredClone(checkpoint.stateSnapshot.verificationReports)
          : [];
      }
    }

    if (this.autoSave) {
      this.saveSession();
    }

    return session;
  }

  public getCheckpoints(): Checkpoint[] {
    const session = this.requireSession();
    return [...session.checkpoints];
  }

  private getSessionFilePath(sessionId: string): string {
    const sanitized = sessionId.replace(/[/\\]/g, '_');
    return path.join(this.sessionsDir, `${sanitized}.json`);
  }

  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private normalizeSessionState(parsed: Partial<SessionState>): SessionState {
    const now = Date.now();
    return {
      id: parsed.id || `session_${now}`,
      createdAt: parsed.createdAt || now,
      updatedAt: parsed.updatedAt || now,
      taskPrompt: parsed.taskPrompt,
      workspaceRoot: parsed.workspaceRoot,
      plan: parsed.plan,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      totalCostDollars: parsed.totalCostDollars || 0,
      totalTokens: parsed.totalTokens || {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costEstimate: 0,
      },
      verificationReports: Array.isArray(parsed.verificationReports)
        ? parsed.verificationReports
        : [],
      checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
      activeFiles: Array.isArray(parsed.activeFiles) ? parsed.activeFiles : [],
      permissionMode: parsed.permissionMode ?? 'edit',
      previousMode: parsed.previousMode,
      planMode: parsed.planMode ?? false,
    };
  }
}

export const defaultSessionManager = new SessionManager();
