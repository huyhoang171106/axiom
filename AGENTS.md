# AGENTS.md

Read this file before every task. **Working code only. Finish the job. Plausibility is not correctness.**

Always read these two files too (Claude Code loads them through the imports below):

@docs/CONVENTIONS.md
@docs/DESIGN.md

Tools that do not read AGENTS.md: `ln -s AGENTS.md CLAUDE.md` (or `GEMINI.md`).

## Project

Axiom (SE373 Đề tài 01): an LLM tool-use loop over a local workspace, with cost tracking, sessions and sandboxed tools.

- TypeScript (ESM), Node >= 22, npm. Runtime deps: `package.json` `dependencies` (Ink, React, zod, LangGraph); a new one needs a decision-log row.
- Source: `src/{cli,core,llm,tools}`. Entry: `bin/axiom.ts`. Tests: `tests/*.test.ts` (`node:test` via tsx).
- Do not edit: `dist/` (build output), `node_modules/`.
- Repo: `github.com/se373agenticengineering/nhom-30` (remote `origin`). Team: 5 people, lanes A–E. Docs are Vietnamese; code, comments, commits are English.

## Where things are

| Need | File |
|---|---|
| Topic spec (UCs, schemas such as IssueTicket, grading) | `2026-10-06_de_tai_01_coding_agent.md` |
| Architecture, owners, decision log | `docs/DESIGN.md` |
| Naming, layout, import direction, git, tests | `docs/CONVENTIONS.md` |
| Phase overview, seams, done criteria | `docs/plans/phase-2.md` |
| One person's tasks | `docs/plans/phase-2-{A,B,C,D,E}.md` |
| Provider / TUI rules | `docs/guides/providers.md`, `docs/guides/tui.md` |

If a doc and the code disagree, stop and ask. Do not pick one silently.

## Task workflow

1. Find the task ID (e.g. `B2`) in your lane file. Do only that task, in lane order. Skip rows marked `done`.
2. Need another lane's code that is not on `main` yet? Use the fake listed in the "Seam" table. Never write the other lane's part yourself.
3. Branch `<lane>/<task-id>-<slug>` from `main`. Touch only your lane's files; shared files are append-only (`CONVENTIONS.md`, Git).
4. Signatures in a guide or the Seam table are contracts: copy them exactly, never change them.
5. Finish with "Done means" below and set the task row to `done` in your lane file.
6. Ship it yourself: `scripts/ship.sh`. It enforces Conventional Commits, runs the full local CI suite (`npm run ci:local`), pushes, opens the PR, verifies the PR title, and merges via merge commit. Remote GitHub Actions CI is disabled; local CI is mandatory for every change.

## Commands

- Install: `npm install`
- Run: `npm start`
- Test one file: `npx tsx --test tests/core.test.ts`
- Test all: `npm test`
- Lint + typecheck: `npm run lint` (`tsc --noEmit`)
- Build: `npm run build`
- Full Local CI: `npm run ci:local` (sensitive files check, lint, test, build, eval smoke)

Use single-file tests while you iterate. Run the full check at the end.

## Done means

1. `npm run ci:local` passes completely (sensitive files, `npm run lint`, `npm test`, `npm run build`, eval smoke). Read the output; do not assume.
2. New behavior or a bug fix has a test that fails without the change.
3. If a check fails, fix the cause, not the test.

## Always

- Follow `docs/CONVENTIONS.md` and `docs/DESIGN.md` (imported at the top). Read `docs/plans/phase-N.md` for the current tasks.
- Before you write code for these parts, read the guide completely and follow its steps in order. Its "PHẢI" (MUST) and "KHÔNG ĐƯỢC" (MUST NOT) rules are mandatory.
  - Provider, model, login, API key, secrets: `docs/guides/providers.md`
  - TUI, slash commands, headless commands: `docs/guides/tui.md`
- Send every tool call through `ToolRegistry.executeTool` and `decide()` in `src/tools/permissions.ts`.
- Run and pass `npm run ci:local` locally before pushing or shipping any change. Remote GitHub Actions CI is not used.
- Read the files you change and their callers. Match existing patterns.
- State the plan in 1–2 sentences before editing. For non-trivial work, list steps with a check for each.
- Fix root causes. Suppressing an error is not a fix.

## Ask first

- The request has two plausible readings that change the output.
- A change touches a design decision. To change one, first add a row to "Nhật ký quyết định" in `docs/DESIGN.md`.
- You need a credential, secret, or production resource.
- The stated goal and the literal request conflict.

Proceed without asking when the task is trivial and reversible, or when reading code or running a command resolves the doubt.

## Never

- Add a tool path that skips `executeTool` / `decide()`.
- Put an API key value in code, logs, traces, tests, or commits. Only `.env.example` is committed.
- Fabricate file paths, hashes, APIs, or test results. Check, or say "I don't know".
- Make drive-by refactors, reformatting, or cleanups outside the request. Do remove orphans your own change creates.
- Add features, abstractions, config, or error handling for cases nobody asked for or that cannot happen.
- Hardcode a model name in `src/` (use `resolveModel('@role')`), or call the network in tests.
- Commit on `main`, push or force-push `main`, or commit `.env`, `dist/`, traces, logs.
- Import `tui/` from `commands/` or `agents/`, or call `console.log` in `src/tui/`.

## Style

- No flattery or filler. Start with the answer or the action.
- If the user's premise is wrong, say so before doing the work.
- Direct and concise. Give a recommendation, not a survey.
- Commits: Conventional Commits, `type(scope): subject` under 72 chars, body explains why (`docs/CONVENTIONS.md` mục 9).
- After two failed fixes for the same issue, stop, summarize what you learned, and ask for a reset.

## Project Learnings

When the user corrects your approach, add a concrete one-line rule here ("Always use X for Y"). Tighten an existing line instead of adding a duplicate. Remove lines that no longer apply.

- Với code do An yêu cầu, viết comment tiếng Việt giải thích rõ cách hoạt động để dễ đọc về sau; giữ tên API theo contract hiện có.
- Bắt buộc chạy và kiểm tra toàn diện trên local qua `npm run ci:local` (hoặc `scripts/ship.sh`) trước khi merge; tuyệt đối không dựa vào GitHub Actions remote.
- After a PR that closes a task issue merges, tick every verified acceptance checkbox in that issue (`gh issue edit -R se373agenticengineering/nhom-30`); leave one unticked only with a comment saying why.
- Chỉ commit khi An yêu cầu rõ ràng; yêu cầu tạo branch, viết code hoặc chạy test không cho phép tự commit/push/merge.
