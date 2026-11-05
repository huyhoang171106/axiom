// src/core/task-state.ts - Durable state of a multi-step task: goal, acceptance, steps (UC-04)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { axiomHome } from './paths.js';

export type StepStatus = 'todo' | 'doing' | 'done' | 'failed';
export interface PlanStep { id: number; title: string; files: string[]; status: StepStatus; note?: string }
export interface TaskState {
  threadId: string;
  workspaceRoot?: string;        // canonical workspace path for identity checks
  goal: string;
  constraints: string[];
  acceptance: string[];          // acceptance criteria; compaction never drops them
  steps: PlanStep[];
  createdAt: string;             // ISO
  updatedAt: string;
}

/** Resolves symlinks to establish stable repository identity across invocations. */
export function canonicalWorkspace(root: string): string {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

export function taskDir(threadId: string): string {
  return path.join(axiomHome(), 'tasks', threadId);
}

/** Writes task state atomically via a unique temp file in the same directory before renaming. */
export function saveTaskState(state: TaskState): void {
  const dir = taskDir(state.threadId);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, 'task_state.json');
  const tmpPath = path.join(dir, `task_state.json.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, finalPath);
}

export function loadTaskState(threadId: string): TaskState | null {
  const filePath = path.join(taskDir(threadId), 'task_state.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as TaskState;
  } catch {
    return null;
  }
}

/** Appends a single timestamped entry to the task's progress log. */
export function appendProgress(threadId: string, line: string): void {
  const dir = taskDir(threadId);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'progress.log');
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

/** Newest first (by updatedAt, falling back to createdAt). Optionally filters by canonical workspace. */
export function listTasks(workspaceRoot?: string): TaskState[] {
  const baseDir = path.join(axiomHome(), 'tasks');
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  const tasks: TaskState[] = [];
  const targetCanonical = workspaceRoot ? canonicalWorkspace(workspaceRoot) : undefined;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = loadTaskState(entry.name);
    if (!state) continue;
    if (targetCanonical && state.workspaceRoot) {
      if (canonicalWorkspace(state.workspaceRoot) !== targetCanonical) {
        continue;
      }
    }
    tasks.push(state);
  }

  tasks.sort((a, b) => {
    const timeA = new Date(a.updatedAt || a.createdAt).getTime();
    const timeB = new Date(b.updatedAt || b.createdAt).getTime();
    return timeB - timeA;
  });
  return tasks;
}
