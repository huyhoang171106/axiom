# Phase 1 — B: Catalog, credential, resolver, đăng nhập API key / cloud / device code

Đọc: `phase-1.md` (D0, Seam), **toàn bộ** `providers.md` (mục 12, bước 2–7, 9).

| # | Việc | Đầu ra kiểm được | Trạng thái |
|---|---|---|---|
| B1 | Script sinh catalog từ bảng mục 3 (làm được khi D0 chưa xong), rồi điền `loadCatalog`: 91 provider, JSON 2 nửa + `_order.json`; provider "Không làm" có `"available": false` + `"reason"`; gộp `models.json` (mục 7.2). Sinh xong một lần thì file `auth/<id>.json` của luồng OAuth thuộc người làm luồng đó (A7, B5, C5), không sinh đè | Test schema cả thư mục; mọi provider có `login` nằm trong `_order.json`; `models.json` hỏng không crash | done |
| B2 | Credential store (`registerSecret` mọi giá trị, `auth.json` atomic `0o600`, `~/.axiom` `0o700`), thứ tự lấy credential (mục 5), refresh chung (`expires` < 5 phút thì gọi token endpoint trong auth JSON; lỗi 400/401 thì xoá credential), điền `resolveModel` (mục 9) và `createProviderFor` (dùng bảng `WIRES` có sẵn) | Test thứ tự 6 nguồn, alias role, alias vòng báo lỗi, `disabledProviders` thắng credential, refresh thành công và refresh lỗi | done |
| B3 | Điền engine `api-key` (endpoint có bảo vệ, timeout 10 giây); điền lệnh `login` (chọn engine theo `LOGIN_ENGINES`, lưu `Credential` vào store), `logout`, `model`, `models`; discovery + cache (bước 5–6) | Đăng nhập thật ≥ 1 provider; server giả: 200 lưu, 401 không lưu; discovery: timeout, JSON hỏng, cache hết hạn | done, chưa thử đăng nhập thật |
| B4 | Điền engine `cloud-fields` (`/login` nhiều trường, mục 4.5, 7.4) cho `azure`, `google-vertex`, `amazon-bedrock`, `cloudflare-ai-gateway`, `snowflake` | Test hook cho cả 5 | done |
| B5 | Điền engine `device-code` (mục 4.3) và 4 luồng: `xai-oauth`, `muse-code` (đổi token lấy API key), `factory-droid` (lấy region và org ID), `kimi-code`. Sở hữu `auth/<id>.json` của 4 provider này | Server giả: `authorization_pending`, `slow_down` +5 giây, hết `expires_in` thì dừng; đăng nhập thật ≥ 1 | done, chưa thử đăng nhập thật |

Xong khi: checklist `providers.md` mục 12.1 đủ; `axiom models` đúng 87 provider; thử thật ≥ 3 provider hoặc luồng đăng nhập của B.
