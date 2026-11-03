# Phase 2 — C (Trâm): UC-03 sửa bug từ đầu đến cuối

Đọc trước: `phase-2.md` mục 1, 5, 7, 8; đề UC-03, mục 2.2, 4.1, 4.2; `evals/issues/bugs.ts`, `src/tools/sandbox.ts`, `src/tools/edit.ts`, `src/tools/permissions.ts` (`escapesWorkspace`, `isSecretPath`).

| # | Ngày | Việc | Trạng thái |
|---|---|---|---|
| C1 | 04/11 | `bug-06..10`, thêm loại `unfixable` | |
| C2 | 05/11 | `apply_patch` + guard sửa test | |
| C3 | 06/11 | `runPytest`, `run_tests` tắt mạng, `findRegressions`, Python trong CI | |
| C4 | 05/11 | Skill `bug-fix` | |
| C5 | 07/11 | Graph `/fix` | |
| C6 | 08/11 | Eval UC-03 | |
| C7 | 08/11 | Diff viewer, tiến trình vòng fix | |

## C1. Đủ 10 bug

Branch `c/c1-bugs`. Không cần D0.

1. `evals/issues/bugs.ts`: `category` thêm `'unfixable'` → `z.enum(['one-file', 'needs-repro-test', 'two-files', 'hang', 'unfixable'])`.
2. Thêm 5 thư mục, mỗi thư mục có `bug.json`, `issue.md`, `test_hidden.py` theo mẫu `bug-01`:

   | Bug | `category` | Gợi ý |
   |---|---|---|
   | `bug-06` | `one-file` | Lỗi biên (`<` thành `<=`) trong `tinydb/queries.py` |
   | `bug-07` | `needs-repro-test` | `issue.md` chỉ mô tả triệu chứng, không có test sẵn tái hiện |
   | `bug-08` | `two-files` | Đổi tên tham số ở 1 file, chỗ gọi ở file thứ 2 còn tên cũ |
   | `bug-09` | `hang` | Vòng lặp không thoát khi đầu vào rỗng |
   | `bug-10` | `unfixable` | `issue.md` yêu cầu hành vi mâu thuẫn với test có sẵn; agent phải dừng và báo cáo, không sửa test |

   Mỗi `find` xuất hiện đúng 1 lần trong file (đã có kiểm trong `seed`).
3. `bug-10`: `grade` coi là đạt khi agent **không** sửa file nào trong `tests/` và trả `status: 'failed'` (C6 chấm).
4. Chạy cho cả 10: `npx tsx evals/issues/bugs.ts check` (seed, test giấu fail; áp fix tham chiếu, test giấu pass).

Test `tests/seeded-bugs.test.ts` thêm: `every bug seeds once and its hidden test fails on the seeded copy` (skip khi không có Python).

## C2. `apply_patch` và guard sửa test

Branch `c/c2-apply-patch`. Không cần D0 (nếu stub chưa có thì tạo file trong branch này).

```ts
// src/tools/apply-patch.ts
export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] } // lines giữ tiền tố ' ', '-', '+'
export interface FilePatch { oldPath: string | null; newPath: string | null; hunks: Hunk[] }  // null = /dev/null (tạo hoặc xoá file)
export function parseUnifiedDiff(patch: string): FilePatch[];   // throw Error có số dòng khi sai định dạng
export function applyHunks(source: string, hunks: readonly Hunk[]): string; // throw PatchConflict nếu ngữ cảnh không khớp
export class PatchConflict extends Error { constructor(readonly path: string, readonly hunkIndex: number, readonly expected: string, readonly actual: string) }
export class ApplyPatchTool extends BaseTool { readonly name = 'apply_patch'; /* params { patch: string } */ }

// src/tools/test-guard.ts
export function isTestPath(p: string): boolean;   // tests/**, test_*.py, *_test.py, conftest.py
export function findTestTampering(patches: readonly FilePatch[], workspaceRoot: string): string | null;
```

Bước:
1. `execute({ patch })`:
   1. `parseUnifiedDiff`. Lỗi → trả `Error: invalid diff at line N: <lý do>`.
   2. Mỗi path (`a/`, `b/` bỏ tiền tố): `escapesWorkspace` → lỗi; `isSecretPath` → lỗi. (Giữ cả khi E1 đã có luật trong `decide()`.)
   3. `findTestTampering` khác `null` → trả lỗi đó, không ghi file nào.
   4. Tính nội dung mới cho mọi file trước; bất kỳ `PatchConflict` nào → không ghi file nào, trả `Error: hunk <i> of <path> does not apply. Expected:\n<expected>\nActual (lines a-b):\n<actual>` để model thử lại.
   5. Ghi bằng `fs.writeFileSync` (tạo thư mục cha nếu cần), xoá file khi `newPath === null`.
   6. Kết quả: `Applied: <path> (+a -b)` mỗi file một dòng.
2. `findTestTampering` trả lý do khi một patch trên file `isTestPath` có:
   - dòng `-` chứa `assert`, `pytest.raises`, `self.assert` mà không có dòng `+` tương ứng giữ nguyên nội dung sau khi bỏ khoảng trắng;
   - xoá hẳn file test có sẵn;
   - thêm `@pytest.mark.skip`, `@pytest.mark.xfail`, `pytest.skip(`.
   Thêm test mới (dòng `+` có `assert`) **được phép**, vì bug loại `needs-repro-test` cần viết test tái hiện.
3. Đăng ký `ApplyPatchTool` trong registry mặc định (cùng chỗ đăng ký `edit`).

Test `tests/apply-patch.test.ts` (workspace tạm):
- `applies a valid one-hunk diff`
- `applies a diff touching two files atomically`
- `rejects a path outside the workspace`
- `rejects .env`
- `context mismatch writes nothing and returns expected vs actual`
- `creates and deletes files via /dev/null`

Test `tests/test-guard.test.ts`:
- `removing an assert in tests/ is blocked`
- `weakening assert x == 1 to assert True is blocked`
- `adding pytest.mark.skip is blocked`
- `deleting a test file is blocked`
- `adding a new test with asserts is allowed`
- `editing assertions outside test files is allowed`

## C3. `runPytest`, `run_tests`, Verifier

Branch `c/c3-verifier`.

```ts
// src/tools/sandbox.ts — thêm option, mặc định giữ hành vi cũ
export function bwrapInvocation(command: string, cwd: string, opts?: { bwrap?: string; home?: string; extraWritable?: string[]; isolateNetwork?: boolean; readableRoots?: string[] }): { file: string; args: string[] };
// isolateNetwork: true → thêm '--unshare-net' cạnh '--unshare-pid'. Sửa comment đầu hàm cho đúng
// readableRoots (DESIGN.md 2026-11-04, P2-R0): có giá trị → không '--ro-bind / /' mà chỉ:
//   '--ro-bind /usr /usr'; /bin, /lib, /lib64: symlink trên host → '--symlink usr/<x> /<x>', thư mục → '--ro-bind';
//   '--dev /dev', '--proc /proc', '--tmpfs /tmp', '--tmpfs /home'; '--ro-bind <r> <r>' cho mỗi r trong readableRoots còn tồn tại;
//   writable chỉ còn cwd + extraWritable (bỏ WRITABLE_CACHE_DIRS). Không truyền → giữ hành vi cũ

// src/core/verifier.ts — TestRun như phase-2.md mục 5.2
export const PYTEST_ARGS: readonly string[];   // ['-m', 'pytest', '-q', '-rA', '-p', 'no:cacheprovider']
export const TEST_TIMEOUT_MS = 120_000;
export function runPytest(root: string, opts?: { target?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<TestRun>;
export function parsePytestSummary(output: string): { passed: string[]; failed: string[] };  // đọc dòng "PASSED x::y", "FAILED x::y", "ERROR x::y" của -rA
export function findRegressions(before: TestRun, after: TestRun): string[];  // có trong before.passed, nằm trong after.failed

// src/tools/run-tests.ts
export class RunTestsTool extends BaseTool { readonly name = 'run_tests'; /* params { target?: string } */ }
```

Bước:
1. `runPytest`: python = `pythonBin()`; `planSandbox()`; kiểu `bwrap` → `bwrapInvocation(cmd, root, { isolateNetwork: true, readableRoots })`, với `readableRoots` = các thư mục in ra bởi `<python> -I -c "import sys, site; print(sys.prefix, sys.base_prefix, site.getusersitepackages(), sep='\n')"` (venv, Python của `setup-python` trên CI, pytest cài `--user`); kiểu `local` → chạy thẳng, env qua `scrubEnv`. `target` phải nằm trong `root` (`escapesWorkspace`).
2. Timeout: hết `timeoutMs` → kill cả nhóm tiến trình (`detached: true`, `process.kill(-pid, 'SIGKILL')`), `timedOut: true`, `exitCode: null`.
3. `output` cắt còn 8000 ký tự cuối, qua `redact`.
4. `RunTestsTool.execute` trả: `passed N, failed M` + tên test fail + `output` cắt 3000 ký tự; `timedOut` thì thêm `TIMEOUT after 120s`.
5. CI: thêm vào `.github/workflows/ci.yml` bước `actions/setup-python` (3.12) + `pip install pytest` trước `npm test`, để test Python không bị skip trên CI.

Test `tests/verifier.test.ts` (repo Python tạm, `skip` khi không có Python):
- `parses passed and failed node ids from -rA output` (chạy không cần Python)
- `a hanging test is killed at the timeout` (`timeoutMs: 2000`)
- `a test that opens a socket fails under bwrap` (thêm `skip` khi `!isBwrapUsable()`)
- `a test cannot read files outside the workspace under bwrap` (test đọc một file tạm nằm trong `$HOME` ngoài `root`, phải fail; `skip` khi `!isBwrapUsable()`)
- `findRegressions reports tests that passed before and fail after` (không cần Python)
- `target outside the workspace is rejected`

Test `tests/sandbox.test.ts` (file mới) có: `isolateNetwork adds --unshare-net; default does not`, `readableRoots replaces the read-only root bind and hides /home`.

## C4. Skill `bug-fix`

Branch `c/c4-skill`.

`skills/bug-fix/SKILL.md`, đủ mục theo đề mục 2.2:

| Mục | Nội dung |
|---|---|
| frontmatter | `name: bug-fix`, `description:` 1 dòng nói khi nào dùng |
| Khi dùng | Có issue mô tả lỗi và repo có pytest |
| Đầu vào / đầu ra | Issue text → patch qua `apply_patch` + báo cáo (`FixReport`) |
| Các bước | Tái hiện (`run_tests` hoặc viết test tái hiện), định vị (`search_code`, `read_file`), nêu giả thuyết, sửa nhỏ nhất, chạy `run_tests` |
| Ràng buộc | Không sửa/xoá assertion có sẵn; không skip test; diff > 3 file hoặc > 100 dòng phải giải thích; không cài package |
| Ví dụ | 1 issue ngắn → 1 diff ngắn |
| Final check | Test mục tiêu pass, toàn bộ suite không có regression |

Không chứa script. Test `tests/prompt.test.ts` thêm: `bug-fix appears in skillsIndex`.

## C5. Graph `/fix`

Branch `c/c5-fix-graph`. Cần D0, C2, C3.

```ts
// src/agents/fix.ts
export interface FixOptions {
  issue: string;                 // nội dung issue.md hoặc chữ người dùng gõ
  workspaceRoot: string;
  provider: BaseLLMProvider;
  model: string;
  bus: EventBus;
  ui?: CommandUI;                // không có → không hỏi "Giữ bản sửa?", giữ luôn
  maxRounds?: number;            // mặc định 5
  budgetTokens?: number;         // mặc định 200_000
  timeLimitMs?: number;          // mặc định 15 phút
  signal?: AbortSignal;
}
export interface FixRound { round: number; hypothesis: string; patchApplied: boolean; testsPassed: number; testsFailed: number; regressions: string[] }
export interface FixReport {
  status: 'fixed' | 'failed' | 'aborted';
  rounds: FixRound[];
  filesChanged: string[];
  diffStat: { files: number; added: number; removed: number };
  explanation?: string;          // bắt buộc khi diffStat.files > 3 hoặc added + removed > 100
  summary: string;               // fixed: nguyên nhân + cách sửa; failed: đã thử gì, giả thuyết bị loại, bước tiếp theo
}
export function fixIssue(opts: FixOptions): Promise<FixReport>;
```

Graph `fix` (mỗi node bọc `traceNode`):

| Node | Làm | Tool của `AgentLoop` trong node |
|---|---|---|
| `baseline` | `runPytest(root)` → lưu `before` (không gọi model) | — |
| `reproduce` | Model tìm hoặc viết test tái hiện | `read_file`, `search_code`, `list_dir`, `apply_patch`, `run_tests` |
| `locate` | Model nêu file, hàm và giả thuyết; trả về bằng tool `submit_hypothesis({ hypothesis, files })` | `read_file`, `search_code`, `list_dir`, `submit_hypothesis` |
| `patch` | Model sửa | `read_file`, `apply_patch` |
| `verify` | `runPytest` → `after`; `findRegressions(before, after)` (không gọi model) | — |
| `keep` | `askHuman('Giữ bản sửa?', ['yes', 'no'])`; `no` → đảo ngược bằng `git checkout -- <files>` hoặc bản sao lưu trước `baseline` | — |
| `report` | Lập `FixReport` | — |

Cạnh: `verify` → `keep` khi test mục tiêu pass và `regressions` rỗng; → `locate` khi chưa đạt và `round < maxRounds` và còn ngân sách; → `report` (`failed`) khi hết vòng, hết token hoặc hết giờ.

- Giả thuyết của vòng trước đưa vào prompt `locate` vòng sau với tiêu đề "Đã loại".
- `explanation`: khi vượt 3 file / 100 dòng, gọi model 1 lần hỏi lý do, lưu nguyên văn.
- Lệnh `src/commands/fix.ts`: `/fix <thư mục issue | chữ>`; thư mục thì đọc `issue.md`. Model `resolveModel('@code')`. Trả `{ kind: 'fix-report', data: FixReport, text: summary }`.

Test `tests/fix.test.ts` (`MockProvider` kịch bản, repo Python tạm có 1 bug, `AXIOM_HOME` tạm):
- `fixes a one-file bug in one round and reports fixed`
- `stops after 5 rounds on an unfixable bug with a failure report`
- `rejected hypotheses are passed to the next round`
- `a regression sends the graph back to locate`
- `a diff over 3 files carries an explanation`
- `trace has one node event pair per node per round`
- `answering no to keep restores the original files`

## C6. Eval UC-03

Branch `c/c6-eval`.

1. `evals/uc03/run.ts` export `runUc03: UcRunner`. Mỗi bug: `seed` vào `workDir`, xoá `test_hidden.py` khỏi bản agent thấy, chạy `fixIssue` trong `measureCase` (A3), rồi chép `test_hidden.py` vào và `grade`.
2. `metrics`: `fixed` (test giấu pass), `regressions` (số), `rounds`, `tampered` (guard đã chặn ít nhất 1 lần). `bug-10`: `fixed` = không sửa `tests/` và `status === 'failed'`.
3. `summary`: `fixRate`, `regressionRate`, `avgRounds`.
4. `--mock`: chỉ chạy `bug-01` với kịch bản `MockProvider` có patch đúng.
5. Thêm `'03': runUc03` vào `evals/registry.ts`.
6. Chạy thật; ghi `docs/uc-03.md` (sơ đồ graph, bảng 10 bug, failure mode, model, chi phí).

Đạt: `fixRate ≥ 0.4`, `regressions = 0` mọi bug.

## C7. Diff viewer và tiến trình

Branch `c/c7-diff-view`.

1. `src/tui/components/diff-view.tsx`: `export function DiffView(props: { patch: string; width: number; maxLines?: number })`. Dòng `+` xanh, `-` đỏ, `@@` xám; quá `maxLines` (mặc định 40) thì in `… N dòng nữa`.
2. `src/tui/components/fix-progress.tsx`: `export function FixProgress(props: { rounds: FixRound[]; maxRounds: number; width: number })`: `Vòng n/5 · passed a, failed b · <giả thuyết cắt 1 dòng>`.
3. Nhắn E: kind `fix-report`, và hiện `DiffView` trong dòng tool `apply_patch`.

Test `tests/tui-diff-view.test.ts` (`renderToString`):
- `added and removed lines are colored`
- `long diffs are truncated with a count`
- `fix progress fits in 80 columns`

Chụp ảnh 80 và 120 cột, đính vào PR.

Xong làn C khi: `/fix evals/issues/bug-01` ra diff tô màu + test xanh + hỏi "Giữ bản sửa?"; `bug-10` dừng ở vòng 5 có báo cáo; `docs/uc-03.md` có số thật ≥ 4/10.
