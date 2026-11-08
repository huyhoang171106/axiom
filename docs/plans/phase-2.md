# Phase Plan 2 — Mở rộng

| | |
|---|---|
| Thời gian | 28/10–10/11 (hạn của lớp: cuối tuần 9). Nhóm chốt **mọi task merge xong trước 23:59 CN 08/11**. T2–T3 (09–10/11) để sửa lỗi, eval thật, video, gắn tag |
| Theo dõi | GitHub Project https://github.com/orgs/se373agenticengineering/projects/30 (trường Sprint, Làn, Thứ tự), milestone `Phase 2`, mỗi task một issue có quan hệ blocked-by |
| Tag | `v0.2-phase2` |
| Người làm | A An, B Bảo, C Trâm, D Hoàng, E Bắc. Việc từng người: `phase-2-{A,B,C,D,E}.md` |
| Đọc kèm | `AGENTS.md`, `docs/CONVENTIONS.md`, `docs/DESIGN.md`, đề `2026-10-06_de_tai_01_coding_agent.md` (UC-01..05, mục 2.2, 2.3, 4, 6) |
| Repo | `https://github.com/se373agenticengineering/nhom-30`, remote `origin`, nhánh `main` |

| Làn | Người | UC | Phần |
|---|---|---|---|
| A | An | UC-01 | Role `@code` `@embed`, graph `triage → confirm → route`, eval runner chung, số đo thật UC-01, renderer IssueTicket |
| B | Bảo | UC-02 | Chunk bằng Python `ast`, embedder, BM25 + vector, index tăng dần, `/ask`, kiểm tra trích dẫn, trích dẫn bấm được |
| C | Trâm | UC-03 | `bug-06..10`, `apply_patch`, guard sửa test, `run_tests` tắt mạng, Verifier, skill `bug-fix`, graph `/fix`, diff viewer |
| D | Hoàng | UC-04 | D0 khung, task state, checkpointer SQLite, `/feature` `/resume`, compaction, memory, 3 feature, ghép; `/cost` chuyển A1 (#6) |
| E | Bắc | UC-05 | Danh mục rủi ro trong `decide()`, chống lách, `askHuman` bằng `interrupt()`, audit log, `/mode` `/plan` `/audit`, màn hình duyệt có mức rủi ro |

## 1. Quyết định đã chốt cho Phase 2

Ghi vào "Nhật ký quyết định" của `DESIGN.md` cùng PR này.

| # | Quyết định | Lý do |
|---|---|---|
| Q1 | Duyệt **từng tool call** vẫn đi qua `ToolRegistry.gate()` → `registry.approver` (Promise, tiến trình đứng chờ, không node nào chạy lại). `interrupt()` của LangGraph chỉ dùng cho **cổng người dùng giữa các node**: "Chạy route đề xuất?" (A), "Duyệt kế hoạch?" (D), "Giữ bản sửa?" (C), qua hàm chung `askHuman` (E3) | Resume sau `interrupt()` chạy lại cả node. Nếu node chứa `AgentLoop`, mọi tool trước đó trong node chạy lại lần nữa, vi phạm UC-05 tiêu chí 3 |
| Q2 | Mỗi workflow là một `StateGraph` trong `src/agents/<uc>.ts`. Node nào cần model thì tạo `AgentLoop` riêng với `systemPrompt`, `model`, `ToolRegistry([...])` của role, như `runTriage` | Giữ nguyên đường `executeTool` + `decide()` của Phase 1 |
| Q3 | Checkpointer: `@langchain/langgraph-checkpoint-sqlite` (`SqliteSaver`), file `~/.axiom/checkpoints.db` | Bản chính thức, có sẵn binary cho Linux/Windows/macOS. Nếu `npm install` lỗi trên máy nào: báo D trong ngày, D thay bằng saver tự viết trên `node:sqlite` |
| Q4 | Chunk code Python bằng module `ast` của chính Python (gọi `python -I -c <script>`), không dùng tree-sitter | Target repo là Python, máy đã cần Python để chạy pytest; không thêm dependency native hay wasm. Đề cho phép "AST hoặc tree-sitter" (mục 2.3) |
| Q5 | Embedding qua role `@embed` trong config. Hai cách gọi: `api: "ollama-chat"` → `POST <baseUrl>/api/embed`; còn lại → `POST <baseUrl>/embeddings` (dạng OpenAI). Vector lưu JSON, tìm bằng cosine duyệt hết | Tinydb vài trăm chunk, không cần vector DB. Không hardcode model trong `src/` |
| Q6 | Cài thêm đúng 3 package: `@langchain/langgraph`, `@langchain/core`, `@langchain/langgraph-checkpoint-sqlite`. Ngoài 3 package này, ai muốn thêm dependency phải ghi Nhật ký trước | `CONVENTIONS.md` mục TypeScript |

## 2. Yêu cầu của lớp

| Yêu cầu (`DESIGN.md` mục 6) | Task |
|---|---|
| RAG có trích dẫn | B1–B5 |
| Resume + nén context | D2, D3 |
| LangGraph có bước duyệt | D0, E3, A2, C5, D1 |
| ≥ 3 UC | UC-01..05 |

Còn nợ từ Phase 1: video demo (`phase-1.md` mục Ghép). D quay ở D7.

## 3. Lịch theo sprint (mỗi sprint một ngày)

| Sprint | A | B | C | D | E |
|---|---|---|---|---|---|
| 1 · T4 04/11 | A1 | B1 | C1 | **D0** (merge trước 12:00), D1 | E1 |
| 2 · T5 05/11 | A2 | B2 | C2, C4 | D2 | E2 |
| 3 · T6 06/11 | A3 | B3 | C3 | D3, D4 | E3 |
| 4 · T7 07/11 | A4 | B4 | C5 | D5 | E4, E5 |
| 5 · CN 08/11 | A5 | B5 | C6, C7 | D7 ghép | E6 |
| T2–T3 09–10/11 | Sửa lỗi, eval thật UC-01, `docs/uc-01.md` | Như A cho UC-02 | Như A cho UC-03 | Eval `--all`, video, tag | Như A cho UC-05 |

Task đầu của A, B, C, E (A1, B1, C1, E1) không cần file của D0, làm được ngay 04/11 kể cả khi D0 trễ.

## 4. Luồng chạy

```
 /triage <issue> ─► [triage] ─► [confirm: askHuman "Chạy route?"] ─► END ─► yes: runRoute (ngoài graph)
                                                                       ├─ answer    ─► answerQuestion (B)
                                                                       ├─ fix       ─► fixIssue (C)
                                                                       ├─ implement ─► runFeature (D)
                                                                       ├─ ask_user  ─► hỏi bổ sung một lần → triage lại → confirm route
                                                                       └─ reject    ─► in lý do

 /fix  : [reproduce] ─► [locate] ─► [patch] ─► [verify] ─┬─ pass ─► [keep: askHuman "Giữ bản sửa?"] ─► report
                                     ▲                    └─ fail, vòng < 5 ─┘   (vòng 5 fail ─► report thất bại)

 /feature : [plan] ─► [approve: askHuman "Duyệt kế hoạch?"] ─► [step] ─► (còn bước? quay lại [step]) ─► [report]
            checkpoint SQLite sau mỗi node; /resume <threadId> chạy tiếp từ node cuối

 Mọi tool call (mọi node): ToolRegistry.executeTool ─► gate() ─► decide() ─► allow | ask (approver) | deny ─► audit
```

## 5. Hợp đồng D0

> **Cập nhật 06/11**: D0 (Khung Phase 2), D2 (SQLite checkpointer, snapshotFiles, restoreFiles) và A3 (Eval runner chung, gates, provenance) đã hoàn tất và merge vào `main`. Toàn bộ hợp đồng, seam và stubs đã có thân thật trên `main`. Các làn B, C, D, E bám trực tiếp vào code và contract trên `main` để hoàn tất nhiệm vụ, không còn bị chặn bởi D0.

D0 tạo mọi file dưới đây với thân stub (`throw new Error('chưa làm')` hoặc trả giá trị rỗng như ghi). Chữ ký là hợp đồng: **KHÔNG ĐƯỢC** đổi nếu chưa ghi Nhật ký quyết định.

### 5.1. Dùng chung (D0 làm xong luôn, không stub)

```ts
// src/core/types.ts — thêm 2 role
export type ModelRole = 'default' | 'smol' | 'slow' | 'task' | 'plan' | 'review' | 'code' | 'embed';

// src/tools/permissions.ts — thêm field tuỳ chọn (code cũ không phải sửa)
export type Risk = 'low' | 'medium' | 'high';
export interface PolicyDecision { verdict: Verdict; reason: string; risk?: Risk }
export interface ApprovalRequest { name: string; args: Record<string, unknown>; reason: string; risk?: Risk }

// src/core/event-bus.ts — thêm 2 event vào AxiomEvents; src/core/trace.ts thêm cả 2 vào TRACED_EVENTS
node: (data: { graph: string; node: string; phase: 'enter' | 'exit'; threadId?: string }) => void;
approval: (data: { tool: string; reason: string; risk?: Risk; decision: 'approve' | 'deny' | 'edited' | 'auto-deny'; approver: string }) => void;

// src/core/graph.ts
import type { BaseCheckpointSaver } from '@langchain/langgraph';
export function createCheckpointer(dbPath?: string): BaseCheckpointSaver; // mặc định path.join(axiomHome(), 'checkpoints.db'); stub trả new MemorySaver()
export function newThreadId(kind: 'triage' | 'fix' | 'feature'): string;  // `${kind}-${YYYYMMDD-HHmmss}-${6 hex}`
export type GraphNode<S> = (s: S, config: LangGraphRunnableConfig) => Promise<Partial<S>>;
export function traceNode<S>(bus: EventBus, graph: string, node: string, fn: GraphNode<S>): GraphNode<S>; // threadId lấy từ config.configurable.thread_id

// src/core/execution-context.ts — một bản mỗi phiên (TUI, headless); CommandContext và RouteContext kế thừa
export interface ExecutionContext { tools: ToolRegistry; bus: EventBus; costTracker: CostTracker; runId: string }
// src/tools/registry.ts — view cho một node: chỉ thu hẹp, dùng chung approver/allowWithoutApprover của registry phiên
scoped(allowed: readonly string[]): ToolRegistry;
// src/core/paths.ts
export function pythonBin(): string; // AXIOM_PYTHON, rồi python3 (Windows: python)
// bọc thân node: emit node enter, chạy fn, emit node exit. Mọi node của mọi graph PHẢI bọc bằng hàm này
```

### 5.2. Stub để chủ làn điền

| File | Chữ ký | Stub trả | Điền |
|---|---|---|---|
| `src/core/human-gate.ts` | `askHuman(question: string, choices: readonly string[]): string` (gọi trong node, dùng `interrupt`)<br>`runGraph<S>(graph: CompiledGraph, input: Partial<S> \| null, opts: { threadId: string; ui: CommandUI; signal?: AbortSignal }): Promise<S>` (chạy, gặp interrupt thì hỏi `ui`, resume bằng `new Command({ resume })`, lặp đến hết) | Thân thật (D0). yes/no qua `ui.confirm`, khác qua `ui.ask`, sai thì lấy lựa chọn cuối | E3 (hỏi lại, nối TUI) |
| `src/agents/route.ts` | `runRoute(ticket: IssueTicket, issue: string, ctx: RouteContext): Promise<RouteResult>`<br>`interface RouteContext extends ExecutionContext { workspaceRoot: string; config: AxiomConfig; ui: CommandUI; signal: AbortSignal }`<br>`interface RouteResult { route: IssueTicket['route']; text: string; data?: unknown }` | `{ route, text: 'chưa làm' }` | A2 |
| `src/core/rag/types.ts` | Xem 5.3 | (chỉ kiểu) | — |
| `src/core/rag/chunker.ts` | `chunkRepo(root: string): Promise<Chunk[]>` | `[]` | B1 |
| `src/core/rag/embedder.ts` | `createEmbedder(info: ModelInfo): Embedder`<br>`fakeEmbedder(dim?: number): Embedder` (băm từ → vector cố định, dùng trong test) | throw | B2 |
| `src/core/rag/index.ts` | `class RepoIndex { static open(root: string, embedder: Embedder, opts?: { dir?: string }): Promise<RepoIndex>; update(): Promise<IndexDiff>; search(query: string, k?: number): Promise<ScoredChunk[]> }` | `search` trả `[]` | B2, B3 |
| `src/core/rag/citations.ts` | `parseCitations(text: string): Citation[]`<br>`validateCitation(c: Citation, root: string, retrieved: readonly Chunk[], teamDir?: string): string \| null` (null = hợp lệ, chuỗi = lý do sai) | `[]`, `null` | B4 |
| `src/agents/ask.ts` | `answerQuestion(question: string, opts: AskOptions): Promise<AskAnswer>`<br>`interface AskOptions { workspaceRoot: string; provider: BaseLLMProvider; model: string; embedder: Embedder; signal?: AbortSignal; bus?: EventBus; costTracker?: CostTracker }`<br>`interface AskAnswer { text: string; citations: Citation[]; found: boolean }` | throw | B4 |
| `src/tools/apply-patch.ts` | `class ApplyPatchTool extends BaseTool` (`name = 'apply_patch'`, tham số `{ patch: string }`)<br>`parseUnifiedDiff(patch: string): FilePatch[]` | `execute` trả lỗi "chưa làm" | C2 |
| `src/tools/test-guard.ts` | `findTestTampering(patches: readonly FilePatch[], workspaceRoot: string): string \| null` | `null` | C2 |
| `src/core/verifier.ts` | `runPytest(root: string, opts?: { target?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<TestRun>`<br>`findRegressions(before: TestRun, after: TestRun): string[]`<br>`interface TestRun { passed: string[]; failed: string[]; timedOut: boolean; exitCode: number \| null; output: string }` | throw | C3 |
| `src/tools/run-tests.ts` | `class RunTestsTool extends BaseTool` (`name = 'run_tests'`, tham số `{ target?: string }`) | lỗi "chưa làm" | C3 |
| `src/agents/fix.ts` | `fixIssue(opts: FixOptions): Promise<FixReport>` (kiểu ở `phase-2-C.md` C5, thêm `tools: ToolRegistry`, `costTracker?: CostTracker`) | throw | C5 |
| `src/core/task-state.ts` | Kiểu và hàm ở `phase-2-D.md` D1 | `null`, `[]` | D1 |
| `src/agents/feature.ts` | `FeatureOptions` thêm `tools: ToolRegistry`, `costTracker?: CostTracker`<br>`runFeature(request: string, opts: FeatureOptions): Promise<FeatureReport>`<br>`resumeTask(threadId: string \| undefined, opts: FeatureOptions): Promise<FeatureReport>` | throw | D1, D2 |
| `src/core/compaction.ts` | `COMPACT_SECTIONS`, `shouldCompact`, `compactHistory`, `missingSections` (`phase-2-D.md` D3) | `false`, `''`, `[]` | D3 |
| `src/core/memory.ts` | `memoryPath`, `loadMemory`, `addMemory`, `clearMemory` (`phase-2-D.md` D4) | `''` | D4 |
| `src/core/audit.ts` | `recordDecision(entry: AuditEntry): void`, `readAudit(limit?: number): AuditEntry[]` (`phase-2-E.md` E4) | không làm gì, `[]` | E4 |
| `src/tools/denied-actions.ts` | `actionKey(name: string, args: Record<string, unknown>): string`, `class DeniedActions { add(key: string): void; has(key: string): boolean }` | key = `name + JSON.stringify(args)` | E2 |
| `src/commands/{ask,fix,feature,resume,memory,compact,cost,mode,plan,audit}.ts` | `Command` như `src/commands/types.ts`; đăng ký trong `src/commands/index.ts` | `run` throw `'chưa làm'` | B4, C5, D1, D2, D4, D3, A1, E5, E5, E4 |
| `evals/types.ts` | Xem 5.4 | (chỉ kiểu) | — |
| `evals/registry.ts` | `export const UC_RUNNERS: Record<string, UcRunner>`; D0 đăng ký `'01'` bọc code cũ | `'02'`..`'05'` chưa có | A3, rồi B5, C6, D5, E6 thêm dòng |
| `evals/issues/feat-01..03/README.md` | Mô tả cấu trúc thư mục feature | — | D5 |
| `skills/bug-fix/SKILL.md` | Khung trống đủ tiêu đề mục | — | C4 |

### 5.3. Kiểu RAG (nguyên văn)

```ts
// src/core/rag/types.ts
export type ChunkSource = 'repo' | 'team';   // team: quy ước code của nhóm (đề mục 2.3), ở knowledge/ của Axiom
export interface Chunk {
  id: string;                 // `${path}:${startLine}-${endLine}`, tài liệu team có tiền tố `team:`
  path: string;               // tương đối với workspaceRoot (hoặc thư mục team), dấu '/'
  source?: ChunkSource;       // thiếu = 'repo'
  symbol: string | null;      // 'TinyDB.insert', 'Query.search', null với tài liệu
  kind: 'function' | 'class' | 'method' | 'module' | 'doc';
  startLine: number;          // 1-based, gồm cả decorator
  endLine: number;            // 1-based, gồm
  fileType: 'python' | 'markdown' | 'text';
  text: string;
}
export interface ScoredChunk extends Chunk { score: number }
export interface Citation { path: string; startLine: number; endLine: number; source?: ChunkSource }
export interface IndexDiff { added: string[]; changed: string[]; removed: string[] }
export type Embedder = (texts: readonly string[]) => Promise<number[][]>;
```

### 5.4. Kiểu eval (nguyên văn)

```ts
// evals/types.ts
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
export interface UcRunOptions { mock: boolean; config: AxiomConfig; workDir: string } // workDir: thư mục tạm của lần chạy
export type UcRunner = (opts: UcRunOptions) => Promise<UcResult>;
```

## 6. Ai sở hữu file nào

Chỉ chủ sở hữu được sửa thân file. File "chung" chỉ được **thêm dòng**.

| File | Chủ |
|---|---|
| `src/agents/triage.ts`, `src/agents/route.ts`, `src/commands/triage.ts`, `src/commands/cost.ts`, `evals/run.ts`, `evals/registry.ts` (khung), `evals/uc01/` | A |
| `src/core/rag/*`, `src/agents/ask.ts`, `src/commands/ask.ts`, `evals/uc02/` | B |
| `src/tools/apply-patch.ts`, `src/tools/test-guard.ts`, `src/tools/run-tests.ts`, `src/core/verifier.ts`, `src/tools/sandbox.ts`, `src/agents/fix.ts`, `src/commands/fix.ts`, `skills/bug-fix/`, `evals/issues/bug-*`, `evals/issues/bugs.ts`, `evals/uc03/` | C |
| `src/core/graph.ts`, `src/core/task-state.ts`, `src/agents/feature.ts`, `src/core/compaction.ts`, `src/core/memory.ts`, `src/core/agent-loop.ts`, `src/core/session.ts`, `src/core/state-machine.ts`, `src/core/prompt.ts`, `src/core/trace.ts`, `src/commands/{feature,resume,memory,compact}.ts`, `src/core/execution-context.ts`, `evals/issues/feat-*`, `evals/uc04/` | D |
| `src/tools/permissions.ts`, `src/tools/registry.ts`, `src/tools/denied-actions.ts`, `src/core/audit.ts`, `src/core/human-gate.ts`, `src/commands/{mode,plan,audit}.ts`, `src/tui/*` (trừ renderer riêng bên dưới), `evals/uc05/` | E |
| `src/tui/components/issue-ticket.tsx` | A |
| `src/tui/components/citation.tsx` | B |
| `src/tui/components/diff-view.tsx`, `src/tui/components/fix-progress.tsx` | C |
| Chung, chỉ thêm dòng: `src/commands/index.ts`, `evals/registry.ts` (dòng đăng ký UC), `src/core/event-bus.ts`, `package.json`, `.github/workflows/ci.yml`, `docs/DESIGN.md` (Nhật ký) | — |

Renderer TUI theo `kind` của `CommandResult`: chủ UC viết component trong file của mình; E nối component vào `src/tui/app.tsx` khi được nhắn tên `kind` (`issue-ticket`, `ask-answer`, `fix-report`, `feature-report`).

## 7. Seam (dùng gì khi phần của người khác chưa merge)

| Cần | Của | Trước khi có thân thật, dùng |
|---|---|---|
| Checkpointer SQLite | D2 | Stub D0 trả `MemorySaver` (mất khi tắt tiến trình, đủ cho test) |
| `askHuman`, `runGraph` | D0 | Đã có thân thật |
| `RepoIndex.search` | B3 | Tool `search_code` |
| `apply_patch` | C2 | Tool `edit` |
| `runPytest`, `run_tests` | C3 | `run_command` với `python -m pytest -q` |
| `loadMemory` | D4 | Stub trả `''` |
| `recordDecision` | E4 | Stub không làm gì |
| `UC_RUNNERS` | A3 | Gọi hàm `runUcNN` của mình trực tiếp trong test |
| `answerQuestion`, `fixIssue`, `runFeature` (từ `runRoute`) | B4, C5, D1 | Test `runRoute` truyền hàm giả qua tham số `deps` (`phase-2-A.md` A2) |
| Luật `decide()` cho `apply_patch`, `run_tests` | E1 | `ApplyPatchTool` tự từ chối đường dẫn ngoài workspace và file bí mật (bắt buộc giữ cả sau E1) |

## 8. Quy tắc làm việc

1. Mỗi task một branch từ `main`: `<làn>/<task>-<slug>` viết thường, ví dụ `b/b2-embedder`.
2. Trước khi push: `git fetch origin && git rebase origin/main && npm run lint && npm test`.
3. Push, mở PR, chờ CI và tự merge: `scripts/ship.sh` (`CONVENTIONS.md` mục Git). Check nào đỏ thì script dừng, không merge.
4. Tiêu đề PR và mọi commit: `type(scope): subject` ≤ 72 ký tự. Thân PR (tiếng Việt): mã task, cách đã kiểm tra.
5. Test không gọi mạng thật: model dùng `MockProvider`, embedding dùng `fakeEmbedder`, HTTP dùng server giả trên `127.0.0.1`, `AXIOM_HOME` là thư mục tạm.
6. Test cần Python/pytest: bỏ qua có lý do khi không có Python, theo mẫu `{ skip: !hasPython && 'needs python + pytest' }`; CI cài Python (C thêm bước vào `ci.yml` ở C3).
7. Xong task: đổi cột Trạng thái của dòng đó trong `phase-2-<làn>.md` thành `done` ngay trong PR của task.
8. Kẹt quá 2 giờ vì phần của người khác: dùng Seam ở mục 7, nhắn nhóm, làm tiếp task sau.

## 9. Bản dùng được (kiểm tối CN 08/11)

- [x] `npm install && npm start` mở TUI như Phase 1.
- [x] `/triage <issue bug>` → bảng IssueTicket → hỏi "Chạy route đề xuất? [Y/n]" → Y → `/fix` chạy. (Đã thấy ticket và câu hỏi duyệt route trong phiên thật; nhánh chạy `/fix` kiểm riêng bằng `/fix` trực tiếp, xem `docs/d6-tui-integration.md`.)
- [ ] `/ask "Hàm insert nằm ở đâu?"` → câu trả lời có `tinydb/table.py:Lx-Ly` bấm được; `/ask "Có hỗ trợ MongoDB không?"` → "không tìm thấy trong repo". **Chưa kiểm được trên TUI**: `POST /api/embed` của ollama treo trong lượt kiểm và axiom không có timeout cho embed, nên TUI đứng ở `Đang xử lý…`; lý do đầy đủ ở `docs/d6-tui-integration.md` mục 8.
- [x] `/fix evals/issues/bug-01` → diff tô màu, tiến trình vòng n/5, test xanh, hỏi "Giữ bản sửa?". (Diff và báo cáo fail-closed đã thấy trong phiên thật; câu hỏi "Giữ bản sửa?" chỉ xuất hiện khi sửa thành công nên lượt này không có.)
- [x] `/feature "<yêu cầu feat-01>"` → duyệt kế hoạch → `Ctrl+C` hai lần → `npm start` → `/resume` → làm tiếp từ bước còn thiếu, không chạy lại bước đã xong.
- [x] Hội thoại vượt 60% context tự nén; `/compact` nén tay; `/memory` xem, `/memory clear` xoá.
- [x] Chat "cài requests" → dừng chờ duyệt, hiện mức rủi ro → `n` → agent không thử `pip3 install requests` → `/audit` thấy dòng `deny`.
- [x] `/mode read-only` → agent không còn tool ghi; `/cost` in token và chi phí phiên.

## 10. Tiêu chí xong

| UC | Lệnh | Ngưỡng (đề) | Ghi kết quả vào |
|---|---|---|---|
| 01 | `npm run eval -- --uc 01` | `type` đúng ≥ 80% với model thật; 100% hợp lệ schema; case injection không đổi hành vi | `docs/uc-01.md` |
| 02 | `npm run eval -- --uc 02` | Recall@5 ≥ 0,8; 100% trích dẫn hợp lệ | `docs/uc-02.md` |
| 03 | `npm run eval -- --uc 03` | ≥ 4/10 bug sửa đúng (test giấu); 0 regression; guard chặn 100% patch sửa assertion | `docs/uc-03.md` |
| 04 | `npm run eval -- --uc 04` | 5/5 case resume, compaction, memory đạt; ≥ 2/3 feature pass test chấp nhận | `docs/uc-04.md` |
| 05 | `npm run eval -- --uc 05` | 100% hành động rủi ro chờ duyệt; 0 hành động cấm được chạy | `docs/uc-05.md` |

- [x] `npm run eval -- --all --mock` xanh trong CI (`scripts/ci-local.sh` bước 6 chạy `--all --mock` khi có `bwrap` + `python3`, thiếu thì fallback UC-01 và in lý do; lượt 08/11 exit 0 với cả 5 UC).
- [x] `npm run eval -- --all` với model thật ra `evals/results.json` có token, chi phí, độ trễ trung bình mỗi case (đề mục 6.2). Đây là **lần chạy 1** cho so sánh 2 lần ở Phase 3 (đề mục 6.3). Bản sao đã commit: `docs/eval-run-1.json` (`runAt` 2026-11-08T11:11:06Z, `releaseEligible: true`).
- [x] Trace có event `node` và `approval`; test `no registered secret value reaches the trace` vẫn pass.
- [x] Mỗi `docs/uc-XX.md` có: thiết kế (sơ đồ ASCII), failure mode đã gặp, bảng kết quả eval thật, model đã dùng, chi phí.

Máy eval thật (P2-R0, #38; quyết định ở `DESIGN.md` mục 9, 2026-11-04): máy của D, D vận hành. Dựng lại trên máy khác:

1. `/login anthropic` (OAuth Claude Pro/Max). `@default` = `anthropic/claude-opus-5-5`.
2. `docker run -d --name ollama --restart unless-stopped -p 127.0.0.1:11434:11434 -v ollama:/root/.ollama ollama/ollama`, rồi `docker exec ollama ollama pull qwen3-embedding:0.6b`.
3. `~/.axiom/config.json`: `"modelRoles": { "embed": "ollama/qwen3-embedding:0.6b" }`; `axiom models refresh` phải in `Refreshed: ollama`.
4. Python ≥ 3.12 có pytest, bwrap dùng được (`planSandbox().kind === 'bwrap'`).

## 11. Ghép (tối CN 08/11, D chủ trì; tag sau khi eval thật xong, chậm nhất 10/11)

1. [x] Kiểm mọi PR đã merge: `gh pr list --state open` rỗng.
2. [x] `git switch main && git pull && npm install && npm run lint && npm test`.
3. [x] Chạy checklist mục 9 trên TUI thật, ghi dòng nào hỏng vào nhóm chat, chủ làn sửa trong ngày. Bằng chứng: `docs/d6-tui-integration.md`; dòng `/ask` chưa kiểm được (ollama treo ở `/api/embed`).
4. [x] `npm run eval -- --all`, commit `evals/results.json` vào `docs/eval-run-1.json` qua PR.
5. [x] Quyết định bỏ quay video demo (ghi vào `docs/DESIGN.md` ngày 08/11/2026); `git tag v0.2-phase2 && git push origin v0.2-phase2` gắn kèm release notes trỏ tới `docs/eval-run-1.json` và `docs/d6-tui-integration.md`.

Video: `/triage` bug → Y → `/fix` ra diff + test xanh → `/ask` có trích dẫn, bấm mở file → `/feature` tắt giữa chừng → `/resume` → chat "cài requests" bị dừng, từ chối → `/audit` → `npm run eval -- --all`.
