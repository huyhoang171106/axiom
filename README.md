# Axiom (core)

Coding-agent CLI: an LLM tool-use loop over a local workspace.

- `src/core/` agent loop, sessions + checkpoints, state machine, event bus, repetition guard
- `src/llm/` Anthropic / OpenAI(-compatible) / mock providers, cost tracker
- `src/tools/` bash (sandboxed), read, write, edit, approval permissions
- `src/cli/` minimal CLI

```
npm install
npm start -- login deepseek                  # paste a key (or set DEEPSEEK_API_KEY); `login` alone lists all providers
npm start -- models                          # models of the 87 supported providers; `models find <text>`, `models refresh`, `--json`
npm start -- model role default zai/glm-5.3  # model per role, saved in config.json
npm start -- -p "fix the failing test"
npm start -- --mock "hello"                  # no key needed
npm test
```

Risky tool calls ask for approval; `--yes` disables the prompt.

Files under `~/.axiom` (`AXIOM_HOME` moves it), see `docs/guides/providers.md` section 8:

| File | Holds |
|---|---|
| `config.json` | `modelRoles`, last used `defaultModel`, `disabledProviders`, `enabledProviders` |
| `auth.json` | Credentials from `/login` (mode 0600) |
| `models.json` | Your own providers and base URL overrides |
| `models-cache.json` | Model lists from discovery (24 h) |
| `.env` | Provider keys as env vars; the project's `.env` is never read |
