# Conventions

Applies to everyone and every agent. New code follows it; old code changes only when touched. To change a rule, add a row to the decision log in `docs/DESIGN.md` first.

## Language

- `docs/`, plans, PRs, issues: Vietnamese. Code, identifiers, comments, commits, branches: English.
- Keep technical terms in English (`provider`, `wire`, `trace`).

## Writing (docs, PRs, comments)

- Say the point. No intro, no recap, no filler, no hype words.
- Be concrete: file, function, number, runnable command.
- Hedge only when it changes what the reader does.
- One fact in one place; elsewhere, link to it.
- Never invent facts, numbers, APIs, or test results.
- Edit proportionally; leave clear text alone.
- Rules: **PHẢI** / **KHÔNG ĐƯỢC**. Ordered steps: numbers. Multi-column data: tables. Data flow: ASCII diagram.
- No emoji, invisible characters, or smart quotes.

## Code comments

- Explain why (intent, constraint, trade-off), not what.
- File header: `// src/<path>.ts - <one line>`.
- Never describe behavior the code does not have.
- No commented-out code. `TODO(<task-id>)` only.

## Naming

| What | Style | Example |
|---|---|---|
| Files, folders | kebab-case | `model-resolver.ts` |
| Tests | `tests/<module>.test.ts` | `tests/policy.test.ts` |
| Classes, types | PascalCase, no `I` prefix | `ToolRegistry`, `ModelInfo` |
| Functions, variables | camelCase, functions start with a verb | `resolveModel`, `scrubEnv` |
| Booleans | `is`/`has`/`should`/`can` | `isSecretPath` |
| Module constants | UPPER_SNAKE | `DEFAULT_LIMIT` |
| Shared instances | `default` prefix | `defaultCostTracker` |
| Tool names | snake_case | `search_code` |
| Commands | lowercase, kebab-case if multi-word | `triage` |
| Provider, wire, skill IDs | kebab-case | `openai-responses` |
| JSON keys | camelCase | `contextWindow` |
| Env vars | UPPER_SNAKE, `AXIOM_` prefix for ours | `AXIOM_HOME` |

No vague names (`data`, `temp`, `handle`). Fields defined by the topic keep their names (`affected_files`).

## Layout

```
src/cli        argv, pick TUI or headless
src/commands   one Command per file; index.ts registers
src/tui        Ink only
src/agents     UC workflows
src/core       loop, events, session, prompt, skills, trace, secrets
src/llm        providers/ (one wire per file), catalog/ (JSON), auth/engines/
src/tools      one tool per file; registry, permissions, sandbox
skills/<id>/SKILL.md   evals/uc<NN>/   evals/issues/bug-<NN>/   workspace/<repo>/
```

Import direction: `cli → tui → commands → agents → core → llm, tools`. Never import backwards. `commands`/`agents` never import `tui`. `tui` never calls `console.log`, tools, or `decide()`. Every tool call goes through `executeTool` + `decide()`.

## TypeScript

- ESM, strict. Local imports end in `.js`; builtins use `node:`.
- `import type` for types. Named exports only.
- No `any`. External data is `unknown`, then zod or a type guard.
- 3+ optional params: one `opts` object.
- No model names in `src/`; they live in catalog JSON.
- New dependency only if a guide allows it or the decision log records it.

## Errors

- Tools return `isError: true` with a reason; they do not throw.
- Provider errors: `ProviderError`.
- User-fixable errors say the fix: `"Run /login openrouter"`.
- No silent `catch {}` without a comment.
- Logs, errors, traces pass through `redact`. Never a key value.

## Tests

- `node:test` + `node:assert/strict`. No other framework.
- Test names describe behavior.
- No real network (fake server on `127.0.0.1`), no real keys, no real `~/.axiom` (temp `AXIOM_HOME`).
- A bug fix comes with a test that fails without it.

## Git

- **Mandatory flow for every change, no exceptions:** branch → PR → merge it yourself.
  1. `git switch main && git pull && git switch -c <lane>/<task-id>-<slug>` (e.g. `b/b1-catalog`).
  2. Commit, then `git fetch && git rebase origin/main`, then `npm run lint && npm test`.
  3. `git push -u origin HEAD && gh pr create --base main --fill && gh pr merge --auto --squash`. GitHub merges it by itself when CI is green; no reviewer.
  4. CI red: fix on the same branch and push; auto-merge stays on. Then `git switch main && git pull`.
- `main` is protected: merges only through a PR with green `check`, `secrets`, `pr-title`. The PR title becomes the commit on `main`, so it must be `type(scope): subject`.
- Never commit on `main`. Never push or force-push `main`.
- Commits: `type(scope): subject` (imperative, ≤ 72 chars); body says why. Types: `feat fix refactor test docs ci chore perf`. Scope: folder or area (`core`, `llm`, `tools`, `policy`, `tui`, `triage`, `eval`).
- PR: commit-style title; body (Vietnamese) has task ID and how it was checked. Run the guide checklist before merging.
- Shared files, append only: `src/commands/index.ts`, `WIRES` in `src/llm/provider-factory.ts`, `.github/workflows/ci.yml`, `package.json`. Lockfile conflict: take `main`'s, rerun `npm install`.
- Never commit `.env`, `dist/`, `node_modules/`, traces, logs. Leaked key: revoke it at the provider first.
