# Phase 1 — A: UC-01 Triage, eval, prompt, wire họ OpenAI, đăng nhập kiểu hook

Đọc: `phase-1.md` (D0, Seam), đề bài `2026-10-06_de_tai_01_coding_agent.md` mục UC-01 (schema IssueTicket), `providers.md` mục 4.3, 4.4, 6, 9, bước 7–8.

| # | Việc | Đầu ra kiểm được | Trạng thái |
|---|---|---|---|
| A1 | Làm được khi D0 chưa xong. 10 eval case: 3 bug (có stack trace), 2 feature, 1 refactor, 1 mơ hồ, 1 không liên quan code, 1 question, 1 injection. Skill `issue-triage` đủ contract (metadata, khi dùng, I/O, bước, ràng buộc, ví dụ, final check), không chứa script | `evals/uc01/*.json` (input + expected `type`/`route`), `skills/issue-triage/SKILL.md` | done |
| A2 | Điền 2 phần của prompt: `skillsIndex()` (prompt chỉ có tên + mô tả + đường dẫn skill, agent tự `read_file` khi cần) và `loadProjectRules(workspaceRoot)` (đọc `AGENTS.md` của target repo, không có thì trả `''`) | `src/core/skills.ts`, `src/core/project-rules.ts` + test (thư mục tạm) | done |
| A3 | `IssueTicket` bằng zod, đúng trường trong đề; structured output bằng một tool bắt buộc `submit_issue_ticket` có JSON schema sinh từ zod (provider hiện chưa có `response_format`, không sửa provider); parse bằng zod, sai thì gửi lỗi lại cho model, tối đa 2 lần; validator `affected_files` (loại file không tồn tại + cảnh báo); `missing_info` ≠ rỗng → `ask_user` kèm câu hỏi cụ thể. `ToolRegistry(['read_file', 'search_code'])`. Nhận `provider` qua tham số để test bằng `MockProvider` | `src/agents/triage.ts`, test validator (thư mục tạm) | done |
| A4 | Điền `evals/run.ts`: `npm run eval -- --uc 01` xuất `results.json` (accuracy `type`, route, tỉ lệ hợp lệ schema); mỗi case một `CostTracker` mới; không có key thì chạy mock | CI chạy eval xanh | done |
| A5 | Điền `src/commands/triage.ts`: `text` là IssueTicket đã định dạng; model qua `resolveModel('@smol')` | `/triage` và `axiom triage` chạy được | done |
| A6 | Điền 5 wire: `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `factory-droid-agent`, `gitlab-duo-agent` | Test server giả cho cả 5 | done |
| A7 | Điền engine `hook` trong `LOGIN_ENGINES` và 3 luồng đăng nhập riêng của nó (mục 4.4): `openai-codex-device` (device, lưu dưới `openai-codex`), `github-copilot` (hỏi domain, device), `cursor` (poll). Sở hữu file `src/llm/catalog/auth/<id>.json` của 3 provider này | Server giả trên `127.0.0.1`: `slow_down` tăng thời gian chờ, hết hạn thì dừng và báo; đăng nhập thật ≥ 1 | todo |

Xong khi: eval `type` ≥ 80%, 100% hợp lệ schema, case injection không đổi hành vi; issue mơ hồ → hỏi lại; thử thật ≥ 3 provider dùng wire của A.
