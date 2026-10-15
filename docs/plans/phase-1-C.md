# Phase 1 — C: Target repo, secret, tool, seeded bugs, OAuth

Đọc: `phase-1.md` (D0, Seam), `providers.md` mục 4.3, 4.4, 11, bước 1, 7.

| # | Việc | Đầu ra kiểm được | Trạng thái |
|---|---|---|---|
| C1 | Chọn và nhập target repo: Python 1k–10k LOC, có pytest, license MIT/BSD (ứng viên `tinydb`, `humanize`; đo `cloc`). Làm được khi D0 chưa xong | `workspace/<repo>`, tên/commit/license trong README | todo |
| C2 | Làm được khi D0 chưa xong. Tool `list_dir`, `search_code` (bọc `rg`, giới hạn kết quả), đăng ký trong `ToolRegistry` | `src/tools/list-dir.ts`, `src/tools/search-code.ts` + test | todo |
| C3 | Điền `src/core/secrets.ts`; `spawn` trong `bash.ts` nhận `env: scrubEnv(process.env)` (giữ `PATH`, `HOME`, `LANG`, `TERM`); bỏ `env`/`printenv` khỏi `READ_ONLY_COMMANDS`; `executeTool` gọi `redact(output)` (bước 1) | Test: `printenv`, `echo $OPENROUTER_API_KEY` không lộ key | todo |
| C4 | Seeded bugs ≥ 5/10 trên target repo: script tạo lỗi + issue mô tả triệu chứng + test giấu ngoài workspace | `evals/issues/bug-01..05/` | todo |
| C5 | Điền `loadProjectRules(workspaceRoot)`: đọc `AGENTS.md` của target repo | `src/core/project-rules.ts` + test | todo |
| C6 | Điền engine `oauth-code`, `device-code`, `hook` trong `LOGIN_ENGINES` (stub D0) và `refresh.ts` (mục 4.3); rồi 15 luồng subscription mục 4.4 theo thứ tự `openrouter` → `anthropic` → `openai-codex` → `github-copilot` → `google-gemini-cli` → còn lại; đăng nhập `cursor`, `devin`, `factory-droid`, `gitlab-duo-agent` | Server OAuth giả trên `127.0.0.1`: sai `state` bị từ chối, `slow_down` tăng thời gian chờ, refresh lỗi thì xoá credential, cổng bận thì báo lỗi; đăng nhập thật ≥ 1 subscription | todo |

Xong khi: đọc `.env` bị chặn có lý do; không có giá trị key trong output tool; thử thật ≥ 3 luồng subscription.
