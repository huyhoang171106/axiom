// src/tools/test-guard.ts - Refuse changes that weaken existing tests (UC-03 criterion 3), for every write path
//
// The checks work on removed and added lines, so the same rules cover a unified diff (`apply_patch`) and a
// before/after pair (`edit`, `write_file`). Adding a new test with asserts is allowed: `needs-repro-test`
// bugs require one.
import path from 'node:path';
import type { FilePatch } from './apply-patch.js';
import { splitLines } from './text-lines.js';

export interface TestGuardOptions {
  /**
   * Test files this run may change, workspace-relative. Only trusted code sets it (issue metadata, a human
   * answer), never tool arguments: the model must not be able to grant itself an exception.
   */
  allowedTests?: readonly string[];
}

/** Files pytest collects as tests or loads as test plugins: `tests/**`, `test_*.py`, `*_test.py`, `conftest.py`. */
export function isTestPath(p: string): boolean {
  const n = normalize(p);
  const base = n.split('/').pop() ?? '';
  return /(^|\/)tests\//.test(n) || /^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === 'conftest.py';
}

/** Config files that can deselect or stop collecting tests without touching a test file. */
function isTestConfigPath(p: string): boolean {
  return /^(?:pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml)$/.test(normalize(p).split('/').pop() ?? '');
}

/** Lines that carry what a test checks; removing one (or changing it) weakens the test. */
const CHECK_LINE = /\bassert\b|self\.assert\w*\s*\(|pytest\.(?:raises|warns|approx)\b|^\s*(?:async\s+)?def\s+test\w*\s*\(|^\s*class\s+Test\w*/;
/** Lines that stop a test from running or from counting as a failure. */
const SKIP_LINE = /@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail|importorskip)\s*\(|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bunittest\.SkipTest\b|\braise\s+SkipTest\b/;
/** Collection and selection settings in conftest or pytest config. */
const DESELECT_LINE = /\baddopts\b|--deselect\b|--ignore(?:-glob)?\b|(?:^|\s)-k\s|\bcollect_ignore(?:_glob)?\b|\bpytest_(?:collection_modifyitems|ignore_collect|collect_file|deselected)\b|\b(?:testpaths|norecursedirs|python_files|python_classes|python_functions)\b/;

function normalize(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function relativeTo(root: string, p: string): string {
  const n = normalize(p);
  return path.isAbsolute(p) ? normalize(path.relative(root, p)) : n;
}

const squash = (line: string) => line.replace(/\s+/g, '');
const quote = (line: string) => JSON.stringify(line.trim().slice(0, 120));

/**
 * The reason one file's change tampers with tests, or null. `removed`/`added` are the line contents that
 * left and entered the file; `deleted` means the file is gone after the change.
 */
function checkLines(rel: string, removed: readonly string[], added: readonly string[], deleted: boolean): string | null {
  const isTest = isTestPath(rel);
  const isConfig = isTestConfigPath(rel);
  if (!isTest && !isConfig) return null;
  const refuse = (what: string) =>
    `refusing to change ${rel}: ${what}. Existing tests must not be weakened; fix the code under test instead, ` +
    `or stop and report that the issue contradicts the tests.`;
  if (isTest && deleted) return refuse('it deletes or moves an existing test file');
  if (isTest) {
    // A check line survives when the same text (ignoring whitespace) is added back, e.g. re-indented or moved.
    const kept = new Map<string, number>();
    for (const line of added) kept.set(squash(line), (kept.get(squash(line)) ?? 0) + 1);
    for (const line of removed) {
      if (!CHECK_LINE.test(line)) continue;
      const count = kept.get(squash(line)) ?? 0;
      if (count === 0) return refuse(`it removes or changes the check ${quote(line)}`);
      kept.set(squash(line), count - 1);
    }
  }
  const skip = added.find((line) => SKIP_LINE.test(line));
  if (skip) return refuse(`it adds ${quote(skip)}, which skips or excuses a test`);
  const deselect = (rel.endsWith('conftest.py') || isConfig) && added.find((line) => DESELECT_LINE.test(line));
  if (deselect) return refuse(`it adds ${quote(deselect)}, which changes which tests are collected or run`);
  return null;
}

function isAllowed(rel: string, opts: TestGuardOptions | undefined): boolean {
  return (opts?.allowedTests ?? []).some((allowed) => normalize(allowed) === rel);
}

/** null = allowed; otherwise the reason the patch tampers with a test. */
export function findTestTampering(patches: readonly FilePatch[], workspaceRoot: string, opts?: TestGuardOptions): string | null {
  for (const patch of patches) {
    const removed: string[] = [];
    const added: string[] = [];
    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) {
        if (line[0] === '-') removed.push(line.slice(1));
        else if (line[0] === '+') added.push(line.slice(1));
      }
    }
    const oldRel = patch.oldPath === null ? null : relativeTo(workspaceRoot, patch.oldPath);
    const newRel = patch.newPath === null ? null : relativeTo(workspaceRoot, patch.newPath);
    if (oldRel !== null && !isAllowed(oldRel, opts)) {
      // A rename out of the test tree removes the test from collection just like a deletion.
      const gone = newRel === null || (newRel !== oldRel && !isTestPath(newRel));
      const reason = checkLines(oldRel, removed, newRel === oldRel ? added : gone ? [] : added, gone);
      if (reason) return reason;
    }
    if (newRel !== null && newRel !== oldRel && !isAllowed(newRel, opts)) {
      const reason = checkLines(newRel, [], added, false);
      if (reason) return reason;
    }
  }
  return null;
}

/**
 * The same rules for a whole-file change (`edit`, `write_file`): `before` null = new file, `after` null =
 * deleted. Lines are compared as multisets, so unchanged lines are never reported.
 */
export function findChangeTampering(filePath: string, before: string | null, after: string | null, workspaceRoot: string, opts?: TestGuardOptions): string | null {
  const rel = relativeTo(workspaceRoot, filePath);
  if (isAllowed(rel, opts)) return null;
  const oldLines = before === null ? [] : splitLines(before);
  const newLines = after === null ? [] : splitLines(after);
  const remaining = new Map<string, number>();
  for (const line of newLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const removed: string[] = [];
  for (const line of oldLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else removed.push(line);
  }
  const added = [...remaining].flatMap(([line, count]) => Array<string>(count).fill(line));
  return checkLines(rel, removed, added, before !== null && after === null);
}
