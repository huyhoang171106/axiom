# E1: triển khai và bằng chứng local

Baseline: `2dac16c661687e8e1452b94097b433905f4a4d96`, branch `e/e1-risk-catalog`.

## Phạm vi

- `permissions.ts`: risk ở mọi quyết định, unknown tool ASK, cấu hình nhạy cảm ASK/high, path ngoài workspace và secret DENY/high; bỏ cache kết quả path để không giữ quyền sau khi đổi symlink.
- `registry.ts`: chuyển risk tới approver; giữ nguyên chữ ký và luồng kiểm tra lại edited args.
- `policy-shell.ts`: chỉ phân tích literal words; cú pháp động hoặc không hiểu được ASK/high. Không thực thi shell để phân tích. Đây không phải parser Bash đầy đủ.
- `policy-git.ts`: đọc context bằng Git subprocess không shell, xét refspec, remote push config, upstream, mirror/matching, `-C`, nested repo và worktree. Destination không chứng minh được không được ALLOW.
- `bundled-skills.ts`: chỉ hai tài liệu đóng gói `bug-fix/SKILL.md`, `issue-triage/SKILL.md`, kiểm tra canonical path; chỉ `read_file` được ngoại lệ.
- Registry hiện không có cơ chế alias tool. Tên không ánh xạ như `bash`, `read`, submit không biết vẫn ASK; tool không đăng ký không được execute. Submit hiện có là `submit_issue_ticket`.

Không sửa E2 denied-actions, E4 audit hay E5 modes. Không thêm dependency hoặc đổi contract D0.

## Kiểm thử 04/11/2026

PowerShell: đặt `AXIOM_HOME` vào thư mục tạm mới; đặt `AXIOM_PYTHON` tới Python314 thật (PATH mặc định trỏ Windows Store alias).

- `npm.cmd run lint`: exit 0.
- `npm.cmd test`: exit 0; 392 test, 389 pass, 0 fail, 3 skip có sẵn.
- Skip có sẵn: POSIX permissions trên Windows; tình huống không có rg khi máy có rg; test scrubEnv cần `/bin/bash`.
- Test E1 mới không skip. Test Git dùng repository/worktree thật, không gọi mạng hoặc push thật.
- Fixture `tests/core.test.ts` đổi `/tmp/x` thành `x`: test vẫn giữ assertion từ chối vì thiếu approver; outside-root phải DENY theo nghiệm thu mới.

## Ranh giới C2/E2

`parseUnifiedDiff` hiện vẫn throw stub C2. E1 gọi đúng contract và ASK khi parser lỗi, không tự ALLOW patch chưa phân tích. Không viết parser thay C2 và không dùng fake làm bằng chứng tích hợp.

Sau khi C2 merge, E2 cần thay test xác nhận parser chưa sẵn sàng bằng kiểm thử parser thật: patch nhỏ ALLOW/low; >5 file hoặc xóa file ASK/medium; config ASK/high; cả oldPath/newPath ngoài root, secret, traversal và symlink DENY/high; rename, malformed patch và test-tamper guard. Đây là điều kiện tích hợp chưa được chứng minh, không phải test đã pass.

## Còn phải kiểm chứng trước nghiệm thu

- Bộ test trên môi trường Linux có `/bin/bash`, đặc biệt hành vi shell thực thi; hiện chỉ kiểm chứng quyết định policy trên Windows.
- Rà soát thêm các tùy chọn Git không thuộc tập phân tích (hiện không ALLOW), đường dẫn động và shell wrapper. ASK không có nghĩa đã xác minh destination an toàn.
- Chưa truy cập được nội dung Issue #31 trực tiếp: GitHub HTTP 404; dùng nghiệm thu trong prompt.
- Codex fetch vẫn lỗi `SEC_E_NO_CREDENTIALS`; không có `gh`. Chưa push, tạo PR, chạy CI hoặc ship. Không đánh dấu E1 done.

PR khi đủ điều kiện phải có `Closes #31` và đi qua `scripts/ship.sh`; không push main.
