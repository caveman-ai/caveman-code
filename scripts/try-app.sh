#!/usr/bin/env bash
# Opens this checkout, uncommitted edits included, as Caveman Code Nightly: the desktop app from source
# (apps/desktop/scripts/dev.mjs) beside the installed one, never in place of it.
#   bash scripts/try-app.sh      the repo's "Try in Nightly" action (.caveman/actions.toml), the diff icon on a
#                                chat's Changes bar: it runs in that chat's terminal, and stopping it quits Nightly.
# Nightly keeps a profile of its own, "Caveman Code Nightly" in Application Support, with its own runtime state,
# so the installed app's chats, sign-ins and runtime are never touched, and what you set up in Nightly stays
# from one try to the next. One Nightly at a time: trying another checkout quits the one this script opened.
# It starts in a clean environment: a chat's terminal carries its own runtime's addresses and tokens.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
profile="$HOME/Library/Application Support/Caveman Code Nightly"
[ "$(uname)" = Darwin ] || profile="${XDG_CONFIG_HOME:-$HOME/.config}/Caveman Code Nightly"
pidfile="$profile/try-app.pid"
mkdir -p "$profile"

# The Nightly this script opened last, from any checkout: only that recorded process, and only while it is still
# this script's dev.mjs (a pid can be reused).
if [ -f "$pidfile" ]; then
  old=$(cat "$pidfile")
  if [ -n "$old" ] && ps -p "$old" -o command= 2>/dev/null | grep -q "apps/desktop/scripts/dev.mjs"; then
    echo "quitting the Nightly already open ($(ps -p "$old" -o command= | sed 's/.*--checkout=\([^ ]*\).*/\1/'))"
    kill "$old" 2>/dev/null || true
    for _ in $(seq 30); do kill -0 "$old" 2>/dev/null || break; sleep 1; done
  fi
fi

cd "$root"
echo "Caveman Code Nightly from $root at $(git log -1 --format='%h %s')"
git status --short | sed -n '1,20p'
pnpm install --frozen-lockfile --prefer-offline

echo $$ >"$pidfile"
# exec keeps this pid, the one recorded. --checkout only names the checkout in `ps`; Electron ignores it.
exec env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" SHELL="${SHELL:-/bin/zsh}" PATH="$PATH" \
  TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-xterm-256color}" \
  node apps/desktop/scripts/dev.mjs --user-data-dir="$profile" --checkout="$root"
