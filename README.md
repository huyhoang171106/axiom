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

The `search_code` tool needs [ripgrep](https://github.com/BurntSushi/ripgrep#installation) (`rg`) on `PATH` (Windows: `winget install BurntSushi.ripgrep.MSVC`).

Files under `~/.axiom` (`AXIOM_HOME` moves it), see `docs/guides/providers.md` section 8:

| File | Holds |
|---|---|
| `config.json` | `modelRoles`, last used `defaultModel`, `disabledProviders`, `enabledProviders` |
| `auth.json` | Credentials from `/login` (mode 0600) |
| `models.json` | Your own providers and base URL overrides |
| `models-cache.json` | Model lists from discovery (24 h) |
| `.env` | Provider keys as env vars; the project's `.env` is never read |

## Target repo

`workspace/tinydb/` is an unmodified snapshot (no `.git`) of the repo the agent works on.

| | |
|---|---|
| Repo | [msiemens/tinydb](https://github.com/msiemens/tinydb) |
| Version | tag `v4.9.0`, commit `1e39ad3a2d9eca57efd9019fd089b5a04676da95` |
| License | MIT (`workspace/tinydb/LICENSE`) |
| Size (`cloc`, Python code lines) | 2111: `tinydb/` 809, `tests/` 1302 |
| Tests | pytest (`pytest.ini` adds `--cov`, so it needs `pytest-cov`) |

```
cd workspace/tinydb
python -m venv .venv                     # then use .venv/bin/python, or .\.venv\Scripts\python on Windows
.venv/bin/python -m pip install "pytest~=9.0" "pytest-cov~=7.0" "pyyaml~=6.0"
.venv/bin/python -m pytest -q
```

Seeded bugs for UC-03 live in `evals/issues/bug-NN/` (`issue.md`, `bug.json`, hidden `test_hidden.py`). Python comes from `AXIOM_PYTHON`:

```
npx tsx evals/issues/bugs.ts seed bug-01 /tmp/bug-01    # buggy copy outside the repo, for the agent
npx tsx evals/issues/bugs.ts grade bug-01 /tmp/bug-01   # run the hidden test (exit 0 = fixed)
npx tsx evals/issues/bugs.ts check                      # each hidden test passes on the original, fails on its bug
```
