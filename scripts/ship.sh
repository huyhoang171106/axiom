#!/usr/bin/env bash
# scripts/ship.sh - Push the branch, open its PR, wait for every CI check, merge only when all pass
# The org repo has no auto-merge or branch protection (free plan), so the author merges after CI instead.
set -euo pipefail

branch=$(git branch --show-current)
case "$branch" in
  main | master | "") echo "ship: run from a feature branch, not '${branch:-detached HEAD}'" >&2; exit 1 ;;
esac

# gh may default to another remote (e.g. an old fork); always target the repo behind `origin`.
GH_REPO=$(git remote get-url origin | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##')
export GH_REPO

git fetch origin
git rebase origin/main
git push -u origin HEAD --force-with-lease
gh pr view --json number >/dev/null 2>&1 || gh pr create --base main --fill-first  # title = first commit subject, which follows the convention

# Checks register some seconds after the push. Watching before all required ones exist sees only the
# finished ones and returns green, which merged a PR with pending checks once.
REQUIRED=(check secrets pr-title)
for _ in $(seq 60); do
  names=$(gh pr checks --json name -q '.[].name' 2>/dev/null || true)
  missing=0
  for name in "${REQUIRED[@]}"; do grep -qx "$name" <<<"$names" || missing=1; done
  [ "$missing" = 0 ] && break
  sleep 5
done
if [ "$missing" != 0 ]; then
  echo "ship: required checks (${REQUIRED[*]}) did not start within 5 minutes. Not merged." >&2
  exit 1
fi

if ! gh pr checks --watch --fail-fast; then
  echo "ship: a check failed. Fix it on this branch and run scripts/ship.sh again. Not merged." >&2
  exit 1
fi
notgreen=$(gh pr checks --json name,bucket -q '[.[] | select(.bucket != "pass" and .bucket != "skipping") | .name] | join(", ")')
if [ -n "$notgreen" ]; then
  echo "ship: not green yet: $notgreen. Not merged." >&2
  exit 1
fi

number=$(gh pr view --json number -q .number)
title=$(gh pr view --json title -q .title)
# The default merge title ("Merge pull request #N ...") breaks the commit convention on main.
gh pr merge "$number" --merge --delete-branch --subject "$title (#$number)"
git switch main
git pull --ff-only origin main
