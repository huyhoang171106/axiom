#!/usr/bin/env bash
# scripts/ci-local.sh - Run local CI suite before merge/push
# Replaces remote GitHub Actions (due to private repo quota) with local verification.
set -euo pipefail

echo "=========================================="
echo "          Axiom Local CI Suite            "
echo "=========================================="

# 0. Detect Python for pytest/bwrap sandbox tests
if [ -z "${AXIOM_PYTHON:-}" ]; then
  if [ -x "$HOME/.axiom/venv/bin/python" ]; then
    export AXIOM_PYTHON="$HOME/.axiom/venv/bin/python"
  elif [ -x "$HOME/.axiom/venv/bin/python3" ]; then
    export AXIOM_PYTHON="$HOME/.axiom/venv/bin/python3"
  fi
fi

# 1. Secret & sensitive files guard
echo "==> [1/6] Checking for sensitive files..."
if git status --porcelain | grep -E '^(\?\?|A|M)[[:space:]]+(\.env|\.env\.local|.*\.pem|.*\.key)$' >/dev/null 2>&1; then
  echo "ERROR: Sensitive file (.env, *.pem, *.key) detected in git status! Refusing to continue." >&2
  exit 1
fi

# 2. Anti-cheat guard: detect test tampering or stealth test skips
echo "==> [2/6] Checking for test tampering or stealth skips..."
BASE_REF="origin/main"
if git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  # Detect adding .skip or skip: true in test files
  if git diff "$BASE_REF...HEAD" -- tests/ 2>/dev/null | grep -E '^\+[[:space:]]*.*(\.skip\(|skip:[[:space:]]*true)' >/dev/null 2>&1; then
    echo "ERROR: Test tampering detected! Added '.skip' or 'skip: true' in tests/." >&2
    echo "AI agents are forbidden from disabling or skipping existing tests." >&2
    exit 1
  fi
  # Detect removing assertions in existing tests
  if git diff "$BASE_REF...HEAD" -- tests/ 2>/dev/null | grep -E '^\-[[:space:]]*assert(\.|\()' >/dev/null 2>&1; then
    echo "ERROR: Test tampering detected! Assertions removed from tests/." >&2
    echo "AI agents are forbidden from weakening or deleting test assertions." >&2
    exit 1
  fi
fi

# 3. Typecheck & Lint
echo "==> [3/6] Running lint (tsc --noEmit)..."
npm run lint

# 4. Test suite
echo "==> [4/6] Running test suite (npm test)..."
npm test

# 5. Build
echo "==> [5/6] Running build (tsc)..."
npm run build

# 6. Eval smoke check (fail-closed, no swallowing errors)
echo "==> [6/6] Running eval smoke check (fail-closed)..."
if npm run | grep -q 'eval'; then
  npm run eval --if-present -- --uc 01 --mock
fi

echo "=========================================="
echo "  All local CI checks PASSED successfully! "
echo "=========================================="
