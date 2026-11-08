# D6 — Kiểm tích hợp TUI (08/11/2026)

Bằng chứng cho task **D6 / #29**: các slash command và luồng duyệt chạy trên TUI thật (Ink), không phải snapshot component.
Mọi trích dẫn dưới đây là output pane chụp bằng `tmux capture-pane`, không sửa tay.

## 1. Cách lái TUI để kiểm tự động

- Chạy `npm start` (hoặc `tsx bin/axiom.ts`) trong một session tmux, kích thước 120×45 — TUI cần TTY thật.
- Gửi phím: `tmux send-keys -t <session> "<text>"` rồi **`C-m`** để Enter. Nếu gửi `"text" Enter` thì chữ chỉ được thêm dòng trong composer, **không submit**.
- Chụp: `tmux capture-pane -p -t <session> -S -60` (kèm scrollback), chờ 4–8 s sau mỗi lệnh để renderer vẽ xong.
- Chỉ dùng lệnh không gọi model (`/cost`, `/memory`, `/resume`, `/mode`, `/plan`, `/audit`, `/models`, `/help`) ở lượt đầu để chứng minh wiring mà không tốn token.

## 2. Slash command và kết quả render

| Lệnh | Output thật trong pane |
|---|---|
| `/cost` | `Session: input 0, output 0` / `Total $0.000000` |
| `/memory` | `Project memory is empty (/home/hoang/.axiom/memory/nhom-30-13151ae7.md).` + `Use /memory add <note> to save conventions.` |
| `/resume` (workspace chưa có task dở) | `No unfinished tasks found in this workspace.` |
| `/mode read-only` | `Mode: read-only`; chip góc dưới đổi thành `read-only` |
| `/plan` | `Mode: read-only (plan)`; chip `read-only (plan)` |
| `/plan off` | `Mode: read-only` |
| `/mode edit` | `Mode: edit` |
| `/models find embed` | `fireworks (not connected) fireworks/qwen3-embedding-8b 41k $0/$0` và `ollama (connected) ollama/qwen3-embedding:0.6b 128k -` |
| `/memory add <note>` | `Added to project memory: luon chay pytest truoc khi sua file python` |
| `/memory` | `# Project memory (/home/hoang/.axiom/memory/ax-feature-demo-5961a22f.md)` + bullet vừa thêm |
| `/memory clear` | hộp duyệt `{"question":"Clear all project memory for this repository?"}` → `y` → `Project memory cleared.` |
| `/audit 3` | log có mốc thời gian, dạng `2026-11-08T11:12:13.654Z submit_issue_ticket` + `low \| allow \| policy` + JSON args |

Mỗi lượt do người dùng gõ bắt đầu bằng marker `▌ > ` trong transcript.

## 3. Cổng duyệt hành động rủi ro

Yêu cầu `chay pip install requests de cai thu vien` trong TUI:

```text
● run_command pip install requests 2>&1 || python3 -m pip install requests 2>&1
╭──────────────────────────────────────────────────────────────────────────╮
│ ! Cần duyệt: run_command                                                 │
│ Risk: high                                                               │
│ pip install requests 2>&1 || python3 -m pip install requests 2>&1        │
│ Lý do: shell syntax cannot be verified without evaluation                │
│ [y] Duyệt   [n / Enter] Từ chối   [e] Edit                               │
╰──────────────────────────────────────────────────────────────────────────╯
```

Bấm `n`:

```text
⊘ run_command pip install requests 2>&1 || python3 -m pip install requests 2>&1 — bị chặn: shell syntax cannot be verif…
● run_command pip install requests
Lệnh trước bị từ chối vì có toán tử shell ||. Tôi thử lại đúng lệnh bạn yêu cầu, không có toán tử nào.
│ ! Cần duyệt: run_command                                                │
│ Risk: medium                                                            │
│ Lý do: "pip" is not a known read-only command                           │
```

Cả hai lượt đều bị chặn (không lệnh nào chạy) và được ghi audit thật (`~/.axiom/audit.jsonl`):

```json
{"tool":"run_command","risk":"high","decision":"ask","args":{"command":"pip install requests 2>&1 || python3 -m pip install requests 2>&1"}}
{"tool":"run_command","risk":"high","decision":"reject","args":{"command":"pip install requests 2>&1 || python3 -m pip install requests 2>&1"}}
{"tool":"run_command","risk":"medium","decision":"ask","args":{"command":"pip install requests","timeoutMs":300000}}
{"tool":"run_command","risk":"medium","decision":"reject","args":{"command":"pip install requests","timeoutMs":300000}}
```

Trace của cùng lượt có `approval` và `cost_update`; test `tests/e3-integration.test.ts` khẳng định trace chứa đủ `node`, `tool_call_start`, `tool_call_end`, `cost_update`, `approval`.

## 4. `/triage` render ticket trong phiên thật

```text
● submit_issue_ticket {"ticket":{"type":"bug","priority":"P2 - silent data corruption in stock counts if real, but not …
type                  bug
priority              P2 - silent data corruption in stock counts if real, but not reproduced; code reads correct
route                 ask_user
affected_files        tinydb/operations.py
reproduction_steps    Insert a document such as {'item': 'apple', 'stock': 10}
acceptance_criteria   After db.update(subtract('stock', 3), where('item') == 'apple') on stock=10, the stored stock is 7
missing_info          What is the exact value of n passed to subtract(), e.g. is it a negative number such as -3?
```

Sau đó TUI hỏi duyệt: `{"question":"Provide the missing information now?"}` với `[y] Duyệt [n / Enter] Từ chối`.
Trả lời `n` → về lại idle, `/cost` vẫn chạy (`Session: input 349, output 3604`). Trả lời `n` ở câu hỏi
`Chạy route đề xuất (fix)?` cũng về idle bình thường.

## 5. `/feature` bị ngắt giữa chừng rồi `/resume`

Workspace thử: bản copy TinyDB ở `/tmp/ax-feature-demo`. Yêu cầu: thêm `limit` cho `Table.search`.

Ngắt bằng Ctrl+C hai lần khi bước 1 xong; `task_state.json` ghi `1 [done]`, `2 [failed]` (bị ngắt giữa bước), `3..6 [todo]`.
Mở lại axiom trong cùng workspace và gõ `/resume`:

```text
▌ > /resume
[failed] Feature implementation failed at step 2: Task aborted via AbortSignal
Thread: feature-20261108-114953-e0c996
1. [done] Đọc và xác nhận cách TinyDB forward search tới default table (database.py __getattr__) và cơ chế query cache
2. [failed] Thêm tham số limit: Optional[int] = None vào Table.search; xử lý limit <= 0 trả [], limit None trả toàn bộ;
3. [done] Cập nhật docstring của Table.search mô tả tham số limit và các trường hợp biên
4. [todo] Thêm test trong tests/test_tables.py: …
5. [todo] Chạy pytest và mypy …
6. [todo] Cập nhật docs/changelog.rst …
```

Sau `/resume`, graph chạy tiếp và bước 3 chuyển `todo → done`; bước 1 **không** chạy lại (state giữ nguyên, cây file không bị sửa lại).
Đây là hành vi đúng của "làm tiếp từ bước còn thiếu".

Hạn chế đã gặp, ghi lại để xử lý sau: bước bị ngắt giữa chừng được đánh `failed` và `/resume` **đi tiếp** sang bước sau
thay vì chạy lại bước đó; báo cáo cuối vẫn nói `failed at step 2` dù các bước sau đã xong. Model trong lượt này tự bù
bằng cách sửa `Table.search` ở bước 3, nhưng về nguyên tắc resume nên chạy lại bước `failed` trước khi đi tiếp.

## 6. `/compact` trên phiên có hội thoại thật

Sau khi phiên tích luỹ ~95k token đọc, `/compact` sinh bản nén đủ 5 đề mục:
`Goal` (mục tiêu + acceptance criteria), `## Completed steps`, `## Current state`, `## Open risks and next step`
(cùng `Constraints` và `Acceptance criteria` ở phần đầu). Bản nén giữ nguyên tiêu chí chấp nhận và danh sách bước còn lại.

## 7. `/fix` chạy trong TUI

Sau `/triage` route `fix` bị từ chối, chạy trực tiếp `/fix subtract() trong tinydb/operations.py dang cong thay vi tru: …`:

```text
diff được in trong transcript (dòng `+` / `-`), kèm báo cáo:
Not fixed: could not reproduce the bug: no failing test was submitted with submit_repro.
The bug was not reproduced.
Last test result: passed 236, failed 0, skipped 1, collection errors 0
Next step: add exact reproduction steps or a failing test to the issue.
Files changed: tests/test_subtract_repro.py (left in place for review).
```

Đây là hành vi fail-closed đúng: test tái hiện do agent viết lại **pass** trên TinyDB hiện tại, nên workflow không tuyên bố đã sửa.
Chưa thấy câu hỏi "Giữ bản sửa?" trong lượt này vì kết quả là `not fixed` (nhánh đó chỉ hỏi khi đã sửa được).

## 8. Việc chưa kiểm được trong lượt này

- `/ask` với citation bấm mở file và câu trả lời "không tìm thấy": **chưa kiểm được vì môi trường**, không phải vì code TUI.
  Trong lượt kiểm, `POST http://127.0.0.1:11434/api/embed` của ollama treo (curl timeout 20–30 s) trong khi
  `GET /api/tags` vẫn trả lời trong 10 ms; gọi `keep_alive: 0` để dỡ model thì embed chạy lại được một lần (55 s,
  phần lớn là load model) rồi treo tiếp. Axiom không đặt timeout cho lời gọi embed, nên TUI đứng ở `Đang xử lý…`
  với 0 token, trace chỉ có `run_start`. Đường code này đã được kiểm ở nơi khác: `tests/rag-search.test.ts`
  (server HTTP giả), `tests/citation-*`, và eval UC-02 thật trong `docs/eval-run-1.json` (recall@5 0.8077,
  107/107 citation hợp lệ) — nhưng **không** thay thế được việc bấm link trong TUI.
  Việc cần làm: thêm timeout/huỷ cho lời gọi embed và một luồng kiểm `/ask` trên TUI khi ollama khoẻ.
- `/fix` hiển thị câu hỏi "Giữ bản sửa?" và tiến trình `n/5`: chỉ thấy khi có vòng sửa thật; lượt này bug không tái hiện được nên
  dừng ở `not fixed`. Phần renderer đã có test riêng (`tests/tui-diff-*`, `tests/tui-fix-progress*`).
- Auto-compaction tại ngưỡng 60%: kiểm bằng case `uc04-compaction` trong eval; `/compact` thủ công thì đã kiểm ở mục 6.
