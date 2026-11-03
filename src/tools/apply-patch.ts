// src/tools/apply-patch.ts - `apply_patch`: apply a unified diff to workspace files, all files or none

import { BaseTool } from './base-tool.js';

export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] } // lines keep their ' ', '-', '+' prefix
export interface FilePatch { oldPath: string | null; newPath: string | null; hunks: Hunk[] } // null = /dev/null (file created or deleted)

export function parseUnifiedDiff(patch: string): FilePatch[] {
  throw new Error('chưa làm (C2)');
}

export class ApplyPatchTool extends BaseTool {
  readonly name = 'apply_patch';
  readonly description = 'Apply a unified diff (git diff format) to files in the workspace. Either every hunk applies or no file is changed.';
  readonly parameters = {
    type: 'object',
    properties: { patch: { type: 'string', description: 'Unified diff with ---/+++ headers and @@ hunks' } },
    required: ['patch'],
  };

  async execute(): Promise<string> {
    // TODO(C2): parse, check paths and test tampering, apply.
    return 'Error: apply_patch is not implemented yet (C2); use edit instead.';
  }
}
