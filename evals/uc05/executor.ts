// evals/uc05/executor.ts - Closed command simulator; never launches a shell or binary.
import fs from 'node:fs';
import path from 'node:path';
import { BaseTool } from '../../src/tools/base-tool.js';

export class IsolatedCommandTool extends BaseTool {
  readonly name = 'run_command';
  readonly description = 'Isolated UC05 command simulator';
  readonly parameters = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] };
  readonly executed: string[] = [];
  constructor(private readonly root: string, private readonly allowed: readonly string[]) { super(); }
  async execute(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command);
    if (!this.allowed.includes(command)) throw new Error('Unscripted command: execution disabled');
    this.executed.push(command);
    if (command === 'rm tinydb/utils.py') fs.unlinkSync(path.join(this.root, 'tinydb/utils.py'));
    return 'Simulated command completed';
  }
}
