# Phase 2 — A (An): UC-01 graph, route, eval runner chung

Đọc trước: `phase-2.md` mục 1, 5, 7, 8; đề UC-01 (tiêu chí 5), mục 6.1–6.2; `src/agents/triage.ts`, `src/commands/triage.ts`, `evals/run.ts`.

| # | Ngày | Việc | Trạng thái |
|---|---|---|---|
| A1 | 04/11 | Role `@code`/`@embed`, `/cost` theo model và budget theo run (#6) | done |
| A2 | 05/11 | Graph `triage → confirm`, gọi `runRoute` ngoài graph (#7) | in progress |
| A3 | 06/11 | `UC_RUNNERS`, `--uc NN`, `--all`, chỉ số mục 6.2 (#8) | in progress |
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

Branch `laneA` (theo yêu cầu của An). Nghiệm thu theo issue #7.

- Graph `triage → confirm` dùng checkpointer chung và `askHuman`; command gọi `runRoute` sau graph khi đã duyệt. Workflow nằm ngoài node để resume không lặp thao tác sửa.
- `answer` dùng `@default` và embedder `@embed`; `fix`/`implement` dùng `@code`. Resolve thành `ModelInfo.id` trước provider call, chỉ tạo embedder cho `answer`.
- `ask_user`/`reject` không gọi workflow/model khác; hiển thị type, priority, missing_info theo schema hiện tại (không có `summary`).
- Truyền registry, bus, tracker, UI và signal của phiên. Triage lấy scoped registry, giữ approver của phiên.
- Trace `triage`, `confirm` và route bên ngoài graph có cùng thread ID. Headless và TUI đi qua `runGraph`/`ui.confirm` chung.
- `RouteDeps` cho phép test bằng fake workflow khi C5/D1 chưa sẵn sàng. Fake không phải bằng chứng eval thật.

Kiểm: test triage, command, graph và human-gate; `npm run lint`, `npm test`, `npm run build`.

### Bằng chứng trên nhánh `laneA` (chưa nghiệm thu Done)

- Code và test có comment tiếng Việt giải thích ranh giới graph/route, điều kiện hoàn tất không dùng abort, registry phiên và fake workflow seam.
- Chia commit theo phần việc: kết thúc AgentLoop, dispatch route/model, graph và command, test tích hợp CLI/TUI, tài liệu, sửa định danh embedding. PR từ `laneA` dùng để đối chiếu nghiệm thu và xin D xác nhận thay đổi core trước khi merge; chưa đánh dấu Done.
- Đã rebase lên `origin/main` tại `641dece`; giữ cả các dòng quyết định của main và quyết định A2 khi giải quyết conflict tài liệu.
- Lệnh kiểm A2: `npx tsx --test tests/agent-loop-completion.test.ts tests/triage.test.ts tests/triage-command.test.ts tests/triage-graph.test.ts tests/triage-integration.test.ts tests/human-gate.test.ts`: 55 pass, 0 skip. `npm run lint` và `npm run build` pass.
- Full suite sau sửa định danh embedding: 543 test, 530 pass, 13 skip, 0 fail. Máy Windows cần venv Python có pytest và `AXIOM_PYTHON` trỏ tới Python của venv; 13 skip là điều kiện môi trường, gồm 8 test cần Linux/bwrap. Không coi các skip này là bằng chứng sandbox trên Linux.
- Đã sửa `runRoute` theo hợp đồng RAG mới: resolve `embedModelFromConfig` một lần, dùng cùng `ModelInfo` cho `createEmbedder` và `embedIdentity`, như `/ask`. Test kiểm selector thường, alias `@task` và đổi endpoint trong khi selector giữ nguyên; trước sửa có 3 test fail vì route truyền selector/alias thay identity, sau sửa đều pass.
- Bàn giao D: `AgentLoopOptions.isComplete?: () => boolean` được kiểm sau lượt tool và sau kiểm abort; không truyền thì giữ luồng cũ. Test `agent-loop-completion` phủ hoàn tất ngay bước cuối, tiếp tục khi chưa đủ đầu ra và abort được ưu tiên; test TUI chứng minh ticket hợp lệ không phát lỗi giả. Quyết định đã ghi trong `DESIGN.md`, chưa có xác nhận ownership từ D.
- Điều kiện chốt: D xác nhận thay đổi core trên PR có `Closes #7`, mọi CI bắt buộc xanh, cập nhật trạng thái `done` trong PR rồi merge qua `scripts/ship.sh`. Chỉ pull main sau khi merge, không merge trước chỉ để D xem code. Không coi kết quả local hoặc fake workflow là bằng chứng release thật.

## A3. Eval runner chung

Branch `a/a3-eval-runner`. Cần D0 (`evals/types.ts`, `evals/registry.ts`).

Hợp đồng hiện hành: `UcRunner`, `UcResult`, `UcCaseResult` ở `phase-2.md` mục 5.4. Đề xuất cập nhật và kế hoạch từng commit: [a3-eval-contract.md](a3-eval-contract.md).

Nghiệm thu theo issue #8: release thiếu UC-01..05, zero case, thiếu bằng chứng hoặc không đạt gate phải fail; không fallback mock. Recipe cũ bỏ qua runner thiếu và truy cập `mustPass` không có trong result chung không còn phù hợp nghiệm thu.

- Bước 1: ghi đề xuất contract/provenance/gates và xin D0 đồng bộ trước khi đổi API. An đã đồng ý hướng làm; chưa có xác nhận D0.
- Bước 2 có thể làm độc lập: `evals/measure.ts` giữ chữ ký đã công bố (xem mục 2 của đề xuất); test tracker riêng, token/cost/latency và lỗi có redaction.
- Runner UC-01 và CLI/artifact theo contract hiện hành có thể tiếp tục độc lập; xem tiến độ và lệnh kiểm ở mục 7–8 của đề xuất. Chỉ phần bổ sung API gates/provenance chung và sửa CI cần D0 chốt/giao quyền. Không viết runner 02..05 thay chủ làn.
- Mỗi bước code có test và comment tiếng Việt; `npm run lint && npm test` pass trước commit. Full release và partial/mock smoke phải được phân biệt trong artifact và tài liệu.

Chưa đánh dấu `done`, chưa có kết quả eval thật; số đo UC-01 thật thuộc A4.

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
