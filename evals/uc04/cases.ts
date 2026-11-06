// evals/uc04/cases.ts - Fixture loading, workspace seeding and grading for UC-04
import fs from 'node:fs';
import path from 'node:path';
import { runPytest, findRegressions, type TestRun } from '../../src/core/verifier.js';
import { TARGET_REPO } from '../issues/bugs.js';

export const UC04_CASE_IDS = [
  'uc04-straight',
  'uc04-resume-1',
  'uc04-resume-2',
  'uc04-compaction',
  'uc04-memory',
] as const;

export type Uc04CaseId = typeof UC04_CASE_IDS[number];

const NOT_COPIED = new Set(['.venv', '.git', '__pycache__', '.pytest_cache', '.coverage']);

/** Copies the clean target repo into an isolated directory for the eval case. */
export function copyWorkspace(dest: string): void {
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(TARGET_REPO, dest, {
    recursive: true,
    filter: (src) => !NOT_COPIED.has(path.basename(src)),
  });
}

export interface FeatureCase {
  id: string;
  name: string;
  minFiles: number;
  request: string;
  acceptanceTestCode: string;
}

export function loadFeatureCase(featId: string): FeatureCase {
  const featDir = path.resolve(process.cwd(), 'evals/issues', featId);
  const meta = JSON.parse(fs.readFileSync(path.join(featDir, 'feature.json'), 'utf8'));
  const request = fs.readFileSync(path.join(featDir, 'request.md'), 'utf8');
  const acceptanceTestCode = fs.readFileSync(path.join(featDir, 'acceptance_test.py'), 'utf8');
  return {
    id: meta.id ?? featId,
    name: meta.name ?? featId,
    minFiles: meta.minFiles ?? 3,
    request,
    acceptanceTestCode,
  };
}

export interface GradeResult {
  passed: boolean;
  acceptancePassed: boolean;
  regressions: string[];
  output: string;
}

/**
 * Runs the hidden acceptance test and verifies 0 regressions on the modified workspace.
 * The acceptance test is placed inside workspace/tests temporarily and removed after execution.
 */
export async function gradeFeature(workspaceRoot: string, featId: string): Promise<GradeResult> {
  const feat = loadFeatureCase(featId);
  const testFileName = `test_acceptance_${featId.replace(/-/g, '_')}.py`;
  const testRelPath = path.join('tests', testFileName);
  const testFullPath = path.join(workspaceRoot, testRelPath);

  try {
    // 1. Ghi acceptance test tạm vào thư mục tests của workspace
    fs.writeFileSync(testFullPath, feat.acceptanceTestCode, 'utf8');

    // 2. Chạy verifier bwrap sandbox trên acceptance test
    const acceptanceRun = await runPytest(workspaceRoot, {
      targetTests: [testRelPath],
    });

    const acceptancePassed =
      acceptanceRun.complete &&
      !acceptanceRun.timedOut &&
      acceptanceRun.failed.length === 0 &&
      acceptanceRun.errors.length === 0 &&
      acceptanceRun.passed.length > 0;

    // 3. Xoá acceptance test tạm để không ảnh hưởng full suite
    if (fs.existsSync(testFullPath)) fs.rmSync(testFullPath, { force: true });

    // 4. Kiểm tra regression trên các test sẵn có của TinyDB
    const fullSuiteRun = await runPytest(workspaceRoot);
    const regressions = findRegressions(
      { passed: [], failed: [], timedOut: false, exitCode: 0, output: '', skipped: [], errors: [], complete: true },
      fullSuiteRun
    );

    return {
      passed: acceptancePassed && regressions.length === 0,
      acceptancePassed,
      regressions,
      output: acceptanceRun.output,
    };
  } finally {
    if (fs.existsSync(testFullPath)) {
      try {
        fs.rmSync(testFullPath, { force: true });
      } catch {}
    }
  }
}
