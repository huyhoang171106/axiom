# Design Doc — Axiom Coding Agent (SE373, Đề tài 01)

Tài liệu thiết kế tổng thể, dùng xuyên 3 phase. Chỉ chứa phần ít thay đổi. Việc cụ thể của từng phase nằm trong `docs/plans/phase-N.md`. Khi có thay đổi lớn, thêm một dòng vào mục 9 "Nhật ký quyết định", không sửa lặng lẽ.

Mục tiêu: **10/10** = 7,5 (5 UC trọn điểm, làm 7 UC để dự phòng) + 2,5 (phần mềm: TUI kiểu Claude Code).

## 1. Quyết định kỹ thuật

| Mục | Quyết định |
|---|---|
| Ngôn ngữ agent | TypeScript (giữ core Axiom sẵn có) |
| Workflow | `@langchain/langgraph` (JS) — `interrupt()` + SQLite checkpointer (từ Phase 2) |
| Model | 91 provider theo `docs/guides/providers.md`, chọn model theo role qua `resolveModel('@role')`; `MockProvider` cho CI/eval tất định |
| Target repo | 1 repo Python 1k–10k LOC có pytest, license MIT/BSD (ứng viên: `tinydb`, `humanize` — đo bằng `cloc` trước khi chốt) |
| Phần mềm | TUI (Ink) giống Claude Code + trang HTML dashboard eval sinh tự động |
| UC nộp | 01, 02, 03, 04, 05, 06, 11 (dự phòng: 09). Bộ 02–06 đã phủ K1–K8 |
| Điểm khác biệt | Oracle escalation (đa mô hình) + spec-driven có ma trận truy vết |

## 2. Kiến trúc: agent = model + harness

```
TUI (Ink) / headless (axiom -p, axiom <lệnh>)
        │  chat tự do ──► agent loop chung (Axiom)
        │  /lệnh      ──► workflow LangGraph.js của UC
        ▼
  triage → route ─┬─► answer (RAG + citation validator)
                  ├─► plan → code → VERIFY → review → gate → report
                  │           ▲        │  bế tắc (repetition-guard) → Oracle
                  │           └─ fix ◄─┘  (≤ 5 vòng; review ≤ 2 vòng)
                  └─► ask_user / reject

Lớp 1 POLICY   : tool registry theo vai trò · allow/ask/deny · chống lách lệnh · audit log
Lớp 2 CONTEXT  : AGENTS.md · skill nạp lười · compaction / handoff · memory dài hạn
Lớp 3 VERIFIER : pytest trong bwrap --unshare-net · test-tamper guard · diff budget
Hạ tầng        : provider router · SQLite checkpointer · trace JSONL + run ID · cost tracker · MCP
```

Code hiện có trong Axiom và vị trí của nó trong kiến trúc:

| Module | Vai trò |
|---|---|
| `src/core/agent-loop.ts`, `repetition-guard.ts` | Agent loop chung, nhận `systemPrompt` và `model` theo role; tín hiệu bế tắc cho Oracle và chống lách lệnh |
| `src/llm/*`, `cost-tracker.ts` | Provider (Anthropic, OpenAI, Mock) + đo token/chi phí |
| `src/tools/permissions.ts` | Policy engine: `decide()` trả allow/ask/deny; Approver trả `approve`, `deny` hoặc `editedArgs` |
| `src/tools/registry.ts` | `ToolRegistry(allowed)` giới hạn tool theo role; mọi tool call qua `executeTool` |
| `src/tools/sandbox.ts` | Sandbox cho `run_command` |
| `src/tools/edit.ts` | Backend ghi file cho `apply_patch` |
| `src/core/state-machine.ts`, checkpoint trong `session.ts` | Sẽ gộp vào LangGraph checkpointer ở Phase 2 — chỉ giữ một cơ chế resume |

## 3. Cách dùng: chat tự do + lệnh cho từng UC

Axiom là coding agent dùng chung, giống Claude Code. Không gõ lệnh thì vẫn chat và code bình thường. Slash command gọi workflow LangGraph của từng UC (có kiểm tra đầu ra, eval và trace riêng).

```
axiom                       # TUI
axiom -p "..."              # headless, dùng cho CI và eval
axiom fix --issue <dir>     # gọi workflow trực tiếp, eval runner dùng đường này
```

| Nhập | Chạy gì | UC | Owner |
|---|---|---|---|
| (chat tự do) | Agent loop chung của Axiom: đọc, tìm, sửa, chạy test, tự nạp skill khi cần | — | E (khung TUI), cả nhóm |
| `/triage <issue>` | Ra IssueTicket, rồi hỏi người dùng có chạy route đề xuất không | UC-01 | A |
| `/ask <câu hỏi>` | RAG trả lời kèm trích dẫn `file:Lx-Ly` | UC-02 | B |
| `/fix <issue>` | Vòng tái hiện → định vị → sửa → test (tối đa 5 vòng) | UC-03 | C |
| `/feature <yêu cầu>` · `/resume [task]` | Spec → plan → code từng bước, có checkpoint | UC-04 | D |
| `/review [diff]` | Reviewer chỉ đọc, xuất ReviewReport | UC-06 | E |
| `/pr` | Mô tả PR + CHANGELOG | UC-09 | A |
| `/mcp` · `axiom mcp serve` | Trạng thái MCP client và chạy server `repo-tools` | UC-11 | B |
| `/plan` · `/mode read-only\|edit` | Plan mode (chỉ có tool đọc) và mức quyền | UC-05 | E |
| `/model` · `/cost` | Đổi model, xem token và chi phí | — | A |
| `/memory` · `/compact` · `/tree` · `/undo` | Xem/xoá memory, nén context, cây phiên, quay lại checkpoint | UC-04 | D |
| `/audit` · `/skills` · `/help` | Audit log duyệt/từ chối, danh sách skill, trợ giúp | UC-05 | E (`/audit`), A (`/skills`), D (`/help`) |

Ràng buộc:
- Chat tự do và slash command **dùng chung** tool registry, policy engine, trace và verifier. Không có đường nào đi vòng qua policy. Chat tự do không có ngoại lệ nào ở UC-05: hành động rủi ro vẫn phải dừng chờ duyệt.
- Sau mỗi lần sửa file, harness tự chạy test, LLM không được bỏ qua bước này.
- Mỗi slash command gọi cùng một hàm với `axiom <lệnh>` dùng trong eval, nên TUI và eval không chạy hai bản code khác nhau.

### 3.1. Connectors (GitHub, ...) — Phase 3, owner B (khung) + A (lệnh GitHub)

Connector là một MCP server bên ngoài do Axiom kết nối tới (MCP client). Khung này dùng chung với UC-11.

| Nhập | Chạy gì |
|---|---|
| `/connectors` | Liệt kê connector và trạng thái (đã kết nối / chưa / lỗi) |
| `/connect github` · `/disconnect github` | Kết nối qua `gh auth token` hoặc PAT người dùng dán vào. Token lưu ở `~/.axiom/credentials.json` (quyền 0600), không bao giờ nằm trong repo |
| `/issue <url\|#n>` | Lấy issue từ GitHub rồi chạy `/triage` |
| `/pr create` | Dùng nội dung UC-09, tạo branch, push, mở PR. **Phải duyệt**; cấm push vào nhánh chính |
| `/review --pr <n>` | Review PR, đăng comment lên GitHub. **Phải duyệt** vì đây là thao tác công khai |

Quy tắc:
- Mỗi lệnh khai báo connector cần dùng, ví dụ `requires: ['github']`. Bộ phân giải lệnh kiểm tra trước khi chạy. Nếu chưa kết nối, TUI hiện "Cần kết nối GitHub. Kết nối ngay? [Y/n]" và chạy luồng `/connect` rồi quay lại lệnh đang gõ.
- Đã kết nối thì lần chạy sau tự kết nối lại khi khởi động. Không gõ lệnh nào thì không kết nối.
- Ở chế độ chat tự do, tool của connector chỉ được nạp vào context khi connector đã kết nối. Chưa kết nối thì LLM không thấy tool đó.
- Token không bao giờ vào context của LLM hay trace. Ghi trace phải che token (redact).
- Mọi thao tác ghi ra ngoài (tạo PR, comment, push) đi qua policy engine với mức `ask` và ghi vào audit log.
- Headless (`axiom -p`) mà thiếu kết nối thì báo lỗi rõ ràng, không hỏi.

## 4. Chủ sở hữu (5 SV)

| SV | UC sở hữu | Harness phụ trách | Phần mềm (TUI) phụ trách |
|---|---|---|---|
| A | UC-01 Triage, UC-09 PR notes (dự phòng) | Structured output (zod), schema retry, gán model theo role cho từng UC, skill loader, nạp `AGENTS.md` target repo, eval runner, đăng nhập kiểu hook, connector GitHub | `/triage` (Phase 2: renderer IssueTicket) |
| B | UC-02 RAG, UC-11 MCP | Provider, credentials, model resolver (`docs/guides/providers.md`), index tree-sitter + BM25 + embedding, citation validator, MCP server, khung connector | `/login` `/logout` `/model`, hiển thị trích dẫn bấm được, `/ask`, `/connect` |
| C | UC-03 Bug fix | Bảo vệ secret, `list_dir`/`search_code`, đăng nhập OAuth code, `apply_patch`, Verifier, test-tamper guard, Oracle, bộ seeded bugs | Diff viewer tô màu, tiến trình từng vòng fix |
| D | UC-04 Multi-step + resume | Khung chung (stub, file dùng chung), bộ lệnh (`CommandRouter`, headless `-p`), trace JSONL + run ID, CI, checkpointer, compaction/handoff, memory | `/resume` `/memory` `/tree` `/cost` |
| E | UC-05 HITL, UC-06 Reviewer | Audit log, Reviewer read-only (policy engine allow/ask/deny đã có), wire họ Google | Khung TUI (Ink), màn hình duyệt, footer + telemetry, panel review |

Mỗi người viết `docs/uc-XX.md` cho UC của mình (thiết kế, failure mode, kết quả eval) — dùng luôn khi vấn đáp (điểm cá nhân = điểm nhóm × hệ số vấn đáp).

## 5. Phủ kiến thức K1–K8

| Mảng | UC nộp phủ |
|---|---|
| K1 Model, structured output, agent loop | 01, 03 |
| K2 Tool use, skills | 03 |
| K3 RAG | 02 |
| K4 Memory, state, context | 04 |
| K5 Workflow, human-in-the-loop | 01, 04, 05 |
| K6 Multi-agent / MCP | 06, 11 |
| K7 Verification, evaluation | 03, 06 |
| K8 Security, observability | 05, 11 |

## 6. Lộ trình

| Phase | Thời gian (slide) | Yêu cầu của lớp | Mục tiêu nhóm | Tag | Plan |
|---|---|---|---|---|---|
| 1 Bootstrap | 07/10–27/10 (làm bù trong ngày 28/10, một mốc) | Repo + CI, agent loop ≥ 2 tool, 1 skill, log từng bước, 1 UC chạy từ app tới agent, ≥ 10 eval case | UC-01 + TUI chat + `/triage` | `v0.1-phase1` | `plans/phase-1.md` |
| 2 Mở rộng | 28/10–10/11 | RAG có trích dẫn, resume + nén context, LangGraph có bước duyệt, ≥ 3 UC | UC-01..05 chạy được | `v0.2-phase2` | `plans/phase-2.md` |
| 3 Hoàn thiện | 11/11–06/12 | Eval chạy 2 lần, multi-agent/MCP, kiểm thử an toàn, ≥ 5 UC phủ K1–K8, báo cáo, video | 7 UC, connectors, Oracle, spec-driven, ablation | `v1.0` | `plans/phase-3.md` |

Việc dự kiến cho Phase 2–3 (chi tiết hoá vào `plans/phase-N.md` khi phase bắt đầu):

- **Phase 2** — A: graph `triage → route`, model router · B: UC-02 RAG, Recall@5 ≥ 0,8 · C: UC-03 `apply_patch` + Verifier + đủ 10 seeded bugs, ≥ 40% · D: UC-04 task state + checkpointer + compaction + memory · E: UC-05 `interrupt()` + audit + màn hình duyệt đủ y/n/e.
- **Phase 3** — E: UC-06 Reviewer ≥ 70% · B: UC-11 MCP + khung connector · C: Oracle (3 cấu hình) · D: spec-driven + eval 2 lần + ablation · A: UC-09, connector GitHub, dashboard HTML · mỗi SV 1 case tấn công §4.3 · cả nhóm: báo cáo, video ≤ 15 phút, tập vấn đáp chéo.

Quy tắc của lớp: mỗi phase chỉ dùng kiến thức đã học đến thời điểm đó → MCP, multi-agent, connectors chỉ làm ở Phase 3.

## 7. Rủi ro chính

| Rủi ro | Giảm thiểu |
|---|---|
| Phase 1 trễ hạn | Làm bù trong 28/10, 5 làn độc lập; D0 tạo stub đầu ngày nên không ai chờ ai |
| UC-03 dưới 40% | Oracle + error memory; giữ UC-09 làm dự phòng điểm |
| Lộ API key (−1,0) | `.env` trong `.gitignore` (chưa có, task D1), `gitleaks` trong CI, chỉ commit `.env.example`, `scrubEnv` + `redact` (task C1) |
| Dùng kiến thức chưa học | MCP/multi-agent chỉ làm ở Phase 3 |

## 8. Quy ước tài liệu

- `docs/DESIGN.md` (file này): phần ít đổi. Không đặt tên `AGENTS.md` — tên đó dành cho file hướng dẫn agent theo đề §7, agent sẽ nạp nhầm bản thiết kế.
- `docs/plans/phase-N.md`: tổng quan, seam, tiêu chí xong. Mỗi file khớp với một tag trên repo. `docs/plans/phase-N-{A,B,C,D,E}.md`: task, hạn, trạng thái của từng người. Việc đã xong không ghi lại thành task.
- `docs/CONVENTIONS.md`: quy ước code, đặt tên, git, cách viết.
- `docs/guides/*.md`: quy tắc bắt buộc cho từng phần, người làm sau phải tuân theo. `providers.md` (kết nối provider, học từ oh-my-pi), `tui.md` (giao diện, học từ pi-open-tui).
- `docs/uc-XX.md`: thiết kế và kết quả của từng UC.

## 9. Nhật ký quyết định

| Ngày | Quyết định | Lý do |
|---|---|---|
| 2026-10-28 | Giữ TypeScript, dùng LangGraph.js | Core Axiom đã có ~40% harness; đề cho phép TS |
| 2026-10-28 | Chat tự do + slash command theo UC, dùng chung harness | Trải nghiệm như Claude Code nhưng mỗi UC vẫn có workflow và eval riêng |
| 2026-10-28 | Connectors qua MCP, phải `/connect` trước khi dùng | Token không vào context LLM; MCP thuộc kiến thức Phase 3 |
| 2026-10-28 | Xong Phase 1 phải là bản dùng được hằng ngày | Nhóm tự dùng Axiom để phát triển các phase sau |
| 2026-10-28 | Provider theo thiết kế oh-my-pi, TUI theo bố cục pi-open-tui (dựng lại bằng Ink) | Chỉ học thiết kế, không chép code |
| 2026-10-28 | Danh sách provider giống oh-my-pi (91 ID), có cả subscription OAuth (Claude Pro/Max, ChatGPT Plus/Pro, Copilot, Gemini, …) | Dùng gói subscription của provider để gọi model. Rủi ro: provider có thể chặn client hoặc khoá tài khoản → eval và demo dùng API key |
| 2026-10-28 | Làm toàn bộ provider (87/91), mọi luồng đăng nhập và 12 wire mới ngay trong Phase 1 | Yêu cầu của nhóm: xong Phase 1 là dùng được với mọi provider |
| 2026-10-28 | ~~Phase 1 chia 3 mốc: M1 nền chung (29/10), M2 nộp lớp `v0.1-phase1` (30/10), M3 đủ provider `v0.1.1` (03/11). Wire của M3 chia cho cả 5 người~~ (đã thay bằng 2 dòng dưới) | Provider đầy đủ không làm kịp trong 3 ngày nếu chỉ B làm; M3 lấn 1 tuần đầu Phase 2 |
| 2026-10-28 | ~~Nhóm còn 4 SV (A–D).~~ (sai, nhóm 5 SV — xem dòng cuối) Phase 1 chia 4 làn độc lập, giao tiếp qua seam có hợp đồng ngày 0 và bản giả. Việc của E ở Phase 1: TUI, bộ lệnh → D; loader `AGENTS.md` → C; wire `cursor`/`devin` → D, `factory`/`gitlab-duo` → A. Chủ sở hữu UC-05, UC-06 cho Phase 2–3 quyết định sau | Không ai phải chờ người khác; mục 4 (chủ sở hữu) cập nhật khi chốt Phase 2 |
| 2026-10-28 | Gộp M1–M3 thành một mốc, làm xong trong ngày 28/10, một tag `v0.1-phase1`. Phân công mỗi người một file `plans/phase-1-{A,B,C,D}.md` | Yêu cầu của nhóm. Rủi ro: đăng nhập thật subscription có thể không xong trong ngày |
| 2026-10-28 | Thêm `docs/CONVENTIONS.md` (đặt tên, cấu trúc, chiều import, git, test, cách viết) | Cả nhóm và agent của họ viết cùng một kiểu |
| 2026-10-28 | D0 tạo mọi file dùng chung và stub ở đầu ngày (`package.json`, `types.ts`, `cli/index.ts`, `prompt.ts`, lệnh, `WIRES`, wire stub, eval stub, CI). Người khác chỉ điền thân file của mình | Tránh nhiều người cùng sửa một file và tránh việc không ai nối tính năng vào điểm vào |
| 2026-10-28 | Nhóm 5 SV (A–E). Phase 1: 5 làn chạy một mạch, đồng bộ duy nhất là D0. E giữ TUI, màn hình duyệt, footer (như mục 4 ban đầu); D giữ khung chung, router, trace, CI; C bỏ trace, giữ OAuth. Catalog ở `src/llm/catalog/index.ts`, import `catalog/index.js` (sửa chỗ `tui.md` mục 9 ghi `catalog.js`) | Sửa thông tin số người; không ai phải chờ |
| 2026-10-28 | D0 thêm `createAgent` (headless và TUI dùng chung), `LOGIN_ENGINES` (mỗi kiểu đăng nhập một file), stub `resolveModel` giữ hành vi cũ; triage dùng tool bắt buộc thay cho `response_format`; thêm `CLAUDE.md` nạp `AGENTS.md` | Bỏ các chỗ hai làn sửa cùng file và chỗ chưa ai nối resolver vào luồng chat |
| 2026-10-28 | Bắt buộc mọi thay đổi đi qua branch → PR → tác giả tự merge khi CI xanh; không commit thẳng `main` | Không ai chờ người review; `main` luôn qua CI |
| 2026-10-28 | CI/CD: `ci` (lint, test, eval, gitleaks), `pr-title`, `release` theo tag, Dependabot; `main` bảo vệ, chỉ squash merge, auto-merge khi xanh, xoá branch sau merge | Tự merge mà vẫn không phá `main`; tiêu đề PR thành commit đúng quy ước |
| 2026-10-28 | Cân bằng A, B, C, E (D giữ nguyên): mỗi engine đăng nhập một chủ (`hook` A, `api-key`/`cloud-fields`/`device-code` B, `oauth-code` C), refresh chung về B; wire Google sang E; nạp `AGENTS.md` target repo sang A | Độ khó kỹ thuật 4 người ngang nhau; mỗi engine và file `auth/<id>.json` chỉ một người sửa |
| 2026-10-28 | Lane A chuyển sang nhánh tích hợp `lane/A`, mỗi task một commit, không auto-merge PR vào `main` từng task nữa; `main` giữ nguyên các commit A1–A4 đã merge trước đó | Yêu cầu của A: gộp code lane A trên một nhánh riêng để xem xét trước khi lên `main` |
| 2026-10-29 | Auth JSON của hook dùng `"login.type": "hook"`; dòng `custom` ở `providers.md` mục 7.1 là stale | Khớp `LoginType` của D0 và task A7; không phải sửa type dùng chung |
| 2026-10-29 | Code và test của A7 viết comment tiếng Việt | Yêu cầu của A; ngoại lệ `CONVENTIONS.md` mục 7, chỉ áp dụng các file A7 |
| 2026-10-29 | Hook refresh nhận `refresh(cred, provider)` thay vì `refresh(cred)` ở `providers.md` mục 7.4 | Cần endpoint và clientId từ auth JSON; không hardcode URL/clientId trong TypeScript |
| 2026-10-29 | `openai-codex-device` đặt `login.storeAs: "openai-codex"`; B3 đọc field này khi lưu | Device và browser login dùng chung một credential, mỗi provider chỉ có một tài khoản |
| 2026-10-28 | `Credential` loại `oauth` thêm 2 trường tuỳ chọn `headers` và `baseUrl` (`src/llm/auth/engines/index.ts`); `createProviderFor` gộp chúng vào `ModelInfo` | Đăng nhập Factory trả org ID (header `X-Factory-Org-Id`) và host EU theo tài khoản; hợp đồng cũ không có chỗ lưu. Thêm trường tuỳ chọn nên code cũ không phải sửa |
| 2026-10-28 | Đổi squash merge sang merge commit (cả Dependabot); tiêu đề merge commit lấy theo tiêu đề PR | Giữ đủ lịch sử commit của từng branch trên `main`; mọi commit trong branch giờ cũng phải đúng `type(scope): subject` |
| 2026-10-29 | Bỏ yêu cầu thử đăng nhập/gọi provider thật khỏi tiêu chí xong của Phase 1 (task A7, B3, B5, C5, "Xong khi" của mọi làn, `phase-1.md`); test server giả là đủ. A7 đánh dấu `done` | Yêu cầu của nhóm: thiếu key/tài khoản để thử thật, không chặn việc đóng Phase 1 |
| 2026-10-30 | Các mục của `phase-1.md` cần model/provider thật (`/login` → chat, 87 provider chạy được, `/triage` và chat trong TUI, ngưỡng `type` ≥ 80% của eval UC-01) coi là đạt khi phần code có test server giả hoặc mock; eval UC-01 chỉ chạy mock (pipeline + schema), số đo thật dời sang Phase 2 | Yêu cầu của nhóm: không có key để chạy thật; mock không đo được độ chính xác nên không ghi số giả |
| 2026-11-03 | Phase 2: duyệt từng tool call vẫn qua `gate()` → `approver` (Promise); `interrupt()` của LangGraph chỉ dùng cho cổng người dùng giữa các node (`askHuman`: chạy route, duyệt kế hoạch, giữ bản sửa) | Resume sau `interrupt()` chạy lại cả node; node chứa `AgentLoop` sẽ chạy lại các tool đã chạy, trái UC-05 tiêu chí 3 |
| 2026-11-03 | Thêm `@langchain/langgraph`, `@langchain/core`, `@langchain/langgraph-checkpoint-sqlite` (`SqliteSaver`, file `~/.axiom/checkpoints.db`) | Checkpointer chính thức, có binary sẵn cho Linux/Windows/macOS; dự phòng: saver tự viết trên `node:sqlite` |
| 2026-11-03 | Chunk code Python bằng module `ast` của Python (subprocess `python -I`) thay cho tree-sitter | Target repo là Python, máy đã có Python cho pytest; không thêm dependency native/wasm; đề cho phép AST |
| 2026-11-03 | Embedding qua role `@embed` (bắt buộc đặt trong config, không fallback); wire `ollama-chat` gọi `/api/embed`, còn lại `/embeddings` kiểu OpenAI; vector lưu JSON, cosine duyệt hết; BM25 tự viết | Repo vài trăm chunk, không cần vector DB; không hardcode model |
| 2026-11-03 | Một cơ chế resume: LangGraph checkpointer. Checkpoint của `session.ts` chỉ giữ `filesSnapshot` cho `/undo`, bỏ `stateSnapshot` | `DESIGN.md` mục 2 yêu cầu chỉ giữ một cơ chế resume |
| 2026-11-03 | `decide()` trả `ask` cho tool không có trong danh mục (trước đây `allow`) | UC-05: hành động chưa phân loại không được chạy im lặng |
| 2026-11-04 | Repo chuyển sang `se373agenticengineering/nhom-30`. Không có auto-merge và bảo vệ `main` (gói miễn phí, repo private, nhóm không có quyền admin), nên tác giả (người hoặc agent) chạy `scripts/ship.sh`: đợi mọi check xanh rồi tự merge; check đỏ thì không merge. Job `secrets` dùng gitleaks CLI thay cho action | `gitleaks-action` đòi license với repo của organization; giữ quy tắc "chỉ merge khi CI xanh" bằng script thay cho cài đặt GitHub |
| 2026-11-04 | `ExecutionContext` cấp phiên (`src/core/execution-context.ts`): `tools` (registry phiên giữ approver, `allowWithoutApprover`, sau này mode và danh sách từ chối), `bus` (có trace), `costTracker`, `runId`. TUI tạo ở lần nhập đầu, headless tạo trước khi chạy; `CommandContext` và `RouteContext` kế thừa nó. Node workflow dùng `ctx.tools.scoped([...])`, không `new ToolRegistry`. `CommandUI` chuyển sang `core/execution-context.ts` (`commands/types.ts` export lại) | Lệnh slash đầu tiên phải có approver, trace, tracker mà không cần chat trước; approver và từ chối dùng chung giữa các node; `agents` không import ngược `commands` |
| 2026-11-04 | `scoped()` chỉ thu hẹp: tool = giao của danh sách xin và registry phiên; approver và `allowWithoutApprover` đọc từ registry phiên lúc gọi, không chép | Đổi mode hoặc cài approver sau khi tạo view vẫn có hiệu lực; node không tự mở rộng quyền |
| 2026-11-04 | `askHuman`, `runGraph` có thân thật từ D0 (chuyển từ E3). Câu hỏi yes/no đi qua `ui.confirm`, lựa chọn khác qua `ui.ask`; câu trả lời không hợp lệ thành lựa chọn cuối. E3 thêm hỏi lại và nối TUI | D1, A2 cần test trả lời `no` ngay sprint 1–2 |
| 2026-11-04 | `/triage` chỉ có graph `triage → confirm`; `runRoute` chạy sau graph, ngoài mọi graph (#7) | `interrupt()` của graph con thoát lên graph cha; resume chạy lại node `route` và lặp lại sửa đổi |
| 2026-11-04 | Headless `--yes`: `ui.confirm` trả yes, registry đặt `allowWithoutApprover`; `deny` của policy vẫn chặn. Không có `--yes` và không TTY: confirm trả no, `ask` bị từ chối | Một luồng chính sách cho chat và lệnh; không viết `headlessApprover` riêng |
| 2026-11-04 | `executeTool` coi output bắt đầu bằng `Error` là lỗi (`isError: true`, `success: false`) | Tool trả chuỗi lỗi thay vì throw từng được tính là thành công |
| 2026-11-04 | `pythonBin()` ở `src/core/paths.ts`: `AXIOM_PYTHON`, rồi `python3` (Windows: `python`). B1, C1, C3 dùng chung | Ba chỗ từng mặc định khác nhau; máy dev chỉ có `python3` |
| 2026-11-04 | Phase 2 bỏ `/mode auto`, chỉ còn `read-only\|edit` (#35). `/cost` chuyển sang A1 (#6) | Đề UC-05 bắt duyệt mọi hành động mà `auto` sẽ tự cho chạy; giảm tải làn D |
| 2026-11-04 | Máy eval chung: máy của D (Ubuntu 24.04, Python 3.12.3, pytest 9.1.1, bwrap 0.9.0), D vận hành. Eval thật của mọi UC chạy trên máy này; cách dựng ở `plans/phase-2.md` mục 10 | P2-R0 (#38): một máy, một cấu hình, số đo so sánh được giữa các UC |
| 2026-11-04 | Model chat cho eval thật: provider `anthropic` (đăng nhập OAuth Claude Pro/Max), `@default` = `anthropic/claude-opus-5-5`. Thay vế "eval và demo dùng API key" của dòng 2026-10-28 | P2-R0 (#38): nhóm không còn API key dùng được (tài khoản Fireworks bị khoá vì billing). Rủi ro khoá tài khoản vẫn còn; nếu bị khoá, D báo trong ngày và đổi `@default` |
| 2026-11-04 | Embedding cho eval thật: `modelRoles.embed = "ollama/qwen3-embedding:0.6b"` (1024 chiều), Ollama chạy bằng Docker, chỉ nghe `127.0.0.1:11434`. Provider `ollama` trong catalog dùng wire `openai-completions`, nên B2 gọi `POST <baseUrl>/embeddings` | P2-R0 (#38): Anthropic không có API embedding, Fireworks bị khoá, các provider còn lại không có model embedding. Chạy local, không tốn tiền |
| 2026-11-04 | Code do An yêu cầu dùng comment tiếng Việt giải thích cách hoạt động; tên API giữ theo contract hiện hành | Ngoại lệ quy ước comment tiếng Anh theo yêu cầu của An, giúp đọc và bảo trì |
| 2026-11-04 | A1 bổ sung `promptTokens` và `completionTokens` cho từng model trong `ModelUsageSummary`; `/cost` đọc tracker phiên. Budget của `AgentLoop.runTask` tính trên usage riêng của lần gọi, không giới hạn chung nhiều node | Giữ tổng phiên và tránh lẫn chi phí các run đồng thời; cost vẫn là ước tính theo tracker |
| 2026-11-04 | Sandbox của pytest phải che file host, không chỉ tắt mạng: `bwrapInvocation` thêm `readableRoots` (C3, `plans/phase-2-C.md`) | P2-R0 (#38) đo: `--ro-bind / /` hiện tại cho test đọc `~/.ssh` và `~/.axiom/config.json`. Đề mục 4.1 cấm đọc ngoài workspace; mục 4.3 có case test cố đọc `~/.ssh` |
| 2026-11-04 | Hợp đồng RAG thêm tham số tuỳ chọn: `chunkRepo(root, opts?: { python })`, `embedderFromConfig(config, opts?: { costTracker })`, `RepoIndex.open(..., opts?: { dir, embedModel, python })`, `AskOptions.embedModel`, `AskOptions.indexDir`. Index cũng dựng lại khi số chiều vector đổi | `meta.embedModel` (B2) cần biết tên model embed mà `Embedder` không mang; eval giữ index trong `workDir` thay vì `~/.axiom/index`. Tham số tuỳ chọn nên code cũ không phải sửa |
| 2026-11-04 | Kho tri thức RAG có nguồn thứ hai `team`: quy ước code của nhóm (đề mục 2.3) ở `knowledge/` của Axiom (`TEAM_DOCS_DIR`). `Chunk` và `Citation` thêm field tuỳ chọn `source?: 'repo' \| 'team'` (thiếu = `repo`); `path` luôn tương đối với gốc của nguồn, không gắn tiền tố; id chunk team có tiền tố `team:`. `RepoIndex.open` thêm `opts.teamDir` (#11) | Issue B1: nguồn tài liệu ngoài target repo phải có định danh riêng, không nhét tiền tố vào `path` rồi để validator hiểu là đường dẫn workspace |
| 2026-11-04 | Định danh index = `embedIdentity(info)` (`provider\|api\|baseUrl\|id`, giữ nguyên tag) + `PREPROCESSING_VERSION` + số chiều; khác một phần là index lại toàn bộ. `RepoIndex.open` vẫn nhận `opts.embedModel`, giờ là chuỗi định danh này. Thêm `embedModelFromConfig(config)`. `createEmbedder` từ chối vector khác chiều, rỗng hoặc có NaN/Infinity; lỗi 400/404/422/501 kèm gợi ý kiểm `modelRoles.embed`. Smoke thật: `npx tsx scripts/smoke-embed.ts [provider/model]`; model Ollama mới phải chạy `axiom models refresh` trước (#12) | Issue B2: đổi endpoint, provider hoặc cách chunk mà giữ vector cũ thì điểm cosine vô nghĩa; chỉ so tên selector là không đủ |
| 2026-11-04 | Index RAG lưu trong một file `index.json` (`meta`, `files`, `chunks`, `vectors`), publish bằng ghi file tạm + `fsync` + một `rename`. Lúc mở, zod parse rồi kiểm nhất quán (mỗi chunk có hash file và vector đúng chiều, không vector thừa, không trùng id); sai thì bỏ cả index và dựng lại. Bốn file cũ (`chunks.json`, `vectors.json`, `files.json`, `meta.json`) bị xoá khi publish (#13) | Issue B3: bốn `rename` riêng không phải transaction, tắt giữa chừng để lại index trộn hai thế hệ. Một file một `rename` là nguyên tử trên cùng ổ đĩa; index vài trăm chunk nên ghi lại cả file vẫn nhanh |
| 2026-11-04 | Trích dẫn UC-02 chặt hơn: khoảng dòng phải nằm trọn trong một chunk đã truy xuất cùng nguồn (lý do `'not inside a retrieved chunk'`, thay `'not from retrieved context'`), và `checkSupport` đòi câu chứa trích dẫn có chung ít nhất một từ với dòng được trích hoặc symbol của chunk. Retry vẫn sai thì xoá trích dẫn sai khỏi `text`, dòng không còn trích dẫn hợp lệ thì xoá cả dòng. Nguồn `team` đi qua parser (`team:<path>:Lx-Ly`), `validateCitation(..., teamDir?)`, `fileLink(..., teamDir?)` (mặc định `TEAM_DOCS_DIR`) và `AskOptions.teamDir`; `/ask` truyền `TEAM_DOCS_DIR` (#14) | Issue B4: overlap một phần chunk không chứng minh nội dung; đề UC-02 tiêu chí 1 đòi đoạn trích chứa symbol hoặc nội dung liên quan; trích dẫn sai không được nằm trong câu trả lời hiển thị |
| 2026-11-05 | Hợp đồng C2 thêm tham số tuỳ chọn: `applyHunks(..., filePath?)`, `PatchConflict.actualRange`, `findTestTampering(..., opts?: TestGuardOptions)`, hàm mới `findChangeTampering`, và `constructor(guard?: TestGuardOptions)` cho `ApplyPatchTool`, `EditTool`, `WriteTool`. Guard chặn sửa test chạy trong cả 3 tool ghi, bật mặc định ở mọi registry; ngoại lệ `allowedTests` chỉ đặt qua constructor (#17) | Issue C2: guard phải phủ mọi đường ghi và model không được tự cấp quyền. `registry.ts` thuộc E nên C2 nối guard ngay tại điểm ghi của từng tool; hook chung ở registry để E2 (#32) làm |
| 2026-11-05 | E2 giữ `actionKey(...): string` cho caller cũ; thêm `actionKeys(...): string[]` cho gate và `workspaceRoot` tuỳ chọn (mặc định cwd) cho cả hai và `normalizeCommand`. Denial nằm tại registry gốc của session, scoped dùng chung, không xoá qua `/clear` hoặc thay view/mode; session mới độc lập. Mutation keys dùng chung tài nguyên canonical giữa shell và các tool ghi; đọc có identity riêng. Khi đã có denial, command không chứng minh được identity an toàn bị chặn trước approver. | Quyết định triển khai thuộc E do người thực hiện E2 uỷ quyền; ưu tiên nghiệm thu #32 thay recipe `/clear` cũ. Không đổi kiểu trả về seam D0, không nhận là D0 phê duyệt thay đổi API chung. Denial trong bộ nhớ phiên hiện tại, chưa persist qua restart. |
