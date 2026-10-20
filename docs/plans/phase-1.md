# Phase Plan 1 — Bootstrap

| | |
|---|---|
| Thời gian | Slide: 07/10–27/10 (đã qua hạn). Làm bù **trong 1 ngày: 28/10**, một mạch, một mốc |
| Tag | `v0.1-phase1` khi xong mọi task (nộp lớp + đủ provider) |
| Người làm | 5 SV: A, B, C, D, E. Phân công: `phase-1-{A,B,C,D,E}.md` |
| Repo | `https://github.com/huyhoang171106/new_harness`, nhánh `main` |
| Đọc kèm | `AGENTS.md`, `docs/CONVENTIONS.md`, `docs/DESIGN.md`, `docs/guides/providers.md`, `docs/guides/tui.md` |

| Làn | Người | Phần |
|---|---|---|
| A | _(điền tên)_ | UC-01 Triage, eval, prompt (skill + `AGENTS.md`), 5 wire, đăng nhập kiểu hook (3 luồng) |
| B | _(điền tên)_ | Catalog, credential + refresh, resolver, `/login`, đăng nhập API key / cloud / device code (4 luồng) |
| C | _(điền tên)_ | Target repo, tool tìm kiếm, secret, seeded bugs, đăng nhập OAuth code (9 luồng) |
| D | _(điền tên)_ | Khung chung (D0), CI, router, headless, trace, 4 wire |
| E | _(điền tên)_ | TUI (Ink), màn hình duyệt, footer, telemetry, 3 wire Google |

## Đã xong (không làm lại)

- Đăng ký nhóm với GVTH.
- Refactor nền: tên tool theo §4.1, policy `decide()` allow/ask/deny, Approver `approve|deny|editedArgs`, `ToolRegistry(allowed)`, `AgentLoop` nhận `systemPrompt`/`model`, giữ `tc.id`. 12/12 test pass.
- Có sẵn: agent loop, provider Anthropic/OpenAI, `MockProvider`, cost tracker, sandbox, session, repetition guard, 4 tool `read_file` `write_file` `edit` `run_command`.
- Tài liệu: `AGENTS.md`, `docs/`.
- CI/CD: `ci.yml` (lint, test, eval khi có script, gitleaks), `pr-title.yml`, `release.yml` (tag `v*` → GitHub Release), Dependabot, `.env.example`, `.env` trong `.gitignore`. `main` được bảo vệ: chỉ merge qua PR có CI xanh, PR tự merge khi xanh (`--auto`).

## Yêu cầu của lớp còn lại

| Yêu cầu | Task |
|---|---|
| 1 skill | A2 |
| Log từng bước | D3 (trace JSONL) |
| 1 UC chạy từ ứng dụng tới agent, ≥ 10 eval case | A1–A5, D2, E4 |

Thêm của nhóm: Axiom dùng được hằng ngày ("Bản dùng được") và đủ 87/91 provider (`providers.md`).

## Một mạch, không ai chờ ai

```
 Bắt đầu ──┬─ D: D0 khung chung (~1 giờ) ──► merge ──► D2 → D3 → D4 ──────────────────┐
           ├─ A: A1 eval case + SKILL.md ─────────────► A2 → A3 → A4 → A5 → A6 → A7 ───┤
           ├─ B: B1 script sinh catalog ──────────────► B2 → B3 → B4 → B5 ─────────────┤
           ├─ C: C1 target repo, C2 tool tìm kiếm ────► C3 → C4 → C5 ──────────────────┼─► Ghép
           └─ E: E1 store (TS thuần) ─────────────────► E2 → E3 → E4 → E5 → E6 ────────┘
```

- **Điểm đồng bộ duy nhất là D0**, ở đầu ngày. Trong lúc D làm D0, task đầu của A, B, C, E không cần file D0 tạo (A1 JSON + SKILL.md, B1 script + JSON, C1–C2 repo + tool mới, E1 store dùng `EventBus` có sẵn), nên không ai ngồi chờ.
- Sau D0, mọi hàm dùng chéo giữa các làn **đã tồn tại dưới dạng stub**. Người dùng gọi stub ngay. Khi chủ làn điền thân và merge, người dùng tự có bản thật, không phải sửa gì.
- Không có checkpoint chờ nhau. Mỗi task xong là mở PR, CI xanh là merge.
- Lúc chạy thử với model thật, nếu stub chưa có thân: test dùng `MockProvider` hoặc server giả (bảng Seam).

Quy tắc:
- **Chỉ sửa file trong làn của mình.** File chung do D0 tạo; sau đó ai cũng chỉ điền thân file mình được giao. Phải sửa file chung thì chỉ thêm dòng (`CONVENTIONS.md` mục Git).
- **Chữ ký trong guide và bảng D0 là hợp đồng.** Không ai đổi. Muốn đổi: ghi "Nhật ký quyết định" trong `DESIGN.md` và báo người dùng.
- **Branch và PR (bắt buộc):** mỗi task một branch từ `main` (`b/b2-resolver`). Tự mở PR với auto-merge, CI xanh thì GitHub tự merge (merge commit, giữ nguyên lịch sử commit), không chờ người review. Lệnh: `CONVENTIONS.md` mục Git.
- Mỗi commit: `npm run lint && npm test` pass.

## D0 tạo sẵn

Thân stub trả giá trị rỗng hoặc `throw new Error('chưa làm')`. Chữ ký copy nguyên văn từ guide.

| File | Nội dung D0 | Người điền thân |
|---|---|---|
| `package.json`, `tsconfig.json` | `zod`, `ink`, `react`, `@types/react`; `"jsx": "react-jsx"`; script `eval` → `tsx evals/run.ts` | — |
| `src/core/types.ts` | `'plan' \| 'review'` vào `ModelRole`; `disabledProviders`, `enabledProviders` vào `AxiomConfig` | — |
| `src/llm/catalog/index.ts` | Kiểu `ModelInfo`, `WireApi`, `Catalog`; `loadCatalog` stub (`providers.md` bước 2). Import bằng `'../llm/catalog/index.js'` | B1 |
| `src/llm/model-resolver.ts` | `resolveModel`, `createProviderFor` (`providers.md` bước 4). Stub **giữ hành vi hiện tại**: đọc `loadConfig()` và gọi `createProvider` có sẵn, không throw | B2 |
| `src/llm/provider-factory.ts` | Bảng `WIRES` đủ 14 wire: 2 wire cũ trỏ class có sẵn, 12 wire mới trỏ stub | — |
| `src/llm/providers/<wire>.ts` × 12 | Class kế thừa `BaseLLMProvider`, `chat` throw `'chưa làm'` | A6, D4, E6 |
| `src/core/secrets.ts` | `SECRET_NAME`, `scrubEnv`, `registerSecret`, `redact` (`providers.md` bước 1); stub trả nguyên đầu vào | C3 |
| `src/core/prompt.ts` | `buildSystemPrompt(base: string, workspaceRoot: string): string` = `base` + `skillsIndex()` + `loadProjectRules(workspaceRoot)` | — (xong ở D0) |
| `src/core/skills.ts` | `skillsIndex(): string` trả `''` | A2 |
| `src/core/project-rules.ts` | `loadProjectRules(workspaceRoot: string): string` trả `''` | A2 |
| `src/core/trace.ts` | `startTrace(bus: EventBus): { runId: string; close(): void }` không làm gì | D3 |
| `src/commands/types.ts` | Nguyên văn `tui.md` mục 9 (import `ModelInfo` từ `catalog/index.js`) | — |
| `src/commands/router.ts` | `parseCommand`, `CommandRouter` stub (`tui.md` bước 2) | D2 |
| `src/commands/index.ts` + `{help,clear,exit,triage,login,logout,model,models}.ts` | Đăng ký đủ 8 lệnh; mỗi lệnh `run` throw `'chưa làm'`. `clear`/`exit` trả `CommandResult` với `kind: 'clear'`/`'exit'`, TUI và headless tự xử lý | D2 (`help` `clear` `exit`), A5 (`triage`), B3 (còn lại) |
| `src/llm/auth/engines/index.ts` | Kiểu `Credential`, `LoginEngine = (provider: ProviderEntry, ui: CommandUI) => Promise<Credential>`; bảng `LOGIN_ENGINES` theo kiểu `login` trong catalog: `api-key`, `oauth-code`, `device-code`, `cloud-fields`, `hook`; mỗi engine là 1 file stub | B3 (`api-key`), B4 (`cloud-fields`), B5 (`device-code`), C5 (`oauth-code`), A7 (`hook`) |
| `src/cli/agent.ts` | `createAgent(opts: { workspaceRoot: string; mock?: boolean; signal?: AbortSignal }): Promise<AgentLoop>`: `buildSystemPrompt` + `resolveModel('@default')` + `createProviderFor` + `startTrace(agent.eventBus)`. Headless và TUI đều tạo agent qua hàm này | — |
| `src/tui/index.tsx` | `startTui(argv: string[]): Promise<void>` stub: chạy REPL cũ | E4 |
| `src/cli/index.ts`, `bin/axiom.ts` | Headless dùng `createAgent`; TTY và không `-p` → `startTui(argv)` | — |
| `evals/run.ts` | In "chưa có eval", exit 0 | A4 |

## Seam (trước khi có thân thật)

| Gọi | Của | Trước khi có thân, test bằng |
|---|---|---|
| `resolveModel`, `createProviderFor` | B2 | Truyền `MockProvider` trực tiếp |
| `registerSecret`, `redact` | C3 | Stub D0 (không làm gì) |
| `workspace/<repo>` | C1 | Thư mục tạm (`fs.mkdtemp`) |
| `CommandRouter` | D2 | Gọi `command.run(args, ctxGiả)` trực tiếp |
| Credential store | B2 | `AXIOM_HOME` tạm + file `auth.json` giả |
| `LOGIN_ENGINES` | B3, B4, B5, C5, A7 | Engine nào chưa có thân thì `/login` báo "chưa hỗ trợ" |
| Refresh token | B2 | Credential giả chưa hết hạn trong `AXIOM_HOME` tạm |
| Wire class | Chủ wire | Gọi class trực tiếp với server HTTP giả |

## Bản dùng được

- [ ] `npm install && npm start` mở TUI. Chưa có key thì TUI chỉ cách `/login`, không crash.
- [ ] `/login <provider>` bằng API key, OAuth hoặc subscription → `/model` → chat.
- [ ] 87 provider chạy được, `axiom models` liệt kê đúng.
- [ ] Agent đọc, tìm, sửa code, chạy test trong workspace; thấy từng tool call.
- [ ] Lệnh rủi ro hỏi y/n. Đọc `.env` bị chặn, hiện lý do.
- [ ] `Esc` dừng agent. `Ctrl+C` hai lần thì thoát.
- [ ] Footer: model, token, cost, % context. Sau mỗi lượt có telemetry.
- [ ] `/triage <issue>` ra IssueTicket. `axiom -p "..."` chạy headless.
- [ ] README: cài đặt, đăng nhập, lệnh cơ bản.

Được phép thiếu: resume phiên, diff viewer, sửa-rồi-duyệt, `/settings`, renderer Ink riêng cho IssueTicket (TUI in `CommandResult.text`), UC khác ngoài UC-01.

## Tiêu chí xong

- [ ] `npm run eval -- --uc 01`: 10 case, `type` đúng ≥ 80%, 100% hợp lệ schema; case injection không đổi hành vi.
- [ ] CI xanh, `gitleaks` sạch.
- [ ] TUI: chat tự do được, `/triage` ra IssueTicket.
- [ ] Mỗi run có trace JSONL, không chứa giá trị key.
- [ ] Mỗi wire có test server giả.

## Ghép (cuối ngày, D chủ trì)

1. Mọi PR đã merge. Chạy checklist "Bản dùng được".
2. README, video demo, `git tag v0.1-phase1 && git push origin v0.1-phase1` (workflow `release` tự tạo GitHub Release).

Video: `/login` → chat về target repo → `/triage` issue có stack trace → `/triage` issue mơ hồ (agent hỏi lại) → đọc `.env` bị chặn → mở trace → `npm run eval -- --uc 01`.

## Quy ước

- Eval runner tạo `CostTracker` mới cho mỗi case, không dùng `defaultCostTracker`.
- Role mới: `AgentLoop` với `systemPrompt`/`model` riêng và `ToolRegistry([...])` chỉ có tool của role.
- Model luôn lấy qua `resolveModel('@role')`.
- Wire mới: test server HTTP giả cho stream text, gọi tool, usage (`providers.md` bước 8).
