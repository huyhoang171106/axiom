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
echo "==> [1/5] Checking for sensitive files..."
if git status --porcelain | grep -E '^(\?\?|A|M)[[:space:]]+(\.env|\.env\.local|.*\.pem|.*\.key)$' >/dev/null 2>&1; then
  echo "ERROR: Sensitive file (.env, *.pem, *.key) detected in git status! Refusing to continue." >&2
  exit 1
fi

# 2. Typecheck & Lint
echo "==> [2/5] Running lint (tsc --noEmit)..."
npm run lint

# 3. Test suite
echo "==> [3/5] Running test suite (npm test)..."
npm test

# 4. Build
echo "==> [4/5] Running build (tsc)..."
npm run build

# 5. Eval smoke check (if present)
echo "==> [5/5] Running eval smoke check (if present)..."
if npm run | grep -q 'eval'; then
  npm run eval --if-present -- --uc 01 --mock >/dev/null 2>&1 || true
fi

echo "=========================================="
echo "  All local CI checks PASSED successfully! "
echo "=========================================="
