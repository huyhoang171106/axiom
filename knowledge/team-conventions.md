# Quy ước code của nhóm khi sửa target repo

Nguồn `team` của RAG (đề mục 2.3). Mỗi quy tắc lấy từ đề hoặc `docs/DESIGN.md`; đổi quy tắc thì sửa nguồn trước.

## Phạm vi thay đổi

- Chỉ làm việc vừa: sửa bug nhỏ, thêm tính năng tối đa 5 file, viết test, refactor cục bộ. Không thiết kế lại kiến trúc, không migration dữ liệu (đề mục 1.4).
- Mọi thay đổi nằm trong workspace của target repo.

## Sửa code

- Ghi file bằng `apply_patch`, chỉ nhận unified diff (đề mục 4.1).
- Không sửa test có sẵn để test pass; guard chặn việc này (đề mục 4.1).
- Test phát hiện bug thật thì báo cáo bug, không sửa test cho khớp bug (đề UC-07, tiêu chí 4).

## Kiểm tra

- Sau mỗi lần sửa file, harness tự chạy `python -m pytest`; không bỏ qua bước này (`docs/DESIGN.md` mục 3).
- `run_command` chỉ chạy lệnh trong allowlist (đề nêu ví dụ `python -m pytest`, `ruff`, `mypy`, `git status/diff/log`); lệnh khác phải duyệt (đề mục 4.1).
- Vòng sửa bug tối đa 5 lần; quá 5 vòng thì dừng và báo cáo thất bại: đã thử gì, giả thuyết nào bị loại, bước tiếp theo (đề UC-03).

## Phong cách Python

- Theo quy ước của chính target repo (ví dụ `CONTRIBUTING.rst` của tinydb: PEP 8). Quy ước của repo đứng trước tài liệu này.
