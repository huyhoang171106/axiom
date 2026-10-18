# Phase 1 — C: Target repo, tool, secret, seeded bugs, đăng nhập OAuth code

Đọc: `phase-1.md` (D0, Seam), `providers.md` mục 4.3, 4.4, 11, bước 1, 7.

| # | Việc | Đầu ra kiểm được | Trạng thái |
|---|---|---|---|
| C1 | Làm được khi D0 chưa xong. Chọn và nhập target repo: Python 1k–10k LOC, có pytest, license MIT/BSD (ứng viên `tinydb`, `humanize`; đo `cloc`) | `workspace/<repo>`, tên/commit/license trong README | done |
| C2 | Làm được khi D0 chưa xong. Tool `list_dir`, `search_code` (bọc `rg`, giới hạn kết quả), đăng ký trong `ToolRegistry` | `src/tools/list-dir.ts`, `src/tools/search-code.ts` + test | todo |
| C3 | Điền `src/core/secrets.ts`; `spawn` trong `bash.ts` nhận `env: scrubEnv(process.env)` (giữ `PATH`, `HOME`, `LANG`, `TERM`); bỏ `env`/`printenv` khỏi `READ_ONLY_COMMANDS`; `executeTool` gọi `redact(output)` (bước 1) | Test: `printenv`, `echo $OPENROUTER_API_KEY` không lộ key | todo |
| C4 | Seeded bugs ≥ 5/10 trên target repo: script tạo lỗi + issue mô tả triệu chứng + test giấu ngoài workspace | `evals/issues/bug-01..05/` | todo |
| C5 | Điền engine `oauth-code` (PKCE, `state`, callback chỉ trên `127.0.0.1`, cho dán URL khi không nhận được callback, cổng cố định bận thì báo lỗi) và 9 luồng: `openrouter`, `anthropic`, `openai-codex`, `devin`, `google-gemini-cli`, `google-antigravity`, `gitlab-duo`, `gitlab-duo-agent`, `zai-coding-plan`. Sở hữu `auth/<id>.json` của 9 provider này | Server OAuth giả trên `127.0.0.1`: sai `state` bị từ chối, dán URL chạy được, cổng bận báo lỗi; đăng nhập thật ≥ 1 subscription | todo |

Xong khi: đọc `.env` bị chặn có lý do; không có giá trị key trong output tool; thử thật ≥ 3 luồng đăng nhập của C.
