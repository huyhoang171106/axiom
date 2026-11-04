# Phase 2 — A (An): UC-01 graph, route, eval runner chung

Đọc trước: `phase-2.md` mục 1, 5, 7, 8; đề UC-01 (tiêu chí 5), mục 6.1–6.2; `src/agents/triage.ts`, `src/commands/triage.ts`, `evals/run.ts`.

| # | Ngày | Việc | Trạng thái |
|---|---|---|---|
| A1 | 04/11 | Role `@code`/`@embed`, `/cost` theo model và budget theo run (#6) | done |
| A2 | 05/11 | Graph `triage → confirm → route`, điền `runRoute` | |
| A3 | 06/11 | `UC_RUNNERS`, `--uc NN`, `--all`, chỉ số mục 6.2 | |
| A4 | 07/11 | Số đo thật UC-01 | |
| A5 | 08/11 | Renderer IssueTicket trong TUI | |

## A1. Model theo role

Branch `a/a1-roles`. D0 đã merge; A1 sở hữu `/cost` theo #6. Resolver báo lỗi khi thiếu `modelRoles.embed`, `@code` fallback `@default`. `/cost` đọc tracker phiên, báo input/output và cost theo model; budget `AgentLoop.runTask` chỉ tính usage của run đó, không cộng chung các node workflow.

| Lệnh / workflow | Role | Chỗ gọi |
|---|---|---|
| `/triage`, node `triage` | `@smol` | `src/commands/triage.ts` (đã có) |
| `/ask` | `@default` | `src/commands/ask.ts` (B) |
| `/fix`, `/feature` | `@code` | `src/commands/fix.ts` (C), `src/commands/feature.ts` (D) |
| `/review` (Phase 3) | `@review` | — |
| embedding | `@embed` | `src/core/rag/embedder.ts` (B) |

Nghiệm thu: resolver trả `ModelInfo` và không fallback `@embed`; `/cost` báo token vào/ra và cost ước tính theo model cùng tổng phiên; budget mỗi `runTask` độc lập với tổng phiên. Kiểm bằng test resolver, tracker, command và loop; chạy `npm run lint && npm test && npm run build`. Tracker chỉ lưu model ID, không phân biệt provider có cùng ID.

## A2. Graph triage và `runRoute`

Branch `a/a2-triage-graph`. Cần D0 (`graph.ts`, `human-gate.ts`, `route.ts` stub).

Hợp đồng (D0 đã tạo, A điền thân):

```ts
// src/agents/route.ts
export interface RouteContext { workspaceRoot: string; config: AxiomConfig; ui: CommandUI; signal: AbortSignal; bus: EventBus }
export interface RouteResult { route: IssueTicket['route']; text: string; data?: unknown }
export interface RouteDeps {           // thêm mới, A sở hữu; test truyền hàm giả
  answer: typeof answerQuestion;
  fix: typeof fixIssue;
  feature: typeof runFeature;
}
export function runRoute(ticket: IssueTicket, issue: string, ctx: RouteContext, deps?: RouteDeps): Promise<RouteResult>;

// src/agents/triage.ts — thêm, giữ nguyên runTriage cũ
export interface TriageGraphState { issue: string; ticket: IssueTicket | null; warnings: string[]; confirmed: boolean; result: RouteResult | null }
export function buildTriageGraph(opts: TriageOptions & { ctx: RouteContext; deps?: RouteDeps }): CompiledStateGraph;
```

Bước:
1. `buildTriageGraph`: 3 node, mỗi node bọc `traceNode(bus, 'triage', '<tên>', fn)`.
   - `triage`: gọi `runTriage(opts)` cũ, ghi `ticket`, `warnings`.
   - `confirm`: nếu `route` là `ask_user` hoặc `reject` thì `confirmed = true` không hỏi. Ngược lại `askHuman('Chạy route đề xuất (<route>)?', ['yes', 'no'])`; `confirmed = answer === 'yes'`.
   - `route`: `confirmed` thì `runRoute`, không thì `result = { route, text: 'Đã dừng theo yêu cầu.' }`.
   - Compile với `checkpointer: createCheckpointer()`, `thread_id = newThreadId('triage')`.
2. `runRoute`:

   | `route` | Làm | `text` |
   |---|---|---|
   | `answer` | `deps.answer(issue, { workspaceRoot, provider, model: '@default', embedder, signal, bus })` | `AskAnswer.text` |
   | `fix` | `deps.fix({ issue, workspaceRoot, ... })` | `FixReport.summary` |
   | `implement` | `deps.feature(issue, { ... })` | `FeatureReport.summary` |
   | `ask_user` | không gọi model | mỗi câu trong `ticket.missing_info` một dòng `- <câu>` |
   | `reject` | không gọi model | `ticket.summary` |

   `deps` mặc định là hàm thật import từ `ask.ts`, `fix.ts`, `feature.ts`.
3. `src/commands/triage.ts`: chạy graph qua `runGraph(graph, { issue }, { threadId, ui: ctx.ui, signal: ctx.signal })`. Trả `CommandResult { kind: 'issue-ticket', data: { ticket, warnings, result }, text }`.
4. Headless (`axiom triage ...`): `ui.confirm` trả `false` khi không có TTY nên không chạy route; thêm cờ `--yes` để chạy luôn.

Test `tests/triage-graph.test.ts` (`MockProvider` trả tool call `submit_issue_ticket`, `deps` là spy, `AXIOM_HOME` tạm):
- `routes a bug ticket to fix after the user confirms`
- `does not call any workflow when the user answers no`
- `answer, implement each reach their workflow once` (2 case trong một test bảng)
- `ask_user prints missing_info questions without a model call`
- `reject returns the ticket summary`
- `trace has node enter and exit for triage, confirm, route`

Kiểm: `npx tsx --test tests/triage-graph.test.ts tests/triage.test.ts && npm run lint`.

## A3. Eval runner chung

Branch `a/a3-eval-runner`. Cần D0 (`evals/types.ts`, `evals/registry.ts`).

Hợp đồng: `UcRunner`, `UcResult`, `UcCaseResult` ở `phase-2.md` mục 5.4.

Bước:
1. Chuyển code UC-01 hiện có trong `evals/run.ts` sang `evals/uc01/run.ts`, export `runUc01: UcRunner`. `metrics` mỗi case: `schemaValid`, `typeCorrect`, `routeCorrect`. `summary`: `schemaValidRate`, `typeAccuracy`, `routeAccuracy`.
2. `evals/run.ts` còn lại: `parseArgs` nhận `--uc NN` (lặp được), `--all`, `--mock`. Không có `--uc` và không có `--all` thì lỗi `"Pass --uc NN or --all"`.
3. Với mỗi UC chọn: có trong `UC_RUNNERS` thì chạy; không có thì in `UC NN: chưa có runner` và bỏ qua (exit code không đổi).
4. Mỗi case: `new CostTracker()` riêng; `latencyMs` đo bằng `performance.now()` quanh lần chạy case; `tokens` = prompt + completion của tracker. Hàm dùng chung: `export async function measureCase<T>(id: string, fn: (tracker: CostTracker) => Promise<T>): Promise<{ value?: T; tokens: number; costDollars: number; latencyMs: number; error?: string }>` trong `evals/measure.ts` — B, C, D, E gọi hàm này trong runner của mình.
5. Ghi `evals/results.json`: `{ runAt: ISO, mock: boolean, ucs: UcResult[] }`; mỗi `UcResult.summary` luôn có thêm `avgTokens`, `avgCostDollars`, `avgLatencyMs`.
6. Exit code 1 khi có case `mustPass` thất bại (giữ quy tắc Phase 1).
7. CI (`.github/workflows/ci.yml`, thêm dòng): đổi bước eval thành `npm run eval -- --all --mock`.

Test `tests/eval-runner.test.ts`:
- `--all runs every registered UC and skips missing ones`
- `each case gets its own cost tracker`
- `summary has avgTokens, avgCostDollars, avgLatencyMs`
- `missing --uc and --all is an error`

Kiểm: `npx tsx --test tests/eval-runner.test.ts && npm run eval -- --all --mock && npm run lint`.

## A4. Số đo thật UC-01

Branch `a/a4-uc01-real`. Cần key thật trên máy A (không commit key).

1. Đặt `modelRoles.smol` trong `~/.axiom/config.json`.
2. `npm run eval -- --uc 01`. Ghi lại `typeAccuracy`, `routeAccuracy`, `schemaValidRate`.
3. `typeAccuracy < 0.8`: sửa `skills/issue-triage/SKILL.md` hoặc prompt trong `triage.ts` (chỉ phần mô tả loại issue, ví dụ phân biệt `bug` và `question`), chạy lại. Mỗi lần sửa ghi một dòng vào bảng "Các lần thử" trong `docs/uc-01.md`.
4. `docs/uc-01.md` có: sơ đồ graph, bảng 10 case (id, expected, actual, đúng/sai), model đã dùng, tổng token và chi phí, failure mode đã gặp.

Đạt: `typeAccuracy ≥ 0.8`, `schemaValidRate = 1`, case injection (`uc01-*-injection*`) đúng `expected` và không có `unexpectedToolCalls`.

## A5. Renderer IssueTicket

Branch `a/a5-ticket-view`. Cần A2.

1. `src/tui/components/issue-ticket.tsx`: `export function IssueTicketView(props: { ticket: IssueTicket; warnings: string[]; width: number }): JSX.Element`. Bảng 2 cột: `type`, `severity`, `route`, `summary`, `affected_files`, `missing_info`. Mỗi path trong `affected_files` bọc OSC 8 `file://<workspaceRoot>/<path>` (dùng hàm `fileLink` của B4 nếu đã merge, chưa thì viết tạm trong file này và xoá khi B4 merge).
2. Nhắn E tên `kind` `issue-ticket`; E nối vào `app.tsx`. Câu hỏi "Chạy route đề xuất? [Y/n]" đi qua `askHuman` → `ui.confirm` của TUI (E3).
3. Test `tests/tui-issue-ticket.test.ts`, dùng `renderToString(createElement(...), { columns })` của `ink` như `tests/tui-components.test.ts`:
   - `renders every ticket field at 80 columns`
   - `long summary wraps without breaking the table at 80 columns`
   - `affected_files are OSC 8 links`
4. Chụp ảnh 80 và 120 cột, đính vào PR.

Xong làn A khi: `/triage <issue bug>` → bảng → Y → `/fix` chạy; `npm run eval -- --all --mock` xanh; `docs/uc-01.md` có số thật.
