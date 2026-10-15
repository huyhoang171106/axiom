# Phase 1 — D: Khung chung, CI, router, trace, wire

Đọc: `phase-1.md` (bảng "D0 tạo sẵn"), `tui.md` mục 9 và bước 1–2, `providers.md` mục 6, bước 1, 2, 4, 8–9.

| # | Việc | Đầu ra kiểm được | Trạng thái |
|---|---|---|---|
| D0 | **Làm đầu tiên, nhanh nhất có thể.** Tạo đủ các file trong bảng "D0 tạo sẵn" của `phase-1.md`, chữ ký nguyên văn từ guide | `npm run lint && npm test` pass, `npm start -- --mock "hi"` vẫn chạy; merge vào `main`; báo cả nhóm | done |
| D2 | Điền `parseCommand`, `CommandRouter`, lệnh `help` `clear` `exit`; cờ `-p` headless; `axiom <lệnh>` và `/<lệnh>` gọi cùng `router.get(...).run(...)`; lệnh sai thì gợi ý từ `complete` (`tui.md` bước 1–2) | Test `parseCommand`, `complete`; `npm start -- -p "hi" --mock` và `npm start -- --mock "hi"` đều chạy | done |
| D3 | Điền `startTrace()`: mỗi run một ID; ghi node, tool call (tham số, kết quả, thời gian, `metadata.policy`), token, chi phí; mọi giá trị qua `redact` | `~/.axiom/traces/<runId>.jsonl` + test | todo |
| D4 | Điền 4 wire: `ollama-chat`, `bedrock-converse-stream` (SigV4), `cursor-agent`, `devin-agent` | Test server giả cho cả 4 | 3/4, còn `cursor-agent` |

D chủ trì bước "Ghép" cuối ngày (`phase-1.md`).

Xong khi: trace của run thật không có giá trị key; thử thật ≥ 3 provider dùng wire của D (ollama local tính 1).
