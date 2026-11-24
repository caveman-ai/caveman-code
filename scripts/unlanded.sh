#!/usr/bin/env bash
# Read-only: lists work not yet on origin/main, for the integration automation.
#   branches   commits on a local or origin branch whose change main doesn't hold
#   worktrees  uncommitted edits in any worktree of this repository
# A commit counts as landed when main has its subject or its whole patch reverse-applies
# on main (it landed under another commit). Nothing here writes to any checkout or index.
#
# Decisions already taken live in the ledger, shared by every worktree and never committed:
#   $(git rev-parse --git-common-dir)/integration-ledger, one "<key> <decision> <why>" per line.
# A key (a commit's full hash, or wt:<diff hash> for a worktree's edits) listed there is not shown
# again; a worktree edited since gets a new key. `--all` shows decided items too.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git fetch --all --prune -q
main=origin/main
now=$(date +%s)
age() { echo "$(( (now - $1) / 3600 ))h"; }
ledger="$(cd "$(git rev-parse --git-common-dir)" && pwd)/integration-ledger"
touch "$ledger"
all=0; [ "${1:-}" = "--all" ] && all=1
decided() { [ "$all" = 0 ] && grep -q "^$1 " "$ledger"; }
echo "ledger: $ledger"

subjects=$(mktemp); index=$(mktemp -u); trap 'rm -f "$subjects" "$index"' EXIT
git log "$main" --format=%s -5000 | sort -u >"$subjects"
# A private index holding main, so the reverse-apply checks test main, not this checkout.
GIT_INDEX_FILE=$index git read-tree "$main"
onmain() { GIT_INDEX_FILE=$index git apply --check -R --cached 2>/dev/null; }

# Open pull requests by branch, so a draft is marked as one.
prs=$(gh pr list --state open --limit 100 --json number,headRefName,isDraft \
  --jq '.[] | "\(.headRefName) #\(.number)\(if .isDraft then " DRAFT" else "" end)"' 2>/dev/null || true)

landed() { # $1 commit
  grep -qxF "$(git log -1 --format=%s "$1")" "$subjects" && return 0
  git diff "$1^" "$1" | onmain
}

echo "## branches (newest first)"
git for-each-ref --sort=-committerdate --format='%(refname:short) %(committerdate:unix)' refs/heads refs/remotes/origin |
  grep -v -e '^origin ' -e '^origin/HEAD' -e '^origin/main ' -e '^main ' -e '^integration-snapshots/' -e '^backup/' |
  while read -r ref when; do
    pending=()
    for c in $(git rev-list --cherry-pick --right-only --no-merges "$main...$ref"); do
      decided "$c" || landed "$c" || pending+=("$c")
    done
    [ ${#pending[@]} -eq 0 ] && continue
    branch=${ref#origin/}
    # A local branch and its origin copy are one entry; show the local one.
    [ "$ref" != "$branch" ] && git show-ref -q --verify "refs/heads/$branch" && continue
    pr=$(awk -v b="$branch" '$1 == b { $1 = ""; print substr($0, 2) }' <<<"$prs")
    conflicts=$(git merge-tree --write-tree --name-only "$main" "$ref" 2>/dev/null | sed -n '2,/^$/p' | grep -v '^$' | tr '\n' ' ' || true)
    echo "- $ref  age=$(age "$when")${pr:+  pr=$pr}${conflicts:+  conflicts: $conflicts}"
    for c in "${pending[@]}"; do echo "    $(git log -1 --format='%H %s' "$c")"; done
  done

echo
echo "## dirty worktrees"
git worktree list --porcelain | awk '/^worktree /{print substr($0, 10)}' | while read -r wt; do
  [ -d "$wt" ] || continue
  status=$(git -C "$wt" status --porcelain 2>/dev/null) || continue
  [ -z "$status" ] && continue
  newest=$(cd "$wt" && git status --porcelain -z | tr '\0' '\n' | cut -c4- | while read -r f; do [ -e "$f" ] && stat -f %m "$f"; done | sort -n | tail -1)
  # Files whose edit main already holds (reverse-applies on main) are not pending.
  pending=0; total=0
  while read -r f; do
    total=$((total + 1))
    git -C "$wt" diff HEAD -- "$f" | onmain || pending=$((pending + 1))
  done < <(git -C "$wt" status --porcelain | cut -c4-)
  [ "$pending" -eq 0 ] && continue
  key="wt:$( (git -C "$wt" diff HEAD; git -C "$wt" ls-files --others --exclude-standard | while read -r f; do echo "$f"; cat "$wt/$f"; done) | git hash-object --stdin)"
  decided "$key" && continue
  echo "- $key $wt  branch=$(git -C "$wt" branch --show-current)  head=$(git -C "$wt" log -1 --format=%h)  edited=$(age "${newest:-$now}") ago  files not on main: $pending/$total"
done
