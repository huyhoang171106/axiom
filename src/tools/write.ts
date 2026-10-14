// src/tools/write.ts - Deterministic atomic file write tool
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { BaseTool, type ToolExecutionContext } from './base-tool.js';

/** Guards against a model "helpfully" dumping a multi-hundred-MB blob through the tool channel. */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export class WriteTool extends BaseTool {
  readonly name = 'write';
  readonly description = 'Write contents to a file atomically, creating parent directories if needed';
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
      overwrite: {
        type: 'boolean',
        description: 'Overwrite the file if it already exists (default true). Set false to refuse.',
      },
    },
    required: ['path', 'content'],
  };

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
        `Content too large: ${formatBytes(bytes)} exceeds the ${formatBytes(MAX_FILE_SIZE)} limit; split the write or use bash`
      );
    }

    const targetPath = this.resolvePath(rawPath, context);
    const parentDir = path.dirname(targetPath);

    const existed = await pathExists(targetPath);
    if (existed && args.overwrite === false) {
      throw new Error(`File already exists: ${rawPath}. Pass overwrite: true to replace it.`);
    }

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
    const action = existed ? 'overwrote' : 'created';
    return `Successfully wrote ${bytes} bytes (${lineCount} lines) to ${rawPath} (${action})`;
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
