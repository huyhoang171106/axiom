# Axiom (core)

Coding-agent CLI: an LLM tool-use loop over a local workspace.

- `src/core/` agent loop, sessions + checkpoints, state machine, event bus, repetition guard
- `src/llm/` Anthropic / OpenAI(-compatible) / mock providers, cost tracker
- `src/tools/` bash (sandboxed), read, write, edit, approval permissions
- `src/cli/` minimal CLI

```
npm install
ANTHROPIC_API_KEY=... npm start -- "fix the failing test"   # or OPENAI_API_KEY with activeProvider=openai in ~/.axiom/config.json
npm start -- --mock "hello"                                  # no key needed
npm test
```

Risky tool calls ask for approval; `--yes` disables the prompt.
