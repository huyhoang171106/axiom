#!/usr/bin/env bash
# scripts/ci-local.sh - Run local CI suite before merge/push
# Strict gatekeeper with anti-cheat, secret scanning, and fail-closed traps.
set -Eeuo pipefail

trap 'echo "ERROR: Local CI execution failed at line $LINENO (command: $BASH_COMMAND)" >&2' ERR

echo "=========================================="
echo "          Axiom Local CI Suite            "
echo "=========================================="

# Helper to run each stage and verify explicit exit code
run_stage() {
  local stage_num="$1"
  local stage_name="$2"
  shift 2
  echo "==> [$stage_num] $stage_name..."
  local exit_code=0
  "$@" || exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    echo "ERROR: Stage [$stage_name] failed with exit code $exit_code!" >&2
    exit "$exit_code"
  fi
}

# 0. Detect Python and OS environment for pytest/sandbox tests
if [ -z "${AXIOM_PYTHON:-}" ]; then
  if [ -x "$HOME/.axiom/venv/bin/python" ]; then
    export AXIOM_PYTHON="$HOME/.axiom/venv/bin/python"
  elif [ -x "$HOME/.axiom/venv/bin/python3" ]; then
    export AXIOM_PYTHON="$HOME/.axiom/venv/bin/python3"
  elif [ -f "$HOME/.axiom/venv/Scripts/python.exe" ]; then
    export AXIOM_PYTHON="$HOME/.axiom/venv/Scripts/python.exe"
  elif [ -f "$HOME/.axiom/venv/Scripts/python" ]; then
    export AXIOM_PYTHON="$HOME/.axiom/venv/Scripts/python"
  fi
fi

# On Windows (Git Bash / MSYS), enable local execution for tests when bwrap is absent
if [[ "$(uname -s 2>/dev/null || true)" =~ ^(MINGW|MSYS|CYGWIN) ]]; then
  export AXIOM_ALLOW_LOCAL_TESTS="${AXIOM_ALLOW_LOCAL_TESTS:-1}"
fi

# 1. Secret & sensitive files guard (names + content scanning)
check_secrets() {
  # 1a. Sensitive file names
  if git status --porcelain | grep -E '^(\?\?|A|M)[[:space:]]+(\.env|\.env\.local|.*\.pem|.*\.key)$' >/dev/null 2>&1; then
    echo "ERROR: Sensitive file (.env, *.pem, *.key) detected in git status! Refusing to continue." >&2
    return 1
  fi
  # 1b. Content-based secret scanning in diff against origin/main
  local base="origin/main"
  if git rev-parse --verify "$base" >/dev/null 2>&1; then
    local secret_pattern='(sk-[a-zA-Z0-9]{20,}|sk-ant-[a-zA-Z0-9]{20,}|-----BEGIN[ A-Z]*PRIVATE KEY-----|ghp_[a-zA-Z0-9]{36}|xox[baprs]-[a-zA-Z0-9]{10,})'
    if git diff "$base...HEAD" 2>/dev/null | grep -E "^\+[[:space:]]*.*$secret_pattern" >/dev/null 2>&1; then
      echo "ERROR: Hardcoded API key or private key detected in commit diff! Refusing to continue." >&2
      return 1
    fi
  fi
}
run_stage "1/6" "Checking for secrets and sensitive files" check_secrets

# 2. Anti-cheat guard: detect test tampering, stealth skips, .only, or runner tampering
check_anti_cheat() {
  local base="origin/main"
  if git rev-parse --verify "$base" >/dev/null 2>&1; then
    # 2a. Detect adding .skip, skip: true, .only, only: true, or .todo in test files
    local skip_pattern='^\+[[:space:]]*.*(\.skip\(|skip:[[:space:]]*true|\.only\(|only:[[:space:]]*true|\.todo\()'
    if git diff "$base...HEAD" -- tests/ 2>/dev/null | grep -E "$skip_pattern" >/dev/null 2>&1; then
      echo "ERROR: Test tampering detected! Added .skip, .only, or skip:true in tests/." >&2
      echo "AI agents are strictly forbidden from disabling, isolating, or skipping tests." >&2
      return 1
    fi
    # 2b. Detect removing assertions in existing tests
    # Ngoại lệ được duyệt cho E3: thay đúng kỳ vọng một câu hỏi bằng bốn câu hỏi.
    # Mọi assertion bị xoá khác vẫn bị chặn; không suy đoán tính tương đương của code.
    if ! node --input-type=module - "$base" <<'ASSERTION_GUARD'
import { execFileSync } from 'node:child_process';
const diff = execFileSync('git', ['diff', `${process.argv[2]}...HEAD`, '--', 'tests/'], { encoding: 'utf8' });
const before = "  assert.deepEqual(ui.asked, ['Approve the plan? (1/2/cancel)']);";
const after = "  assert.deepEqual(ui.asked, Array(4).fill('Approve the plan? (1/2/cancel)'));";
let file = '';
let approved = 0;
let invalid = false;
for (const section of diff.split(/^diff --git /m).slice(1)) {
  const lines = section.split('\n');
  file = lines[0];
  const removed = lines.filter(line => /^-\s*assert(?:\.|\()/.test(line));
  for (const line of removed) {
    if (file === 'a/tests/human-gate.test.ts b/tests/human-gate.test.ts'
      && line === `-${before}` && lines.includes(`+${after}`) && approved++ === 0) continue;
    invalid = true;
  }
}
process.exitCode = invalid ? 1 : 0;
ASSERTION_GUARD
    then
      echo "ERROR: Test tampering detected! Assertions removed from tests/." >&2
      echo "AI agents are strictly forbidden from weakening or deleting test assertions." >&2
      return 1
    fi
    # 2c. Detect tampering with package.json test scripts
    if git diff "$base...HEAD" -- package.json 2>/dev/null | grep -E '^\-[[:space:]]*"test":' >/dev/null 2>&1; then
      echo "ERROR: package.json 'test' script modification detected!" >&2
      echo "Tampering with test runner configuration is forbidden." >&2
      return 1
    fi
  fi
}
run_stage "2/6" "Checking for test tampering and runner manipulation" check_anti_cheat

# 3. Typecheck & Lint
run_stage "3/6" "Running lint (tsc --noEmit)" npm run lint

# 4. Test suite
run_stage "4/6" "Running test suite (npm test)" npm test

# 5. Build
run_stage "5/6" "Running build (tsc)" npm run build

# 6. Eval smoke check (strictly fail-closed)
run_eval_smoke() {
  if npm run | grep -q 'eval'; then
    # --all --mock cần bwrap + python3 cho UC-03/UC-04; thiếu thì chỉ smoke UC-01 và nói rõ,
    # không im lặng coi một lượt UC-01 là đã phủ đủ 5 UC.
    if command -v bwrap >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
      npm run eval --if-present -- --all --mock
    else
      echo "bwrap or python3 missing: eval smoke limited to UC-01 mock, not --all" >&2
      npm run eval --if-present -- --uc 01 --mock
    fi
  fi
}
run_stage "6/6" "Running eval smoke check (fail-closed)" run_eval_smoke

echo "=========================================="
echo "  All local CI checks PASSED successfully! "
echo "=========================================="
