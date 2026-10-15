# Phase 1 — B: Provider, credential, wire họ Google

Đọc: `phase-1.md` (D0, Seam), **toàn bộ** `providers.md` (mục 12, bước 2–6, 8–9).

| # | Việc | Đầu ra kiểm được | Trạng thái |
|---|---|---|---|
| B1 | Script sinh catalog từ bảng mục 3 (làm được khi D0 chưa xong), rồi điền `loadCatalog`: 91 provider, JSON 2 nửa + `_order.json`; provider "Không làm" có `"available": false` + `"reason"`; gộp `models.json` (mục 7.2) | Test schema cả thư mục; mọi provider có `login` nằm trong `_order.json`; `models.json` hỏng không crash | todo |
| B2 | Credential store (`registerSecret` mọi giá trị, `auth.json` atomic `0o600`, `~/.axiom` `0o700`), thứ tự lấy credential (mục 5), điền `resolveModel` (mục 9) và `createProviderFor` (dùng bảng `WIRES` có sẵn) | Test thứ tự 6 nguồn, alias role, alias vòng báo lỗi, `disabledProviders` thắng credential | todo |
| B3 | Điền engine `api-key` (endpoint có bảo vệ, timeout 10 giây); điền lệnh `login` (chọn engine theo `LOGIN_ENGINES`, lưu `Credential` vào store), `logout`, `model`, `models`; discovery + cache (bước 5–6) | Đăng nhập thật ≥ 1 provider; server giả: 200 lưu, 401 không lưu; discovery: timeout, JSON hỏng, cache hết hạn | todo |
| B4 | Điền 3 wire `google-generative-ai`, `google-gemini-cli`, `google-vertex` (ADC); điền engine `cloud-fields` (`/login` nhiều trường) cho `azure`, `google-vertex`, `amazon-bedrock`, `cloudflare-ai-gateway`, `snowflake` (bước 9) | Test server giả cho 3 wire; test hook | todo |

Xong khi: checklist `providers.md` mục 12.1 đủ; `axiom models` đúng 87 provider; thử thật ≥ 3 provider dùng wire của B.
