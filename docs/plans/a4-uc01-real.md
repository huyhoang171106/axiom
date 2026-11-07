# A4 - Checklist eval thật UC-01

Branch: `a/a4-uc01-real`. Phạm vi và ngưỡng nghiệm thu: [phase-2-A.md, A4](phase-2-A.md#a4-số-đo-thật-uc-01).

## 1. Phạm vi

- Dùng runner `evals/uc01/run.ts` và 10 fixture hiện có trong `evals/uc01/`; không viết lại runner chung A3 hoặc runner của làn khác.
- Tài liệu kết quả và ba artifact đo thật nằm ở `docs/uc-01.md`; gate injection đạt sau khi đổi expected theo quyết định của An.
- Runner lưu `typeCorrect`, `routeCorrect` và bằng chứng riêng UC-01 `classification`: expected type/route của fixture, actual type/route sau validator (hoặc `null` khi không có ticket). Bằng chứng đi qua artifact và redaction, không suy ngược actual từ boolean và không đổi `evals/types.ts`.
- Mock chỉ kiểm pipeline. Kết quả UC-01 riêng không chứng minh full release UC-01..05.

## 2. Thứ tự commit

Mỗi commit phải có nội dung kiểm chứng được. Chạy test mới để thấy lỗi trước khi sửa ở local; không push một commit cố ý làm CI đỏ. Nếu test và implementation không thể tách thành hai commit xanh, gộp chúng lại.

| Bước | Commit dự kiến | Đầu ra |
|---|---|---|
| 1 | `docs(eval): define A4 execution checklist` | Checklist, ranh giới, cách lưu từng lần thử và điều kiện chốt |
| 2 | `docs(triage): document UC01 workflow and evaluation setup` | `docs/uc-01.md`: thiết kế, cách chạy, bảng case và trạng thái chưa đo |
| 3 | `test(eval): cover UC01 actual prediction evidence` | Kiểm thử prediction đúng/sai, không có ticket và bảo toàn metrics hiện hành; chỉ tách commit nếu vẫn xanh |
| 4 | `feat(eval): retain UC01 actual predictions` | Bằng chứng expected/actual riêng UC-01, đi qua artifact và redaction; gộp bước 3 nếu cần |
| 5 | `docs(eval): record UC01 real baseline` | Artifact thật đã kiểm secret, bảng 10 case, môi trường và tổng usage |
| 6 | `test(triage): cover observed classification failure` | Chỉ thực hiện khi baseline có lỗi tái hiện được bằng test tất định |
| 7 | `fix(triage): clarify evidence-based classification` | Chỉ sửa skill/prompt theo lỗi quan sát được; gộp bước 6 nếu cần để CI xanh |
| 8 | `docs(eval): record UC01 final real evaluation` | Lượt thật xác minh kết quả cuối; so với baseline nếu có thay đổi |
| 9 | `docs(plan): complete A4 with verified evaluation evidence` | Hoàn thiện failure mode, cách tái chạy và đánh dấu done khi đạt ngưỡng |

Bỏ bước 6-7 nếu baseline không cần sửa. Không thêm thay đổi không cần thiết chỉ để tăng số commit. Nếu baseline đã đạt và không có thay đổi sau đó, dùng lại bằng chứng ấy cho kết quả cuối, không chạy lại chỉ để tạo commit.

## 3. Checklist trước khi gọi model thật

- [ ] Xác nhận máy chạy với An/D. Quyết định chung là máy D vận hành theo [phase-2.md mục 10](phase-2.md#10-tiêu-chí-xong); không tự thay bằng máy local.
- [ ] Xác nhận quyền dùng credential hiện có và model resolve từ `@smol`; không đọc/in giá trị credential, không yêu cầu dán secret vào chat.
- [ ] Ghi revision code, thay đổi chưa commit nếu có, phiên bản Node, hệ điều hành, provider/model thực tế và thời điểm chạy. Ưu tiên chạy từ revision sạch.
- [ ] Giữ nguyên input và expected của 10 fixture giữa các lượt; ghi nhận revision fixture.
- [x] Hoàn tất bằng chứng actual prediction trước baseline để không phải đo lại chỉ vì thiếu dữ liệu.
- [ ] Chạy local CI thành công trước push; test tự động chỉ dùng mock hoặc server giả, không gọi provider thật.

Các lượt trên WSL của Hoàng được ghi ở [docs/uc-01.md](../uc-01.md#các-lần-thử). Baseline và lượt chạy lại trên `69f87bd` không đạt gate; lượt trên `9261540` với expected mới đạt gate. Credential được người vận hành cho phép sử dụng; cấu hình tạm không thay đổi cấu hình Axiom thường dùng.

Local CI trên WSL cho revision `9261540` và tài liệu/artifact của lượt đạt gate: 730 pass, 0 fail, 1 skip vì `ripgrep` đã cài; lint, build và eval UC-01 mock pass. Gate này chỉ áp dụng UC-01 riêng, không phải full release.

## 4. Chạy và giữ bằng chứng

1. Sau khi môi trường và credential được xác nhận, chạy `npm run eval -- --uc 01` (không thêm `--mock`).
2. Lưu lại exit code và artifact `evals/results.json` ngay sau lượt chạy; CLI dùng cùng đường dẫn cho các lượt nên không chạy mock đè lên kết quả chưa giữ lại.
3. Trước khi đưa vào Git, kiểm tra artifact đã redaction, không chứa credential hoặc thông tin riêng tư. Chỉ commit bản bằng chứng đã kiểm tra dưới `docs/`; không commit trace hay log thô.
4. Đặt tên riêng cho mỗi lần thử, dự kiến `docs/eval-uc01-attempt-01.json`, tăng số cho lượt sau. Đây là đường dẫn dự kiến, chưa phải artifact đã tồn tại.
5. Ghi vào bảng "Các lần thử" trong `docs/uc-01.md`: thời điểm, revision, provider/model, liên kết artifact, ba chỉ số accuracy/schema, token, chi phí, độ trễ và lý do chạy lại.
6. Bảng từng case phải có id, expected type/route, actual type/route, đúng/sai, schema, số unexpected tool calls và lỗi nếu có. Không có ticket thì ghi rõ không có, không điền đáp án expected thay actual.
7. Provider lỗi hoặc thiếu credential là lượt không hoàn tất, không fallback mock và không ghi thành số đo đạt. Giữ bằng chứng lỗi đã che secret nếu đã tốn usage.
8. Nếu sửa prompt/skill, ghi lỗi quan sát được và chạy lại toàn bộ bộ case. Không đưa đáp án fixture vào prompt để làm đẹp số. Riêng expected route case injection được An cho phép đổi từ `implement` sang `ask_user`; ghi rõ revision và không sửa artifact cũ.

## 5. Kiểm tra và chốt

- [ ] Đối chiếu số liệu tài liệu với artifact, không tự viết số accuracy hoặc chi phí.
- [ ] Kiểm gate UC-01 theo ngưỡng ở lane plan; ghi riêng `routeAccuracy` dù không có ngưỡng chung cho toàn bộ route.
- [ ] Case injection phải được xét riêng, không để điểm trung bình che lỗi.
- [ ] `docs/uc-01.md` có sơ đồ graph, failure modes thực tế và hướng dẫn tái chạy.
- [ ] Chạy `npm run ci:local`, đọc kết quả và ghi rõ các test skip do môi trường; không xem skip là bằng chứng sandbox Linux.
- [ ] Trên Windows, script CI mặc định bật local tests. Nếu hai test yêu cầu từ chối khi thiếu bwrap xung đột với cờ này, dùng `AXIOM_ALLOW_LOCAL_TESTS=0 npm run ci:local`; không sửa/skip test để né lỗi.
- [ ] Chỉ đổi A4 thành `done` khi đủ bằng chứng thật và check đạt. Commit/push từng phần lên branch theo yêu cầu An, không tự merge trong giai đoạn này.
