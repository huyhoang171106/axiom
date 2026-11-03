// src/core/verifier.ts - Run pytest in the sandbox and compare runs for regressions (UC-03)

export interface TestRun {
  passed: string[];
  failed: string[];
  timedOut: boolean;
  exitCode: number | null;
  output: string;
}

export async function runPytest(root: string, opts?: { target?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<TestRun> {
  throw new Error('chưa làm (C3)');
}

/** Tests that passed in `before` and fail in `after`. */
export function findRegressions(before: TestRun, after: TestRun): string[] {
  throw new Error('chưa làm (C3)');
}
