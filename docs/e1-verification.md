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
- `npm.cmd test`: exit 0; 396 test, 393 pass, 0 fail, 3 skip có sẵn (final verification).
- Skip có sẵn: POSIX permissions trên Windows; tình huống không có rg khi máy có rg; test scrubEnv cần `/bin/bash`.
- Test E1 mới không skip. Test Git dùng repository/worktree thật, không gọi mạng hoặc push thật.
- Fixture `tests/core.test.ts` đổi `/tmp/x` thành `x`: test vẫn giữ assertion từ chối vì thiếu approver; outside-root phải DENY theo nghiệm thu mới.

## Ranh giới C2/E2

`parseUnifiedDiff` hiện vẫn throw stub C2. E1 gọi đúng contract và ASK khi parser lỗi, không tự ALLOW patch chưa phân tích. Không viết parser thay C2 và không dùng fake làm bằng chứng tích hợp.

Sau khi C2 merge, E2 cần thay test xác nhận parser chưa sẵn sàng bằng kiểm thử parser thật: patch nhỏ ALLOW/low; >5 file hoặc xóa file ASK/medium; config ASK/high; cả oldPath/newPath ngoài root, secret, traversal và symlink DENY/high; rename, malformed patch và test-tamper guard. Đây là điều kiện tích hợp chưa được chứng minh, không phải test đã pass.

## Đối chiếu năm tiêu chí E1

| Tiêu chí | Kết quả trong phạm vi E1 | Bằng chứng |
|---|---|---|
| Catalog, tool đăng ký, alias, submit, unknown ASK | PASS | `permissions-catalog.test.ts`: so danh mục với registry thật, tên không ánh xạ ASK, submit hiện có low; registry không cung cấp alias tool |
| Workspace/secret và shell expansion | PASS | `permissions-paths.test.ts`, `permissions-shell.test.ts`, `policy.test.ts`: junction đổi sau lần kiểm tra, traversal, outside cat, substitution, quoted helper options; cú pháp không phân tích được không ALLOW |
| Destination Git, nested repo, worktree, -C | PASS cho các dạng được kiểm thử | `permissions-git.test.ts`: Git context thật, upstream/config, refspec nhiều đích, wildcard, mirror, -C, -c, force-with-lease, atomic, glob trước push; feature push vẫn ASK/high |
| Bundled trust giới hạn | PASS | `permissions-bundled.test.ts`: tài liệu thật được đọc, ghi/list bị chặn, giả mạo và junction alias bị chặn |
| Ranh giới parser C2/E2 | PASS phần E1 | `permissions-patch.test.ts` kiểm tra trạng thái parser thật hiện tại; checklist E2 cụ thể ở trên, không test skip hoặc mock parser |

Ba commit rà soát code/test: `b356192`, `beab883`, `fa7741d`. Giữ nguyên bảy commit trước. Sửa hai lỗi DENY bị che bởi ASK và lỗi quoted options che tác dụng ghi/chạy helper; thêm xử lý `git -c`.

E1 đủ điều kiện tạo PR để review phạm vi đã nêu. Không tuyên bố đã merge hoặc đã kiểm thử parser C2. Tích hợp parser thật thuộc E2 theo nghiệm thu mới, không dùng để chặn PR E1.

## Giới hạn bằng chứng và trạng thái ship

- Chưa chạy bộ test trên Linux; bằng chứng E1 là kiểm thử quyết định policy và filesystem/Git thật trên Windows. Không coi Linux là tiêu chí E1 mới.
- Tùy chọn Git ngoài tập phân tích, đường dẫn động và shell wrapper không được tự ALLOW. ASK không có nghĩa đã xác minh destination an toàn; không tuyên bố parser hỗ trợ toàn bộ Bash/Git.
- Chưa truy cập được nội dung Issue #31 trực tiếp: GitHub HTTP 404; dùng nghiệm thu trong prompt.
- Codex fetch vẫn lỗi `SEC_E_NO_CREDENTIALS`; không có `gh`. Chưa push, tạo PR, chạy CI hoặc ship. Không đánh dấu E1 done.

PR khi đủ điều kiện phải có `Closes #31` và đi qua `scripts/ship.sh`; không push main.

## Final verification

Chạy trực tiếp bảy file `permissions-{catalog,paths,shell,git,bundled,patch}.test.ts` và `policy.test.ts`: 55/55 pass, exit 0, không skip. Full suite và lint exit 0 với AXIOM_HOME tạm và AXIOM_PYTHON thật; lần full suite đầu dùng PATH mặc định thất bại vì Windows Store Python alias vẫn tồn tại trong tiến trình Codex.

Đã tăng độ mạnh của bằng chứng, không đổi production code:

- `push destinations include configured upstream and multiple refspecs`: xóa remote push override trước phần worktree, thêm feature HEAD ASK làm đối chứng, xác nhận `.git` worktree là file và push mặc định ở worktree main DENY. Tránh test pass vì cấu hình từ case trước.
- `outside cat is denied before approval and execution while workspace reads succeed`: tạo file thật ngoài/trong workspace, xác nhận relative/absolute outside cat DENY/high qua decide và registry, approver không được gọi, không trả sentinel ngoài root; read_file thật trong workspace thành công; junction tới `.ssh` bị DENY.

Các test gọi implementation thật, filesystem thật và Git subprocess thật. Không mock verdict hoặc Git context. Approver trong test chỉ là điểm quan sát để fail nếu bị gọi sai. Test C2 xác nhận fail-closed của stub hiện có, không phải bằng chứng parser hoạt động; kiểm thử parser thật vẫn là trách nhiệm E2 theo tiêu chí 5. Không push, tạo PR hoặc merge trong final verification.
