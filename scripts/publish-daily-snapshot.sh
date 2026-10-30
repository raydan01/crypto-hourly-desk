#!/usr/bin/env bash
# Preserve concurrent commits; never resolve data conflicts by overwriting them.
set -euo pipefail

paths=(data/market-opportunities-daily-latest.json data/market-opportunities-long-term-latest.json)
while IFS= read -r -d '' entry; do
  path="${entry:3}"
  if [[ "$path" != "${paths[0]}" && "$path" != "${paths[1]}" ]]; then
    echo "Unexpected changed path; refusing publication: $path" >&2
    exit 1
  fi
done < <(git status --porcelain=v1 -z --untracked-files=all)

git add -- "${paths[@]}"
if git diff --cached --quiet; then
  echo "Daily snapshots unchanged."
  exit 0
fi
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git commit -m "Refresh weekly trading snapshot"

for attempt in 1 2 3; do
  git fetch origin main
  if ! git rebase origin/main; then
    git rebase --abort
    echo "Concurrent snapshot conflict; refusing to overwrite remote data." >&2
    exit 1
  fi
  if git push origin HEAD:main; then
    exit 0
  fi
  if [[ "$attempt" -lt 3 ]]; then
    sleep "$((attempt * 2))"
  fi
done
echo "Snapshot publication failed after 3 attempts; no force-push attempted." >&2
exit 1
