// evals/types.ts - Contract every UC eval runner implements (phase-2.md section 5.4)

import type { AxiomConfig } from '../src/core/types.js';

export interface UcCaseResult {
  id: string;
  passed: boolean;
  metrics: Record<string, number | boolean | null>;
  tokens: number;             // prompt + completion
  costDollars: number;
  latencyMs: number;
  error?: string;
}
export interface UcResult { uc: string; cases: UcCaseResult[]; summary: Record<string, number | null> }
export interface UcRunOptions { mock: boolean; config: AxiomConfig; workDir: string } // workDir: temp dir of this run
export type UcRunner = (opts: UcRunOptions) => Promise<UcResult>;
