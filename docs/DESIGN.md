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
| `/plan` · `/mode read-only\|edit\|auto` | Plan mode (chỉ có tool đọc) và mức quyền | UC-05 | E |
| `/model` · `/cost` | Đổi model, xem token và chi phí | — | A, D |
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
