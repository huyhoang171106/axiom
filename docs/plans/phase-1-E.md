# Phase 1 — E: TUI, màn hình duyệt, footer, wire họ Google

Đọc: `phase-1.md` (D0, Seam), **toàn bộ** `tui.md` (mục 10, bước 3–8), `providers.md` mục 4.5, 6, bước 8–9. Không thêm thư viện TUI nào ngoài Ink.

| # | Việc | Đầu ra kiểm được | Trạng thái |
|---|---|---|---|
| E1 | Làm được khi D0 chưa xong (chỉ dùng `EventBus` có sẵn). Store (bước 4): `attach(bus)`, gộp `stream_token`, vẽ lại ≤ 30 lần/giây, `getSnapshot()` giữ nguyên object khi state không đổi | `src/tui/store.ts` + test | done |
| E2 | Theme và layout, hàm thuần (bước 3): đo bằng `string-width`, `NO_COLOR` tắt màu, cắt `left` theo `priority`. | `src/tui/theme.ts`, `src/tui/layout.ts` + test | done |
| E3 | Component (bước 5): header, transcript (lượt xong trong `<Static>`), dòng tool call thu gọn/mở, ô nhập nhiều dòng (`Enter` gửi, `Alt+Enter` và `\` + `Enter` xuống dòng) | `src/tui/components/` | done |
| E4 | Điền `startTui(argv)` (bước 5–7): tạo agent qua `createAgent`, gọi lệnh qua `CommandRouter`; màn hình duyệt y/n, `registry.approver` qua store, `Enter` chưa chọn = `deny`, không `allowWithoutApprover`; mỗi lượt một `AbortController`, `Esc` dừng; `Ctrl+C` hai lần trong 2 giây thì thoát và trả terminal về bình thường | `npm start` chạy được; ảnh chụp 80 và 120 cột | done |
| E5 | Footer 2 dòng + telemetry lượt (bước 8): TTFT, TPS, thanh context theo `ModelInfo.contextWindow`, git status có cache | Test `node:test` cho phần tính toán trong `layout.ts` | done |
| E6 | Điền 3 wire `google-generative-ai`, `google-gemini-cli` (dùng project Cloud Code Assist lưu trong credential), `google-vertex` (ADC) | Test server giả cho cả 3 (stream text, gọi tool, usage) | done |

Xong khi: checklist `tui.md` mục 10.1 đủ; `npm start` không có key thì chỉ cách `/login`, không crash; không có `console.log` trong `src/tui/`.
