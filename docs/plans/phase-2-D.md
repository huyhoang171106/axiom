# Phase 2 — D (Hoàng): khung LangGraph, UC-04 nhiều bước + resume

Đọc trước: `phase-2.md` toàn bộ; đề UC-04, mục 2.2; `src/core/agent-loop.ts`, `src/core/session.ts`, `src/core/state-machine.ts`, `src/core/prompt.ts`, `src/core/trace.ts`.

| # | Ngày | Việc | Trạng thái |
|---|---|---|---|
| D0 | 04/11 | Cài LangGraph, tạo mọi file dùng chung và stub | done |
| D1 | 04/11 | `task-state.ts`, graph `/feature` | done |
| D2 | 05/11 | Checkpointer SQLite, `/resume` | done |
| D3 | 06/11 | Compaction, `/compact` | done |
| D4 | 06/11 | Memory, `/memory` | |
| D5 | 07/11 | 3 feature + eval UC-04 | |
| D7 | 08/11 | Ghép, video, tag `v0.2-phase2` | |

## D0. Khung (merge trước 12:00 T4 04/11)

Branch `d/d0-phase2-skeleton`.

1. `npm i @langchain/langgraph @langchain/core @langchain/langgraph-checkpoint-sqlite`. Kiểm `npm ci` trên CI (Node 22) xanh.
2. Làm đủ `phase-2.md` mục 5.1 (thân thật):
   - `ModelRole`, `MODEL_ROLES` thêm `'code'`, `'embed'`; `ROLE_FALLBACK` thêm `code: 'default'`, `embed: undefined`.
   - `Risk`, `PolicyDecision.risk?`, `ApprovalRequest.risk?`.
   - Event `node`, `approval` trong `AxiomEvents` và `TRACED_EVENTS`.
   - `src/core/graph.ts`: `createCheckpointer` (stub trả `MemorySaver`), `newThreadId`, `traceNode`.
3. Tạo mọi stub ở `phase-2.md` mục 5.2, 5.3, 5.4 đúng chữ ký; 10 lệnh mới đăng ký trong `src/commands/index.ts`.
4. `evals/registry.ts`: `UC_RUNNERS = { '01': <bọc code UC-01 hiện có> }`; `evals/run.ts` chưa đổi (A3 đổi).
5. Test `tests/graph.test.ts`:
   - `newThreadId has kind prefix and is unique`
   - `traceNode emits enter then exit with graph and node names`
   - `node and approval events are traced`
6. `npm run lint && npm test`, PR, nhắn nhóm "D0 đã merge".

## D1. Task state và `/feature`

Branch `d/d1-feature`.

```ts
// src/core/task-state.ts
export type StepStatus = 'todo' | 'doing' | 'done' | 'failed';
export interface PlanStep { id: number; title: string; files: string[]; status: StepStatus; note?: string }
export interface TaskState {
  threadId: string;
  goal: string;
  constraints: string[];
  acceptance: string[];          // tiêu chí chấp nhận, không bao giờ bị compaction xoá
  steps: PlanStep[];
  createdAt: string;             // ISO
  updatedAt: string;
}
export function taskDir(threadId: string): string;        // path.join(axiomHome(), 'tasks', threadId)
export function saveTaskState(state: TaskState): void;    // task_state.json, ghi tạm rồi rename
export function loadTaskState(threadId: string): TaskState | null;
export function appendProgress(threadId: string, line: string): void;  // progress.log: `<ISO> <line>\n`
export function listTasks(): TaskState[];                 // mới nhất trước

// src/agents/feature.ts
export interface FeatureOptions { workspaceRoot: string; provider: BaseLLMProvider; model: string; bus: EventBus; ui?: CommandUI; signal?: AbortSignal; checkpointer?: BaseCheckpointSaver }
export interface FeatureReport { threadId: string; status: 'completed' | 'failed' | 'aborted' | 'rejected'; steps: PlanStep[]; filesChanged: string[]; summary: string }
export function runFeature(request: string, opts: FeatureOptions): Promise<FeatureReport>;
export function resumeTask(threadId: string | undefined, opts: FeatureOptions): Promise<FeatureReport>;  // undefined = task dở mới nhất
```

Graph `feature` (mỗi node bọc `traceNode`):

| Node | Làm |
|---|---|
| `plan` | `AgentLoop` chỉ có tool đọc + `submit_plan({ goal, constraints, acceptance, steps: [{ title, files }] })`; 3–7 bước; lưu `TaskState` |
| `approve` | `askHuman('Duyệt kế hoạch?', ['yes', 'no'])`; `no` → `report` với `rejected` |
| `step` | Lấy bước `todo` đầu tiên → `doing` → `AgentLoop` (`read_file`, `search_code`, `list_dir`, `edit`, `write_file`, `apply_patch`, `run_tests`) với prompt có `goal`, `constraints`, `acceptance`, các bước đã xong, bước hiện tại → `done` hoặc `failed`; `appendProgress` |
| `report` | Lập `FeatureReport` |

Cạnh: `step` → `step` khi còn `todo` và bước vừa rồi không `failed`; ngược lại → `report`.

Lệnh `/feature <yêu cầu>`: model `resolveModel('@code')`, trả `{ kind: 'feature-report', data, text: summary }`.

Test `tests/feature.test.ts` (`MockProvider`, `AXIOM_HOME` tạm, repo tạm):
- `a 4-step plan runs every step and ends completed`
- `task_state.json reflects todo, doing, done in order`
- `answering no at approve runs no step`
- `a failed step stops the graph with status failed`
- `progress.log has one line per step`

## D2. Checkpointer và `/resume`

Branch `d/d2-checkpointer`.

1. `createCheckpointer(dbPath = path.join(axiomHome(), 'checkpoints.db'))` → `SqliteSaver.fromConnString(dbPath)`. Tạo thư mục nếu chưa có.
2. Mọi graph compile với checkpointer này; `thread_id` = `TaskState.threadId`.
3. `resumeTask`: `loadTaskState` → `graph.invoke(null, { configurable: { thread_id } })` chạy tiếp từ node cuối đã checkpoint. Bước `doing` lúc tắt: đánh lại `todo` và chạy lại bước đó (bước `done` không chạy lại).
4. Một cơ chế resume (`DESIGN.md` mục 2): xoá đường resume bằng `Checkpoint.stateSnapshot` trong `session.ts` (không ai đọc ngoài `session.ts`); checkpoint session chỉ còn giữ `filesSnapshot` cho `/undo`. `state-machine.ts` giữ vai trò theo dõi pha của `AgentLoop`, không lưu xuống đĩa. Ghi 1 dòng Nhật ký quyết định.
5. Lệnh `/resume [threadId]`: không có `threadId` → `listTasks()` lọc task còn bước `todo`/`doing`; 1 task thì chạy luôn, nhiều thì in bảng (`threadId`, mục tiêu cắt 1 dòng, `done/total`, `updatedAt`, mới nhất trước) rồi `ui.ask` chọn số.

Test `tests/resume.test.ts`:
- `killing after step 2 of 5 and resuming runs steps 3 to 5 only` (tiến trình con `tsx` bị `SIGKILL` khi `progress.log` có dòng step 2 xong)
- `goal and acceptance survive resume unchanged`
- `a step marked doing at crash is re-run once`
- `resume with no unfinished task says so`
- `/resume lists unfinished tasks newest first`
- `checkpoints persist across processes in checkpoints.db`

## D3. Compaction

Branch `d/d3-compaction`.

```ts
// src/core/compaction.ts
export const COMPACT_SECTIONS = ['Goal', 'Constraints', 'Completed steps', 'Current state', 'Open risks and next step'] as const;
export const COMPACT_THRESHOLD = 0.6;
export function shouldCompact(usedTokens: number, contextWindow: number, threshold?: number): boolean;
export function compactHistory(messages: readonly Message[], opts: { provider: BaseLLMProvider; model: string; task?: TaskState; signal?: AbortSignal }): Promise<{ summary: string; messages: Message[] }>;
export function missingSections(summary: string): string[];   // tên mục thiếu heading "## <tên>"
```

1. `compactHistory`: giữ message `system` + 4 message cuối; phần giữa gửi model 1 lần với yêu cầu đủ 5 heading. `missingSections` khác rỗng → hỏi lại 1 lần kèm tên mục thiếu; vẫn thiếu → thêm heading rỗng `## <tên>\n(không có)` và `bus.emit('error', ...)`. Có `task` → mục Goal/Constraints chép nguyên `goal`, `constraints`, `acceptance` từ `TaskState`, không lấy từ model.
2. `AgentLoop`: trước mỗi `provider.chat`, ước lượng token: lấy `usage.promptTokens` của lượt trước nếu có, không thì `ceil(độ dài ký tự / 4)` (cách `approxTokensOf` trong `mock.ts` đang làm); `shouldCompact` → `compactHistory`, thay `session.messages`.
3. Lệnh `/compact`: nén ngay, in tóm tắt.

Test `tests/compaction.test.ts`:
- `shouldCompact is true above 60 percent of the context window`
- `missingSections lists absent headings`
- `a summary missing a section is retried once`
- `compaction keeps system and last 4 messages`
- `task goal and acceptance are copied verbatim, not summarized`
- `agent loop compacts automatically past the threshold`

## D4. Memory

Branch `d/d4-memory`.

```ts
// src/core/memory.ts
export function memoryPath(workspaceRoot: string): string;   // path.join(axiomHome(), 'memory', `${basename(root)}-${sha256(realpath(root)).slice(0, 8)}.md`)
export function loadMemory(workspaceRoot: string): string;   // '' nếu chưa có
export function addMemory(workspaceRoot: string, note: string): void;   // thêm dòng "- <note>", qua redact
export function clearMemory(workspaceRoot: string): void;
```

1. `buildSystemPrompt(base, root)`: thêm khối `# Project memory\n<loadMemory>` khi khác rỗng, sau `loadProjectRules`.
2. Ghi memory: graph `feature` node `report` và `fix` node `report` (nhắn C) gọi `addMemory` với quy ước rút ra (model trả trong tool `submit_report` trường `conventions: string[]`, có thể rỗng).
3. Lệnh `/memory` in nội dung + đường dẫn; `/memory clear` → `ui.confirm` rồi `clearMemory`; `/memory add <ghi chú>`.

Test `tests/memory.test.ts`:
- `a new session sees saved memory in the system prompt`
- `clear removes memory from the next prompt`
- `memory for two repos with the same name is separate`
- `secret values are redacted before saving`
- `/memory clear asks before deleting`

## D5. Feature và eval UC-04

Branch `d/d5-eval`.

1. `evals/issues/feat-01..03/`: `request.md` (yêu cầu người dùng), `acceptance_test.py` (viết trước, fail trên tinydb gốc), `feature.json` `{ "minFiles": 3 }`. Ví dụ: thêm `Table.count_where`, thêm tham số `limit` cho `search`, thêm storage chỉ đọc. Mỗi cái cần sửa ≥ 3 file.
2. `evals/uc04/run.ts` export `runUc04: UcRunner`, 5 case:

   | Case | Làm | Đạt khi |
   |---|---|---|
   | `uc04-straight` | `runFeature` feat-01 một lèo | `acceptance_test.py` pass, 0 regression |
   | `uc04-resume-1` | feat-02, ngắt sau bước 2 (`AbortSignal`), `resumeTask` | Bước 1–2 không chạy lại; test pass |
   | `uc04-resume-2` | feat-03, ngắt 2 lần | Như trên |
   | `uc04-compaction` | `contextWindow` giả nhỏ để buộc nén | `missingSections` rỗng; `acceptance` còn nguyên |
   | `uc04-memory` | Phiên 1 `addMemory`, phiên 2 kiểm system prompt | Có memory |

3. `summary`: `featurePassRate` (trên 3 feature), `resumeOk`, `compactionOk`, `memoryOk`.
4. Thêm `'04': runUc04` vào `evals/registry.ts`. Ghi `docs/uc-04.md`.

Đạt: `featurePassRate ≥ 2/3`; 5/5 case đạt.

## D7. Ghép 10/11

Theo `phase-2.md` mục 11. Thêm: video Phase 1 còn nợ; `docs/plans/phase-2.md` tick checklist; tag `v0.2-phase2` (GitHub Release tạo tự động).

Xong làn D khi: `/feature` tắt ở bước 3, `/resume` làm tiếp bước 3 và xong; `npm run eval -- --uc 04` đạt.
