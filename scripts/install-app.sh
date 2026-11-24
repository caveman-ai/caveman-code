#!/usr/bin/env bash
# Builds Caveman Code from origin/main and puts it in /Applications in place of whatever is there.
#   pnpm app                  build now, quit the app, swap it in and reopen it
#   pnpm app --ref <ref>      another branch or commit (fetched from origin when it names a remote branch)
#   install-app.sh --auto     for an hourly automation: build only when origin/main has moved, then install the build
#                             as soon as the app is closed (a notification says one is waiting), never quitting it.
#                             The wait runs on detached, so the automation's run can end; a newer build replaces it.
#                             Log: ~/Library/Logs/caveman-code.log
# Builds in its own detached worktree, $CAVEMAN_APP_BUILD_DIR (~/.cache/caveman-code), so no checkout you work
# in is touched; $CAVEMAN_APP_REPO names the repository when this runs from outside it. The build has no update
# feed (package.mjs --local): updates come from here. The app it replaces goes to the Trash, and the state in
# ~/.caveman-code carries over. Signed with $CSC_NAME when set, else ad-hoc.
# The quit, swap and reopen run detached, so `pnpm app` also works from a chat inside Caveman Code, which it quits.
set -euo pipefail

main() {
  local ref=origin/main auto=0
  while [ $# -gt 0 ]; do
    case $1 in
      --ref) ref=${2:?--ref needs a branch or commit}; shift 2 ;;
      --auto) auto=1; shift ;;
      *) echo "unknown option $1" >&2; return 2 ;;
    esac
  done
  [ "$(uname)" = Darwin ] || { echo "install-app.sh installs the macOS app" >&2; return 1; }

  local repo build target state staged waiter
  repo=${CAVEMAN_APP_REPO:-$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)}
  build=${CAVEMAN_APP_BUILD_DIR:-$HOME/.cache/caveman-code}
  target="/Applications/Caveman Code.app"
  # The commit last installed from here, the one waiting to be, and the process group waiting with it.
  state="$build.installed" staged="$build.staged" waiter="$build.waiter"

  git -C "$repo" fetch -q origin
  [ "$ref" = origin/main ] || git -C "$repo" fetch -q origin "${ref#origin/}" 2>/dev/null || true
  local commit
  commit=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
  if [ $auto = 1 ]; then
    [ "$(cat "$state" 2>/dev/null)" = "$commit" ] && return 0
    [ "$(cat "$staged" 2>/dev/null)" = "$commit" ] && kill -0 "$(cat "$waiter" 2>/dev/null)" 2>/dev/null && return 0
  fi
  echo "$(date '+%F %T') building Caveman Code at $(git -C "$repo" log -1 --format='%h %s' "$commit")"

  if [ -e "$build/.git" ]; then
    git -C "$build" checkout -q --detach --force "$commit"
    git -C "$build" clean -qfd
  else
    git -C "$repo" worktree add -q --detach "$build" "$commit"
  fi
  # Without --local the build keeps the public update feed, which would replace it with the last release.
  grep -q -- '"--local"' "$build/apps/desktop/scripts/package.mjs" || { echo "$ref has no package.mjs --local; not building" >&2; return 1; }
  (cd "$build" && pnpm install --frozen-lockfile && node apps/desktop/scripts/package.mjs --local)
  local arch built
  arch=$(uname -m)
  built="$build/apps/desktop/release/$([ "$arch" = x86_64 ] && echo mac || echo "mac-$arch")/Caveman Code.app"
  [ -d "$built" ] || { echo "no app at $built" >&2; return 1; }

  # Copy first, on the same volume as /Applications, so the swap is two renames.
  local stage short
  stage=$(mktemp -d /tmp/caveman-code.XXXXXX)
  ditto "$built" "$stage/Caveman Code.app"
  short=$(git -C "$repo" log -1 --format=%h "$commit")

  # This build replaces one still waiting.
  if [ -f "$waiter" ]; then kill -- "-$(cat "$waiter")" 2>/dev/null || true; fi
  rm -f "$waiter" "$staged"
  # Its own process group (set -m): quitting the app ends the runtime's group, which may hold this shell.
  set -m
  if [ $auto = 1 ]; then
    mkdir -p "$HOME/Library/Logs"
    nohup bash -c "$SWAP" swap "$target" "$stage" wait "$short" "$state" "$commit" \
      </dev/null >>"$HOME/Library/Logs/caveman-code.log" 2>&1 &
    echo $! >"$waiter"
    set +m
    echo "$commit" >"$staged"
    echo "$short is ready and installs as soon as Caveman Code is closed"
    return 0
  fi
  local log; log=$(mktemp /tmp/caveman-code-install.XXXXXX)
  nohup bash -c "$SWAP" swap "$target" "$stage" quit "$short" "$state" "$commit" </dev/null >"$log" 2>&1 &
  local pid=$!
  set +m
  while kill -0 "$pid" 2>/dev/null; do sleep 1; done
  cat "$log"
  local ok=0
  grep -q "installed $short" "$log" || ok=1
  rm -f "$log"
  return $ok
}

# $1 the app, $2 the folder holding the new one, $3 quit (ask the app to quit, then reopen it) or wait (until it
# quits, then leave it closed), $4 the short commit, $5 the file that records $6, the commit, once installed.
SWAP=$(cat <<'SCRIPT'
set -u
target=$1 stage=$2 mode=$3 commit=$4 state=$5 full=$6
notify() { osascript -e "display notification \"$1\" with title \"Caveman Code\"" || true; }
# The app and any runtime of it (the app's, or `caveman code`'s), which would keep the state dir and the new app
# would attach to it. Other programs may run binaries from inside the bundle (caveman-mcp); they keep them. -a: pgrep
# skips its own ancestors otherwise, and run from a chat inside Caveman Code the app is one.
running() { pgrep -af "$target/Contents/(MacOS/|Resources/runtime/bin\.mjs)" >/dev/null; }
# A newer build replaces a waiting one by ending its process group: its copy of the app (~700 MB) goes with it. Even
# mid-swap it stops (each step is one rename) rather than racing the newer build's swap, which starts right after.
trap 'rm -rf "$stage"; exit 143' TERM
if running && [ "$mode" = wait ]; then
  notify "Build $commit is ready: it installs when you quit Caveman Code."
  while running; do sleep 30; done
elif running; then
  echo "quitting Caveman Code"
  osascript -e 'tell application id "so.caveman.code" to quit' || true
  # Up to two minutes: the app may ask before quitting with chats running.
  for _ in $(seq 120); do running || break; sleep 1; done
  if running; then
    echo "Caveman Code or a \`caveman code\` runtime is still running; nothing replaced. The new build is in $stage"
    pgrep -afl "$target/Contents/(MacOS/|Resources/runtime/bin\.mjs)"
    exit 1
  fi
fi
if [ -e "$target" ]; then mv "$target" "$HOME/.Trash/Caveman Code $(date +%Y%m%d-%H%M%S).app" || exit 1; fi
mv "$stage/Caveman Code.app" "$target" || exit 1
rm -rf "$stage"
echo "$full" >"$state"
if [ "$mode" = quit ]; then open "$target"; else notify "Build $commit is installed."; fi
echo "$(date '+%F %T') installed $commit"
SCRIPT
)

main "$@"
