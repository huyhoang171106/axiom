# Hướng dẫn: Thiết kế TUI

Người làm giao diện terminal phải tuân theo file này. Bố cục và cách hiển thị học từ [pi-open-tui](https://github.com/OldSuns/pi-open-tui) (ảnh mẫu: `assets/preview_dashboard_1.png` của repo đó). Phần duyệt hành động, diff và slash command học từ Claude Code.

> **Quy tắc bản quyền.** Axiom tự dựng lại giao diện bằng **Ink**. Chỉ học bố cục của pi-open-tui, không chép code. Ghi nguồn tham khảo trong báo cáo.

Owner: **E** (khung TUI, màn hình duyệt, footer và telemetry). **D**: điểm vào, bộ lệnh (bước 1–2). **C**: diff viewer. Owner của mỗi UC tự làm phần hiển thị kết quả UC của mình.

**Cách dùng file này.** File này là hướng dẫn bắt buộc cho người và cho AI coding assistant viết code giao diện.
- Đọc hết file trước khi viết code. Phần "làm gì" ở mục 1–8. Phần "làm thế nào" ở mục 9–10.
- Làm theo đúng thứ tự các bước ở mục 10. Mỗi bước là một commit. Bước sau chỉ bắt đầu khi test của bước trước pass.
- "PHẢI" và "KHÔNG ĐƯỢC" là luật. Muốn làm khác thì ghi vào "Nhật ký quyết định" trong `docs/DESIGN.md` và hỏi owner trước.
- Interface ở mục 9 là hợp đồng giữa các thành viên. Đổi interface thì phải báo cả nhóm.

## 1. Bố cục màn hình

```
╭─ Axiom v0.1 ─────────────────────────────────────────────────────────╮
│        [logo]                                │ Welcome               │  ← Header (in 1 lần, rồi
│   Let's fix something                        │ Hỏi gì về repo cũng   │    trôi theo transcript)
│   openrouter/qwen3-coder · edit mode         │ được                  │
│   ~/nhom-30/workspace/tinydb                 │ Commands              │
│                                              │ /triage /fix /ask     │
╰──────────────────────────────────────────────────────────────────────╯
▌ sửa bug test_insert bị fail                                       ▐  ← tin nhắn user: khối nền
                                                                         màu, rộng hết dòng
~ think ⠋ đang đọc tinydb/table.py…                                     ← thinking peek, 1 dòng
● read_file tinydb/table.py  (0.1s)                                      ← tool call, thu gọn
● run_command pytest -q tests/test_tables.py  ✗ exit 1  (2.3s)
Lỗi nằm ở hàm `insert`: …                                               ← trả lời của assistant
> TPS 42 tok/s | TTFT 1.2s | 29.7s | ↑ 5.6k | ↓ 1.2k | $0.004            ← telemetry của lượt
╭──────────────────────────────────────────────────────────────────────╮
│ █                                                                    │  ← ô nhập, viền bo góc
╰──────────────────────────────────────────────────────────────────────╯
 ~/…/tinydb   main [!2 ?1]                     [███░░░░░░] 4.7% · 12k/252k  ← footer dòng 1
 openrouter · qwen3-coder · edit               ↑36k (U 4.6k + R 31k) ↓69 $0.041  ← footer dòng 2
```

| Vùng | Hiển thị | Owner |
|---|---|---|
| Header | Logo, câu chào, `provider/model · mode`, thư mục workspace. Cột phải: lời chào ngắn và 3–5 slash command hay dùng | E |
| Transcript | Tin nhắn user (khối nền màu), thinking peek, dòng tool call, trả lời assistant (markdown), thông báo hệ thống (màu mờ) | E |
| Telemetry lượt | Sau mỗi lượt agent: TPS, TTFT, thời gian, token vào/ra, cost | E |
| Ô nhập | Viền bo góc, nhiều dòng, gợi ý slash command | E |
| Footer dòng 1 | Trái: cwd, nhánh git, trạng thái git. Phải: thanh context, `% · dùng/tối đa` | E |
| Footer dòng 2 | Trái: provider, model, permission mode. Phải: token vào (U chưa cache + R đọc cache), token ra, cost phiên | E |

## 2. Luồng dữ liệu

TUI chỉ **đọc** sự kiện và **gửi** yêu cầu. TUI không gọi tool, không tự quyết định duyệt.

```
 phím ──► [Editor] ── text ──► [CommandRouter] ── "/lệnh" ──► handler của UC ─┐
                                     │                                         │
                                     └── chat tự do ──► AgentLoop.runTask() ◄──┘
                                                             │
                     EventBus: stream_token, thinking,       │
                     tool_call_start/end, cost_update,       ▼
                     state_change, error ──────────────► [TuiStore] ──► component Ink ──► màn hình
                                                             ▲
 ToolRegistry.approver (verdict = ask) ──► [ApprovalDialog] ─┘── approve | deny | editedArgs
```

- `TuiStore` là nơi duy nhất giữ state. Component đọc store bằng `useSyncExternalStore`, không subscribe EventBus trực tiếp.
- `CommandRouter` dùng chung với headless (`axiom <lệnh>`). TUI không có logic riêng của UC.
- Approver là một `Promise` mà `ApprovalDialog` resolve khi người dùng bấm phím. Đây là cùng interface `Approver` trong `src/tools/permissions.ts`.

## 3. Quy tắc hiển thị

**Transcript**
- Tin nhắn đã xong đưa vào `<Static>` của Ink để không vẽ lại. Chỉ lượt đang chạy là được vẽ lại.
- Tool call hiện **một dòng**: `● tên tham-số-chính (thời gian)`. `✓` hoặc `✗ lý do` khi kết thúc. Bấm `Ctrl+O` để mở rộng xem output đầy đủ.
- Tool bị policy chặn hiện màu đỏ: `⊘ run_command cat .env — bị chặn: secret file`.
- Thinking peek: chỉ hiện khi model thực sự stream phần suy nghĩ. Hiện 1 dòng là phần cuối của suy nghĩ, kèm spinner. Có câu trả lời thì đổi thành `~ think ✓`.

**Footer**
- Mỗi đoạn trong footer có một mức ưu tiên. Màn hình hẹp thì cắt đoạn có ưu tiên thấp trước. **Giữ nguyên phần bên phải** (context, cost), chỉ cắt phần bên trái.
- Thứ tự cắt bỏ (cắt trước nhất ở đầu danh sách): commit → trạng thái git → nhánh git → cwd thu thành tên thư mục cuối.
- Thanh context = token của lượt gần nhất / `contextWindow` của model. Từ 60% trở lên thì đổi màu vàng, vì đó là ngưỡng compaction của UC-04.
- Thiếu dữ liệu thì hiện `—`, không hiện số 0.

**Độ rộng chữ**
- Luôn đo bằng độ rộng hiển thị (`string-width`, Ink đã có sẵn). Không dùng `.length`. Tiếng Việt có dấu tổ hợp và icon rộng 2 ô sẽ làm lệch viền nếu đo sai.
- Cắt chữ thì thêm `…` và vẫn giữ màu ANSI đúng.

**Icon**
- Có 4 chế độ: `auto` · `nerd` · `unicode` · `ascii`. `auto` dùng Unicode khi stdout là TTY UTF-8, dùng ASCII khi `TERM=dumb` hoặc không phải TTY.
- Không mặc định dùng Nerd Font, vì máy chấm có thể không cài font đó.

**Màu**
- Mỗi màu có một vai trò: `accent`, `muted`, `success`, `warning`, `error`, `userBg`. Màu được khai báo ở một file theme duy nhất. Component không viết mã màu trực tiếp.
- Mọi trạng thái phải có thêm ký hiệu (`✓ ✗ ⊘ !`) bên cạnh màu, để người không phân biệt được màu vẫn đọc được.

## 4. Phím tắt

| Phím | Việc |
|---|---|
| `Enter` | Gửi |
| `Shift+Enter` hoặc `Alt+Enter` | Xuống dòng trong ô nhập |
| `/` | Mở gợi ý lệnh. `↑ ↓` để chọn, `Tab` để điền |
| `Esc` | Dừng lượt agent đang chạy (truyền `AbortSignal` vào `runTask`) |
| `Ctrl+C` hai lần | Thoát |
| `Shift+Tab` | Đổi permission mode: `read-only → edit → auto`. Footer hiện mode đang dùng |
| `Ctrl+O` | Mở rộng hoặc thu gọn output của tool |
| `↑` khi ô nhập rỗng | Lấy lại câu đã gửi trước đó |

## 5. Màn hình duyệt (UC-05)

```
╭─ Cần duyệt ─────────────────────────────────────────────╮
│ run_command   mức rủi ro: TRUNG BÌNH                    │
│ pip install requests                                    │
│ Lý do: cài dependency                                   │
│                                                         │
│ [y] Duyệt   [n] Từ chối   [e] Sửa rồi duyệt             │
╰─────────────────────────────────────────────────────────╯
```

- Trong lúc chờ duyệt, ô nhập bị khoá. Mặc định chọn **Từ chối**: bấm `Enter` mà chưa chọn thì tính là `n`.
- Với `edit` và `apply_patch`, hiện diff tô màu (C làm diff viewer). Diff dài quá 30 dòng thì thu gọn, bấm `Ctrl+O` để xem hết.
- Chọn `e` thì mở tham số ra để sửa, rồi trả về `{ editedArgs }`. Policy kiểm tra lại tham số đã sửa.

## 6. Cài đặt

- Lệnh `/settings` mở hộp cài đặt có các tab: Chung, Giao diện, Footer, Telemetry.
- Cài đặt lưu ở `~/.axiom/tui.json`. Mỗi mục của footer và telemetry có một cờ bật/tắt.
- Ngôn ngữ giao diện: `vi` (mặc định) và `en`.

## 7. Code

```
src/tui/
  app.tsx            # ghép các vùng, giữ focus, phím toàn cục
  store.ts           # TuiStore: nhận EventBus, giữ state
  theme.ts           # màu theo vai trò, bộ icon
  layout.ts          # hàm thuần: xếp và cắt footer, cắt chữ theo độ rộng
  components/        # Header, Transcript, ToolRow, Editor, Footer, Telemetry, ApprovalDialog, DiffView
src/commands/        # CommandRouter + mỗi lệnh một file, dùng chung với headless
```

- Logic xếp chỗ (footer, cắt chữ, telemetry) viết thành **hàm thuần** trong `layout.ts` và test bằng `node:test`. Component chỉ gọi hàm đó.
- Git status: harness chạy `git status --porcelain=v2 --branch` có timeout 1 giây và cache kết quả. Chạy lại sau mỗi tool call có ghi file. Lệnh này do TUI gọi, không đi qua agent.
- Không thêm thư viện test UI. Kiểm tra hiển thị bằng mắt và ghi ảnh chụp vào PR.

## 8. Phạm vi theo phase

| Phase | Phải có |
|---|---|
| 1 (bản dùng được) | Header, transcript stream, dòng tool call, ô nhập nhiều dòng, gợi ý slash command, footer 2 dòng, telemetry lượt, màn hình duyệt y/n, `Esc` để dừng, `/help /login /model /clear /exit /triage` |
| 2 | Màn hình duyệt đủ y/n/e có diff, `Shift+Tab` đổi mode, `/resume /memory /compact`, hiển thị trích dẫn cho `/ask`, tiến trình từng vòng của `/fix` |
| 3 | Panel review, `/tree` (cây phiên, rẽ nhánh), `/settings`, `/connect`, thinking peek 2 dòng |

## 9. Interface chung (hợp đồng giữa các thành viên)

File `src/commands/types.ts`. Mọi slash command (của TUI) và lệnh headless (`axiom <lệnh>`) dùng đúng interface này.

```ts
import type { AxiomConfig } from '../core/types.js';
import type { ModelInfo } from '../llm/catalog/index.js';

/** TUI và headless mỗi bên có một bản cài đặt riêng. Command không biết mình chạy ở đâu. */
export interface CommandUI {
  print(text: string): void;
  ask(question: string, opts?: { secret?: boolean }): Promise<string>; // headless không có TTY: throw
  confirm(question: string): Promise<boolean>;                          // headless không có TTY: false
}

export interface CommandContext {
  config: AxiomConfig;
  workspaceRoot: string;
  ui: CommandUI;
  signal: AbortSignal;
  session: { model: ModelInfo; setModel(info: ModelInfo): void };
}

/** Kết quả có cấu trúc. TUI vẽ theo `kind`. Headless in `text`, hoặc in `data` nếu có `--json`. */
export interface CommandResult {
  kind: string;   // ví dụ 'issue-ticket', 'review-report'
  data: unknown;
  text: string;
}

export interface Command {
  name: string;          // không có dấu '/'
  summary: string;       // 1 dòng, hiện trong gợi ý và /help
  usage: string;         // ví dụ '/triage <nội dung issue>'
  requires?: string[];   // connector cần có (Phase 3)
  run(args: string, ctx: CommandContext): Promise<CommandResult | void>;
}
```

Quy tắc:
- Một lệnh là một file trong `src/commands/`, export một `Command`. Đăng ký trong `src/commands/index.ts`.
- Lệnh của UC **không import** gì từ `src/tui/`. Muốn hiển thị riêng thì trả `CommandResult`, rồi thêm một renderer cho `kind` đó trong `src/tui/components/results/`.

## 10. Các bước làm (theo đúng thứ tự)

Lệnh kiểm tra sau **mỗi** bước: `npm run lint && npm test`. Cả hai phải pass rồi mới commit.

### Bước 1 — Thư viện và điểm vào

| | |
|---|---|
| Việc | `npm i ink react` và `npm i -D @types/react`. Thêm `"jsx": "react-jsx"` vào `tsconfig.json`. `bin/axiom.ts`: nếu stdout là TTY và không có `-p` thì mở TUI, ngược lại chạy headless (`src/cli/index.ts`). |
| KHÔNG ĐƯỢC | Thêm `pi-tui`, `blessed` hay thư viện TUI khác. Thêm thư viện test UI. |
| Kiểm tra | Thêm cờ `-p` cho headless. `npm start -- -p "hi" --mock` và cách cũ `npm start -- --mock "hi"` đều in kết quả. |

### Bước 2 — Bộ lệnh

| | |
|---|---|
| File | `src/commands/types.ts` (mục 9), `router.ts`, `index.ts`, `help.ts`, `clear.ts`, `exit.ts` |
| Interface | `export function parseCommand(input: string): { name: string; args: string } \| null` (chỉ khi bắt đầu bằng `/`)<br>`export class CommandRouter { register(c: Command): void; get(name: string): Command \| undefined; list(): Command[]; complete(prefix: string): Command[] }` |
| PHẢI | Headless `axiom triage "..."` và TUI `/triage ...` gọi cùng `router.get('triage').run(...)`. Lệnh không tồn tại thì báo lỗi kèm gợi ý gần nhất từ `complete`. |
| Test | `parseCommand('/triage  abc')` → `{name:'triage', args:'abc'}`. `parseCommand('hello')` → `null`. `complete('/tr')` có `triage`. |

### Bước 3 — Theme và layout (hàm thuần)

| | |
|---|---|
| File | `src/tui/theme.ts`, `src/tui/layout.ts` |
| Interface | `export function visibleWidth(s: string): number`<br>`export function truncate(s: string, width: number): string` (thêm `…`, giữ ANSI)<br>`export interface Segment { text: string; priority: number; compact?: string }`<br>`export function fitFooterLine(left: Segment[], right: string, width: number): string` |
| PHẢI | Đo bằng `string-width` (có sẵn khi cài Ink). Có `NO_COLOR` thì tắt màu. Cắt `left` theo `priority` thấp trước, giữ nguyên `right` (mục 3). |
| Test | Chuỗi tiếng Việt có dấu và icon rộng 2 ô cắt đúng độ rộng. Màn hình 40 cột vẫn giữ nguyên phần `right`. |

### Bước 4 — Store

| | |
|---|---|
| File | `src/tui/store.ts` |
| Interface | `export class TuiStore { attach(bus: EventBus): () => void; subscribe(fn: () => void): () => void; getSnapshot(): TuiState; ... }`<br>`TuiState`: `entries` (lượt đã xong), `live` (lượt đang chạy: text, thinking, tool rows), `usage`, `model`, `mode`, `pendingApproval` |
| PHẢI | Gộp `stream_token` và chỉ báo vẽ lại tối đa 30 lần mỗi giây. `getSnapshot()` trả cùng một object khi state không đổi (yêu cầu của `useSyncExternalStore`). |
| Test | Đưa một chuỗi sự kiện giả vào `EventBus`, kiểm tra `TuiState` sau cùng. |

### Bước 5 — Component và app

| | |
|---|---|
| File | `src/tui/app.tsx`, `src/tui/components/*.tsx` |
| PHẢI | Lượt đã xong nằm trong `<Static>`. Ô nhập: `Enter` gửi. Nhiều terminal không phân biệt được `Shift+Enter`, nên có thêm `Alt+Enter`, và `\` ở cuối dòng rồi `Enter` để xuống dòng. |
| KHÔNG ĐƯỢC | Gọi `console.log` trong `src/tui/` (làm vỡ màn hình Ink). Gọi tool hoặc `decide()` từ component. |
| Kiểm tra | Chạy `npm start -- --mock`, chụp màn hình ở 80 và 120 cột, đính kèm vào PR. |

### Bước 6 — Màn hình duyệt

```
 AgentLoop        ToolRegistry          TuiStore            ApprovalDialog      Người dùng
    │ executeTool ─────►│                    │                     │                 │
    │                   │ decide() = ask     │                     │                 │
    │                   │ approver(req) ────►│ pendingApproval=req │                 │
    │                   │                    │ ───── vẽ ──────────►│ ─── hiện ──────►│
    │                   │                    │                     │◄──── y / n ─────│
    │                   │◄──── resolve('approve' | 'deny') ────────│                 │
    │                   │ chạy tool hoặc từ chối, ghi metadata.policy                │
    │◄── ToolResult ────│                    │ pendingApproval=null│                 │
```

| | |
|---|---|
| PHẢI | `registry.approver = (req) => new Promise(resolve => store.requestApproval(req, resolve))`. `Enter` khi chưa chọn = `deny`. Ô nhập bị khoá trong lúc chờ. |
| KHÔNG ĐƯỢC | Đặt `allowWithoutApprover = true` trong TUI. |

### Bước 7 — Dừng và thoát

| | |
|---|---|
| PHẢI | Mỗi lượt có một `AbortController`, truyền `signal` vào `runTask(prompt, signal)`. `Esc` gọi `abort()`. `Ctrl+C` lần 1: dừng lượt hoặc xoá ô nhập, hiện "Bấm Ctrl+C lần nữa để thoát". Lần 2 trong vòng 2 giây: thoát. Khi thoát phải trả terminal về trạng thái bình thường. |
| Kiểm tra | Bấm `Esc` lúc agent đang stream: lượt dừng, footer hiện `aborted`, gõ tiếp được ngay. |

### Bước 8 — Footer và telemetry (D)

| | |
|---|---|
| PHẢI | TTFT = thời điểm có `stream_token` đầu tiên trừ thời điểm gửi. TPS = token ra chia thời gian sinh text (không tính thời gian chạy tool). Thanh context = token vào của lượt gần nhất chia `ModelInfo.contextWindow`. Git status theo mục 7. |
| Test | Cho `fitFooterLine` và hàm tính telemetry (đưa vào mốc thời gian giả). |

## 10.1. Checklist trước khi mở PR

- [ ] `npm run lint && npm test` pass.
- [ ] `grep -rn "console\.log" src/tui` không có kết quả.
- [ ] Ảnh chụp ở 80 và 120 cột, có cả trạng thái đang stream và màn hình duyệt.
- [ ] `axiom -p "..."` (headless) vẫn chạy được.
- [ ] Lệnh mới đã đăng ký trong `src/commands/index.ts` và hiện trong `/help`.
- [ ] Đổi interface ở mục 9 thì đã báo cả nhóm và ghi vào "Nhật ký quyết định" trong `docs/DESIGN.md`.
