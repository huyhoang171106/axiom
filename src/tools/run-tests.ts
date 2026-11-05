// src/tools/run-tests.ts - `run_tests`: run pytest in the sandbox with the network off

import { runPytest, TEST_TIMEOUT_MS, type TestRun } from '../core/verifier.js';
import { BaseTool, type ToolExecutionContext } from './base-tool.js';

const OUTPUT_CHARS = 3000;
const LIST_LIMIT = 30;

function list(label: string, ids: readonly string[]): string[] {
  if (!ids.length) return [];
  const shown = ids.slice(0, LIST_LIMIT).map((id) => `  ${id}`);
  if (ids.length > LIST_LIMIT) shown.push(`  … ${ids.length - LIST_LIMIT} more`);
  return [`${label}:`, ...shown];
}

/** Counts first (from the full results), then names, then the tail of the console log. */
export function formatTestRun(run: TestRun, timeoutMs = TEST_TIMEOUT_MS): string {
  const lines = [`passed ${run.passed.length}, failed ${run.failed.length}, skipped ${run.skipped.length}, collection errors ${run.errors.length}`];
  if (run.timedOut) lines.push(`TIMEOUT after ${Math.round(timeoutMs / 1000)}s: the run was killed; results cover only the tests that finished.`);
  else if (!run.complete) lines.push(`The run did not finish (exit code ${run.exitCode ?? 'none'}); results are partial.`);
  else if (run.exitCode !== 0 && run.exitCode !== 1) lines.push(`pytest exit code ${run.exitCode} (not a normal pass/fail result).`);
  if (run.complete && !run.timedOut && run.passed.length === 0 && run.failed.length === 0) lines.push('No test ran to completion: this is not a passing suite.');
  lines.push(...list('Failed', run.failed), ...list('Collection errors', run.errors));
  if (run.output) lines.push('Output (tail):', run.output.slice(-OUTPUT_CHARS));
  return lines.join('\n');
}

export class RunTestsTool extends BaseTool {
  readonly name = 'run_tests';
  readonly description =
    'Run the pytest suite of the workspace (or one target such as tests/test_x.py::test_y) in a sandbox without network, and report passed and failed tests.';
  readonly parameters = {
    type: 'object',
    properties: { target: { type: 'string', description: 'Optional pytest node id or path; omit for the whole suite' } },
  };

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const target = typeof args.target === 'string' && args.target.trim() ? args.target : undefined;
    const signal = context?.signal instanceof AbortSignal ? context.signal : undefined;
    try {
      return formatTestRun(await runPytest(context?.workspaceRoot ?? process.cwd(), { target, signal }));
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
