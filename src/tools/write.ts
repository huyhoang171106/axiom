// src/tools/write.ts - Atomic tool that creates new files; existing files are changed with `edit`, never overwritten
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { BaseTool, type ToolExecutionContext } from './base-tool.js';
import { findChangeTampering, type TestGuardOptions } from './test-guard.js';

/** Guards against a model "helpfully" dumping a multi-hundred-MB blob through the tool channel. */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export class WriteTool extends BaseTool {
  readonly name = 'write_file';
  readonly description =
    'Create a NEW file atomically, creating parent directories if needed. Refuses existing files: change those with "edit".';
  readonly parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path of the file to write',
      },
      content: {
        type: 'string',
        description: 'Text content to write into the file',
      },
    },
    required: ['path', 'content'],
  };

  /** `guard.allowedTests` is set by trusted code building the registry, never by tool arguments (see test-guard.ts). */
  constructor(private readonly guard: TestGuardOptions = {}) {
    super();
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<string> {
    const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!rawPath) {
      throw new Error('Path argument must be a non-empty string');
    }

    if (typeof args.content !== 'string') {
      throw new Error('Content argument must be a string');
    }

    const content = args.content;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_SIZE) {
      throw new Error(
        `Content too large: ${formatBytes(bytes)} exceeds the ${formatBytes(MAX_FILE_SIZE)} limit; split the write`
      );
    }

    const targetPath = this.resolvePath(rawPath, context);
    const parentDir = path.dirname(targetPath);

    // Whole-file rewrites of existing code are what the topic forbids (§4.1: changes go through diffs), and they
    // silently drop whatever the model did not reproduce. Only new files are written here.
    if (await pathExists(targetPath)) {
      throw new Error(`File already exists: ${rawPath}. Use "edit" to change an existing file.`);
    }

    // A new test file may add asserts (a repro test) but not skips, and no new conftest/pytest config may deselect tests.
    const tamper = findChangeTampering(targetPath, null, content, context?.workspaceRoot ?? process.cwd(), this.guard);
    if (tamper) throw new Error(tamper);

    // Create parent directories if they don't exist
    await fs.mkdir(parentDir, { recursive: true });

    // Atomic write pattern: write to a temporary file in the same directory, then rename
    const randomSuffix = crypto.randomBytes(6).toString('hex');
    const tempPath = path.join(parentDir, `.${path.basename(targetPath)}.${randomSuffix}.tmp`);

    try {
      await fs.writeFile(tempPath, content, 'utf8');
      await fs.rename(tempPath, targetPath);
    } catch (err) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // ignore unlink error if temp file was not created or already moved
      }
      throw new Error(`Failed to write file ${rawPath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const lineCount = content.split(/\r?\n/).length;
    return `Created ${rawPath} (${bytes} bytes, ${lineCount} lines)`;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
