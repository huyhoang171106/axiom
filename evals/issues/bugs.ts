// evals/issues/bugs.ts - Seeded bugs (topic 2.2): seed a buggy copy of the target repo, grade it with the hidden test, check every bug
//
//   npx tsx evals/issues/bugs.ts seed bug-01 <dir>   copy workspace/tinydb to <dir> (outside the repo) with the bug applied
//   npx tsx evals/issues/bugs.ts grade bug-01 <dir>  copy the hidden test into <dir> and run it (exit 0 = fixed)
//   npx tsx evals/issues/bugs.ts check               every hidden test passes on the original and fails on its bug
//
// Python comes from AXIOM_PYTHON (default `python`) and needs pytest.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ISSUES_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TARGET_REPO = path.resolve(ISSUES_DIR, '../../workspace/tinydb');
const GRADE_TIMEOUT_MS = 120_000;
/** Local environments and caches next to the snapshot; the agent's copy must not inherit them. */
const NOT_COPIED = new Set(['.venv', '.git', '__pycache__', '.pytest_cache', '.coverage']);

export const bugSchema = z.object({
  category: z.enum(['one-file', 'needs-repro-test', 'two-files', 'hang']),
  /** Files a correct fix has to touch, relative to the target repo. */
  fixFiles: z.array(z.string().min(1)).min(1),
  /** Each `find` must occur exactly once in its file, so a bug always seeds the same way. */
  edits: z.array(z.object({ file: z.string().min(1), find: z.string().min(1), replace: z.string() })).min(1),
});
export type Bug = z.infer<typeof bugSchema>;

export function listBugs(): string[] {
  return fs.readdirSync(ISSUES_DIR).filter((name) => /^bug-\d{2}$/.test(name)).sort();
}

export function loadBug(id: string): Bug {
  return bugSchema.parse(JSON.parse(fs.readFileSync(path.join(ISSUES_DIR, id, 'bug.json'), 'utf8')));
}

/** Line endings differ between a Windows checkout (CRLF) and bug.json (LF); compare without them. */
const normalize = (text: string) => text.replace(/\r\n/g, '\n');

export function applyEdits(repo: string, bug: Bug): void {
  for (const edit of bug.edits) {
    const file = path.join(repo, edit.file);
    const source = normalize(fs.readFileSync(file, 'utf8'));
    const find = normalize(edit.find);
    const count = source.split(find).length - 1;
    if (count !== 1) throw new Error(`${edit.file}: expected the edit's "find" text once, found it ${count} times`);
    fs.writeFileSync(file, source.replace(find, () => normalize(edit.replace)));
  }
}

function copyRepo(dest: string): void {
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) throw new Error(`${dest} is not empty`);
  fs.cpSync(TARGET_REPO, dest, { recursive: true, filter: (src) => !NOT_COPIED.has(path.basename(src)) });
}

export function seed(id: string, dest: string): void {
  const bug = loadBug(id);
  copyRepo(dest);
  applyEdits(dest, bug);
}

export interface GradeResult {
  passed: boolean;
  timedOut: boolean;
  output: string;
}

/** Runs pytest in `dir`; `-o addopts=` drops the repo's `--cov` options so plain pytest is enough. */
function runPytest(dir: string, args: string[], timeoutMs: number): GradeResult {
  const python = process.env.AXIOM_PYTHON || 'python';
  const run = spawnSync(python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-o', 'addopts=', ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (run.error && (run.error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${python} not found; set AXIOM_PYTHON`);
  const timedOut = (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');
  return { passed: !timedOut && run.status === 0, timedOut, output };
}

export function grade(id: string, dir: string, timeoutMs = GRADE_TIMEOUT_MS): GradeResult {
  const testFile = `test_hidden_${id.replace('-', '_')}.py`;
  fs.copyFileSync(path.join(ISSUES_DIR, id, 'test_hidden.py'), path.join(dir, 'tests', testFile));
  return runPytest(dir, [`tests/${testFile}`], timeoutMs);
}

/** For every bug: hidden test passes on the original, fails (or hangs) on the seeded copy; also reports the visible suite. */
export function check(timeoutMs = 30_000): boolean {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-bugs-'));
  const original = path.join(scratch, 'original');
  copyRepo(original);
  let ok = true;
  try {
    for (const id of listBugs()) {
      const bug = loadBug(id);
      const seeded = path.join(scratch, id);
      seed(id, seeded);
      const onOriginal = grade(id, original, timeoutMs);
      const visible = runPytest(seeded, ['tests'], timeoutMs);
      const onBug = grade(id, seeded, timeoutMs);
      const good = onOriginal.passed && !onBug.passed && (bug.category !== 'hang' || onBug.timedOut);
      ok &&= good;
      const describe = (r: GradeResult) => (r.timedOut ? 'timeout' : r.passed ? 'pass' : 'fail');
      console.log(
        `${good ? 'OK  ' : 'FAIL'} ${id} (${bug.category}): hidden test original=${describe(onOriginal)} seeded=${describe(onBug)}; ` +
          `visible tests on seeded=${describe(visible)}`
      );
      if (!good) console.log(`${onOriginal.output}\n---\n${onBug.output}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return ok;
}

function main(argv: string[]): void {
  const [command, id, dir] = argv;
  if (command === 'check' && !id) {
    if (!check()) process.exitCode = 1;
    return;
  }
  if ((command === 'seed' || command === 'grade') && id && dir) {
    if (!listBugs().includes(id)) throw new Error(`Unknown bug "${id}"; known: ${listBugs().join(', ')}`);
    if (command === 'seed') {
      seed(id, path.resolve(dir));
      console.log(`Seeded ${id} into ${path.resolve(dir)}`);
      return;
    }
    const result = grade(id, path.resolve(dir));
    console.log(`${result.passed ? 'PASS' : result.timedOut ? 'TIMEOUT' : 'FAIL'} ${id}\n${result.output}`);
    if (!result.passed) process.exitCode = 1;
    return;
  }
  throw new Error('Usage: bugs.ts seed <bug-NN> <dir> | grade <bug-NN> <dir> | check');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
