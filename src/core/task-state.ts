// src/core/task-state.ts - Durable state of a multi-step task: goal, acceptance, steps (UC-04)

import path from 'node:path';
import { axiomHome } from './paths.js';

export type StepStatus = 'todo' | 'doing' | 'done' | 'failed';
export interface PlanStep { id: number; title: string; files: string[]; status: StepStatus; note?: string }
export interface TaskState {
  threadId: string;
  goal: string;
  constraints: string[];
  acceptance: string[];          // acceptance criteria; compaction never drops them
  steps: PlanStep[];
  createdAt: string;             // ISO
  updatedAt: string;
}

export function taskDir(threadId: string): string {
  return path.join(axiomHome(), 'tasks', threadId);
}

export function saveTaskState(state: TaskState): void {
  // TODO(D1): task_state.json, written to a temp file then renamed.
}

export function loadTaskState(threadId: string): TaskState | null {
  // TODO(D1)
  return null;
}

export function appendProgress(threadId: string, line: string): void {
  // TODO(D1): progress.log, `<ISO> <line>\n`.
}

/** Newest first. */
export function listTasks(): TaskState[] {
  // TODO(D1)
  return [];
}
