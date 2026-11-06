#!/usr/bin/env bash
# scripts/ship.sh - Run local CI, push branch, open PR, and merge when all checks pass.
# GitHub Actions quota on the private org is exhausted, so local CI is the strict gatekeeper.
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

# 1. Commit convention check for all commits on this branch
echo "==> Checking commit messages on branch '$branch'..."
CONVENTION_REGEX='^(feat|fix|refactor|test|docs|ci|chore|perf)(\([a-zA-Z0-9_./-]+\))?: .+$'
while IFS= read -r msg; do
  [ -z "$msg" ] && continue
  if ! [[ "$msg" =~ $CONVENTION_REGEX ]]; then
    echo "ship: commit subject '$msg' does not match convention 'type(scope): subject'. Not merged." >&2
    exit 1
  fi
  if [ "${#msg}" -gt 72 ]; then
    echo "ship: commit subject '$msg' exceeds 72 chars (${#msg} chars). Not merged." >&2
    exit 1
  fi
done < <(git log --format=%s origin/main..HEAD)

# 2. Strict Local CI suite: lint, test, build, eval, secrets
echo "==> Running local CI suite..."
if ! bash scripts/ci-local.sh; then
  echo "ship: local CI check failed. Fix errors on this branch and run scripts/ship.sh again. Not merged." >&2
  exit 1
fi

# 3. Push branch and open PR
git push -u origin HEAD --force-with-lease
gh pr view --json number >/dev/null 2>&1 || gh pr create --base main --fill-first

number=$(gh pr view --json number -q .number)
title=$(gh pr view --json title -q .title)

# 4. PR title convention check
if ! [[ "$title" =~ $CONVENTION_REGEX ]]; then
  echo "ship: PR title '$title' does not match convention 'type(scope): subject'. Not merged." >&2
  exit 1
fi

# 5. Merge PR
# The default merge title ("Merge pull request #N ...") breaks the commit convention on main.
echo "==> Merging PR #$number: $title..."
gh pr merge "$number" --merge --delete-branch --subject "$title (#$number)"
git switch main
git pull --ff-only origin main
echo "==> Successfully shipped and merged PR #$number!"
