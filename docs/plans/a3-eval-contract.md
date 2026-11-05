# A3 — Đề xuất contract và thứ tự triển khai

Task: [#8](https://github.com/se373agenticengineering/nhom-30/issues/8). Nhánh: `a/a3-eval-runner`.

Trạng thái: An đồng ý hướng triển khai; **chưa có xác nhận contract/quyền sửa CI từ D0**. Tài liệu này là đề xuất, chưa thay thế chữ ký ở `phase-2.md` mục 5.4. Không coi là nghiệm thu Done.

## 1. Chênh lệch cần giải quyết trước khi đổi API

| Trước A3 | Yêu cầu issue #8 | Hướng xử lý |
|---|---|---|
| Plan cũ bỏ qua runner thiếu và giữ exit code | Release thiếu UC-01..05 phải fail | `--all` đòi đủ 01..05; chỉ `--partial` cho phép thiếu runner và luôn ghi không đủ điều kiện release |
| `evals/run.ts` fallback mock khi provider chưa sẵn sàng | Không được mock ngoài ý muốn | Chỉ tạo mock khi có `--mock`; credential/provider lỗi phải có kết quả lỗi và exit code khác 0 |
| `UcCaseResult` không có `mustPass` | Result phải thể hiện acceptance gates | Giữ `mustPass` ở fixture UC-01; chuyển đánh giá case bắt buộc thành gate rõ ràng, không truy cập field không tồn tại ở result chung |
| `passed` từng case không thể hiện ngưỡng cả UC | Release phải bắt threshold fail, zero case, hidden skip | Result UC mang gates và danh sách case dự kiến để so với case thực chạy |
| Chỉ có model ID trong tracker | Cần provenance provider/model/mock từng case | Mỗi case ghi model đã resolve và role, không ghi credential hay toàn bộ config |
| CI gọi `npm run eval --if-present` | Smoke phải chọn mock rõ và không thay eval thật | D0 giao quyền sửa đúng bước eval; chốt cách smoke khi chưa có runner 02..05 |

## 2. Phần giữ nguyên, có thể làm trước

`measureCase` thuộc A3, giữ nguyên chữ ký trong lane plan:

```ts
export async function measureCase<T>(
  id: string,
  fn: (tracker: CostTracker) => Promise<T>
): Promise<{
  value?: T;
  tokens: number;
  costDollars: number;
  latencyMs: number;
  error?: string;
}>;
```

- Tạo `CostTracker` mới cho mỗi lần gọi, không reset tracker phiên hoặc dùng tracker toàn cục.
- Đo `performance.now()` từ trước callback đến khi callback resolve/reject.
- Token = tổng prompt + completion; không tin `totalTokens` để cộng cache hai lần.
- Callback chuyển cùng tracker cho chat/embedding/compaction để cộng mọi usage thuộc case. Helper không tự nhận diện provider hay tự gọi model.
- Lỗi giữ token/cost đã phát sinh, không trả `value`; luôn có chuỗi `error` không rỗng, có case ID và đi qua `redact`.
- Zero usage hợp lệ nếu chưa gọi model; có lỗi thì vẫn là case lỗi, không được biến thành case thành công có chi phí 0.
- Test dùng clock giả, không sleep, không network, không đọc `~/.axiom` thật.

## 3. API bổ sung đề xuất cho D0

Chỉ thêm field tuỳ chọn vào contract hiện tại để runner cũ còn typecheck. Bộ điều phối nghiêm ngặt phải từ chối bằng chứng thiếu các field cần thiết, không suy luận pass từ việc field vắng mặt.

```ts
interface UcGateResult {
  id: string;
  passed: boolean;
  reason?: string;
}
interface UcCaseProvenance {
  mock: boolean;
  models: Array<{ provider: string; model: string; role: ModelRole }>;
}
// UcCaseResult: thêm provenance?: UcCaseProvenance; skipped?: string;
// UcResult: thêm gates?: UcGateResult[]; expectedCaseIds?: string[];
```

Các trường ở trên là **đề xuất, chưa có trong `evals/types.ts`**. Không đổi `UcRunner` hay tham số `UcRunOptions` khi chưa chốt. `skipped` là lý do bỏ qua, không phải một case pass. `expectedCaseIds` dùng để phát hiện case mất, case trùng và case bị bỏ qua trong kết quả. Gate của từng UC phải kiểm được ngưỡng và case bắt buộc từ fixture; không cho case injection bị xoá làm ngưỡng còn lại xanh.

Provenance lấy từ model được resolve và đường chạy thật/mock thực tế; tracker chỉ tổng hợp usage theo model ID, không đủ để suy ra provider. Embedding/compaction nếu có phải cùng tracker và được liệt kê trong provenance của case. Không ghi giá trị secret, header auth hay config vào artifact.

## 4. Ngữ nghĩa CLI development (chưa chứng nhận release)

- `--uc NN` lặp được: chạy các UC được chọn, loại trùng; artifact ghi rõ chạy chọn lọc, không phải full release.
- `--all`: chọn UC-01..05 bắt buộc và các runner đã đăng ký thêm. Thiếu runner bắt buộc là lỗi.
- `--mock`: smoke tường minh, không phải bằng chứng eval thật. Không được fallback từ real sang mock.
- `--partial`: development cho phép thiếu runner; báo từng UC thiếu trong artifact và console. Dù các UC đã chạy pass, kết quả không đủ điều kiện full release.
- Không có `--uc` hoặc `--all`: lỗi `Pass --uc NN or --all`. Giá trị UC phải có hai chữ số; flag không biết phải lỗi, không bỏ qua ngầm.
- Full release chỉ hợp lệ khi chạy `--all` không mock, không partial, đủ runner/case/gate/provenance và mọi gate đạt.
- Mọi chế độ đều fail khi runner lỗi hoặc zero case; partial không miễn lỗi/threshold cho runner đã chạy.
- `evals/results.json` giữ `runAt`, `mock`, `ucs`; bộ điều phối A3 hiện thêm `scope`, `partial`, `requestedUcs`, `missingUcs`, `errors`, `passed`, `releaseEligible`, `releaseBlockers`. Chưa đổi contract `UcResult`; metadata release cuối cùng cần đồng bộ D0 khi tích hợp gates/provenance.

## 5. Thứ tự commit và test

1. **Tài liệu contract**: ghi đề xuất và các điểm cần D0 xác nhận. Không đổi runtime/API/CI.
2. **Helper đo case**: `evals/measure.ts` + `tests/eval-measure.test.ts`; test success, failure có usage, lỗi rỗng/non-Error, redaction, token prompt/completion, tracker độc lập và clock tất định.
3. **Runner UC-01**: có thể chuẩn bị tách `evals/uc01/run.ts`, dùng helper và giảm registry còn đăng ký runner khi giữ nguyên contract hiện hành. Điều phối CLI có thể nối theo contract hiện hành; chỉ bổ sung gates/provenance chung sau khi D0 chốt. Giữ 10 fixture, bảo toàn injection gate của CLI cũ; không viết runner của B/C/D/E.
4. **Điều phối CLI/artifact**: parse args, registry, workDir từng UC, averages, kết quả có cấu trúc; test qua runner fake và entry point, không gọi mạng thật.
5. **Release gates**: test missing runner, zero case, threshold fail, missing/duplicate/skipped case, thiếu credential, provenance mock sai và không fallback.
6. **CI/tài liệu nghiệm thu**: chỉ sửa đúng bước CI được D0 giao; chạy lint, full tests, build và smoke phù hợp các runner hiện có. Không dùng partial/mock làm bằng chứng hoàn tất release.

Mỗi commit code đi kèm test và comment tiếng Việt giải thích ý định/ràng buộc. Chạy test liên quan khi lặp, `npm run lint && npm test` trước commit. Chỉ push/mở PR/merge khi An yêu cầu rõ.

## 6. Cần D0 trả lời

1. Chấp thuận/sửa các field bổ sung ở mục 3 và metadata artifact ở mục 4; đồng bộ `phase-2.md` mục 5.4 trước khi implement.
2. Chốt ngữ nghĩa `--all`, `--uc`, `--partial` và các gate tối thiểu của runner B/C/D/E; runner cũ thiếu bằng chứng không được coi là pass release.
3. Giao A3 quyền sửa bước eval trong `.github/workflows/ci.yml`. Hiện registry chỉ có UC-01: chọn smoke partial có nhãn rõ trong lúc tích hợp, hoặc đợi đủ runner để bật full smoke; không tự tạo fake runner 02..05 để CI xanh.

## 7. Tiến độ trên nhánh

- Bước 1: đã commit đề xuất (`e8e9506`); chưa có xác nhận từ D0.
- Bước 2: đã viết `evals/measure.ts` đúng chữ ký hiện hành, có comment tiếng Việt và 10 test ở `tests/eval-measure.test.ts`; test mới không skip.
- Kiểm tra bước 2: `npm run lint`, `npm run build` pass. Full suite với Python/pytest qua `AXIOM_PYTHON`: 553 test, 540 pass, 13 skip môi trường Windows, 0 fail. Không coi skip Linux/bwrap là bằng chứng sandbox.
- Phần chuẩn bị bước 3 tại commit `5348710`: tách `evals/uc01/run.ts`, registry chỉ đăng ký runner, thay phần đo lặp bằng `measureCase`, giữ nguyên contract hiện hành. Ở bước 4, helper/fixture đã chuyển sang `evals/uc01/cases.ts` để runner không import entry point CLI và không tạo vòng phụ thuộc.
- Thêm 5 test trong `tests/eval-uc01.test.ts`: đủ 10 fixture, registry trỏ đúng hàm, provider/tracker độc lập, giữ usage qua schema retry/provider failure và từ chối provider đã tắt thay vì fallback mock. Test dùng mock để kiểm pipeline, không phải số đo accuracy thật.
- Kiểm phần chuẩn bị bước 3: 27 test eval liên quan pass, 0 skip; lint/build pass. Full suite với Python/pytest: 558 test, 545 pass, 13 skip môi trường, 0 fail.
- Bước 4: CLI đã dùng registry, parse `--uc` lặp được/`--all`/`--mock`/`--partial`, xuất artifact, workDir từng UC và averages. Đã bỏ fallback mock và xoá vòng chạy triage trùng trong CLI cũ. Gate UC-01 lấy case bắt buộc từ fixture, đếm unexpected tool calls qua `metrics` có sẵn, tính lại ngưỡng từ case thay vì tin summary; bắt thiếu/trùng case và sai injection.
- Test bước 4: 54 test eval liên quan pass, 0 skip; lint/build pass. Full suite với Python/pytest: 585 test, 572 pass, 13 skip môi trường, 0 fail. Test entry point chạy subprocess, chặn kế thừa secret env và dùng AXIOM_HOME tạm.
- `evals/types.ts` và CI chưa sửa. Full real `--all` hiện fail-closed với lý do thiếu contract gates/provenance chung, kể cả case đang pass. `releaseEligible` luôn false trong giai đoạn development này; không coi CLI đã hoàn tất nghiệm thu release #8.
- Phát hiện khi thử lỗi có chuỗi nhạy cảm giả: `EventBus.installDefaultErrorHandler` (`src/core/event-bus.ts`) in message lỗi ra console mà chưa `redact`. `measureCase` che lỗi ở result nhưng không che được log đã phát trước đó. Cần D0 xử lý logger chung trước release; không tự sửa file chung trong commit tách runner.
- Các phép đo chat/embedding/compaction ở test helper là usage giả để kiểm tổng hợp, chưa phải nối workflow/eval thật.

## 8. Lệnh đã kiểm ở bước CLI

| Lệnh | Exit code | Ý nghĩa |
|---|---|---|
| `npm run eval -- --uc 01 --mock` | 0 | 10 case UC-01 chạy qua registry; smoke kiểm pipeline/schema, không kiểm accuracy thật |
| `npm run eval -- --all --mock` | 1 | Hiện thiếu runner 02..05, không bỏ qua ngầm |
| `npm run eval -- --all --mock --partial` | 0 | Development có nhãn rõ, artifact liệt kê 02..05 thiếu và không đủ điều kiện release |

Các lệnh trên chạy với AXIOM_HOME/config tạm và không gọi mạng thật. Artifact là `evals/results.json` (gitignored), không commit. Case `passed: false` do mock phân loại không đúng expected vẫn được ghi trung thực; `report.passed` ở mock UC-01 chỉ thể hiện smoke schema/pipeline đã chạy, không phải type accuracy đạt ngưỡng.

CI hiện còn gọi `npm run eval --if-present` không có selection: CLI mới sẽ báo `Pass --uc NN or --all`. Trước PR/merge cần D0 giao quyền cập nhật bước này và chốt full/partial smoke; **chưa có CI xanh cho bước 4, không được ship như task đã Done**.
