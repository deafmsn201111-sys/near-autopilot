#!/usr/bin/env bash
# Usage: scripts/start-issue.sh <issue-number>
# Creates .claude/worktrees/<n>-<slug> on a fresh branch from origin/main and prints its path.
set -euo pipefail

issue="${1:?usage: scripts/start-issue.sh <issue-number>}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

title="$(gh issue view "$issue" --json title --jq .title)"
labels="$(gh issue view "$issue" --json labels --jq '[.labels[].name] | join(",")')"
slug="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//' | cut -c1-40 | sed -E 's/-+$//')"
prefix="feat"
[[ ",$labels," == *",bug,"* ]] && prefix="fix"
branch="$prefix/$issue-$slug"
dir="$root/.claude/worktrees/$issue-$slug"

if [[ -d "$dir" ]]; then
  echo "$dir"
  exit 0
fi

git fetch -q origin main
if git show-ref -q --verify "refs/heads/$branch"; then
  git worktree add -q "$dir" "$branch"
else
  git worktree add -q -b "$branch" "$dir" origin/main
fi

git ls-files --others --ignored --exclude-from=.worktreeinclude | rsync -a --files-from=- . "$dir/"

pnpm=(pnpm)
command -v pnpm >/dev/null || pnpm=(npx -y "$(node -p "require('./package.json').packageManager")")
(cd "$dir" && "${pnpm[@]}" install --frozen-lockfile --silent) >&2

gh issue edit "$issue" --add-assignee @me >/dev/null || true

# ponytail: board is hard-coded; only its owner can move cards, everyone else silently skips
project=1
owner=derevyanko
item="$(gh project item-list "$project" --owner "$owner" --limit 200 --format json \
  --jq ".items[] | select(.content.number == $issue) | .id" 2>/dev/null || true)"
if [[ -n "$item" ]]; then
  pid="$(gh project view "$project" --owner "$owner" --format json --jq .id)"
  field="$(gh project field-list "$project" --owner "$owner" --format json --jq '.fields[] | select(.name == "Status")')"
  gh project item-edit --project-id "$pid" --id "$item" \
    --field-id "$(jq -r .id <<<"$field")" \
    --single-select-option-id "$(jq -r '.options[] | select(.name == "In Progress") | .id' <<<"$field")" >/dev/null || true
fi

echo "$dir"
