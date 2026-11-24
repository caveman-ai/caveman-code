// Caveman's co-author trailer, added by git itself: every engine's tool processes get
// core.hooksPath (GIT_CONFIG_COUNT/KEY/VALUE, the command-line scope, so a repository's own
// core.hooksPath does not win) pointing at a runtime-owned directory. Its commit-msg hook adds
// the trailer while Settings > General > Git says so (the flag file, read at commit time), then
// every hook runs the repository's own one (its configured core.hooksPath, else
// <common-dir>/hooks) with the same arguments, stdin and exit code. The user's own git is never
// given this environment, so their commits are untouched; other trailers are kept as they are.
// Engines' tools see the directory as the repository's hooks directory (`git config core.hooksPath`,
// `git rev-parse --git-path hooks`): its hooks are read-only, so an installer run there fails instead
// of replacing them (pre-commit refuses any core.hooksPath), and every session start rewrites any
// that changed. Its README says how to install a repository's own hooks from an engine's shell.
// The same hooks keep repository secrets out of engines' commits and pushes: pre-commit and pre-push
// refuse added lines holding a hidden secret's exact value (names in CAVEMAN_SECRET_NAMES, values in the
// environment the runtime gave the engine), naming the secret and the file, never the value.
// ponytail: `git commit --no-verify` and plumbing (commit-tree) skip hooks; the engine
// instruction (CO_AUTHOR_INSTRUCTION) still asks for the trailer there.
import * as fs from "node:fs";
import * as path from "node:path";

import { toolsRun } from "../cloudLink/tools.ts";
import { CAVEMAN_CO_AUTHOR } from "./coAuthor.ts";

/**
 * githooks(5), less fsmonitor-watchman (core.fsmonitor names it, not the hooks directory).
 * ponytail: reference-transaction and post-index-change are left out: git runs them several times per
 * commit, and a shim each time made an agent's add+commit+status ~7x slower; a repository's own hook of
 * those two names does not run for engines' git (add them back if a repo needs them).
 */
const HOOK_NAMES = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg",
  "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update",
  "proc-receive", "post-receive", "post-update", "push-to-checkout", "pre-auto-gc", "post-rewrite",
  "sendemail-validate", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit",
];
const FLAG = "co-author-on";
/** The repository's hidden secrets' names, space-separated, in an engine's environment beside their values (EngineEgress engineSecretEnv). */
export const SECRET_NAMES_ENV = "CAVEMAN_SECRET_NAMES";

/**
 * Prints "NAME in FILE" for each added line of a unified diff on stdin that holds a secret's value: the whole
 * value, or for a multi-line one (a PEM key) each line of 16 characters or more, as the egress scrub matches them.
 */
const SCAN = `awk '
BEGIN {
  n = split(ENVIRON["${SECRET_NAMES_ENV}"], names, " ")
  for (i = 1; i <= n; i++) {
    v = ENVIRON[names[i]]
    if (v == "") continue
    m = split(v, parts, "\\n")
    if (m <= 1) { if (length(v) >= 8) { k++; needle[k] = v; owner[k] = names[i] } continue }
    for (j = 1; j <= m; j++) {
      t = parts[j]; gsub(/^[ \\t\\r]+|[ \\t\\r]+$/, "", t)
      if (length(t) >= 16) { k++; needle[k] = t; owner[k] = names[i] }
    }
  }
}
/^\\+\\+\\+ / { file = substr($0, 5); sub(/^b\\//, "", file); next }
/^\\+/ { for (i = 1; i <= k; i++) if (index($0, needle[i])) { hit = owner[i] " in " file; if (!(hit in seen)) { seen[hit] = 1; print hit } } }
'`;

const script = `#!/bin/sh
# Written by Caveman Code; see packages/runtime/src/git/coAuthorHooks.ts.
hook=\${0##*/}
here=\${0%/*}
replay=
input=
# Only on a message with words in it: an empty one still aborts the commit, as git means it to.
if [ "$hook" = commit-msg ] && [ -f "$here/${FLAG}" ] && [ -n "$(git stripspace --strip-comments <"$1" 2>/dev/null)" ]; then
  git interpret-trailers --in-place --where end --if-exists addIfDifferent --if-missing add --trailer '${CAVEMAN_CO_AUTHOR}' "$1" </dev/null || :
fi
# A repository secret's value in what a commit or push adds: refused, naming the secret and the file, never the value.
if [ -n "$${SECRET_NAMES_ENV}" ] && { [ "$hook" = pre-commit ] || [ "$hook" = pre-push ]; }; then
  if [ "$hook" = pre-commit ]; then
    found=$(git diff --cached --no-color --no-ext-diff --no-textconv -U0 --diff-filter=d </dev/null 2>/dev/null | ${SCAN})
  else
    # pre-push reads the refs on stdin; they are handed on to the repository's own hook as they came.
    input=$(cat; echo .)
    input=\${input%.}
    replay=1
    found=$(printf '%s' "$input" | while read -r lref lsha rref rsha; do
      case $lsha in (*[!0]*) ;; (*) continue ;; esac
      if case $rsha in (*[!0]*) git cat-file -e "$rsha^{commit}" 2>/dev/null ;; (*) false ;; esac; then range="$rsha..$lsha"; else range="$lsha --not --remotes"; fi
      git log -p --no-color --no-ext-diff --no-textconv -U0 --format= $range </dev/null 2>/dev/null
    done | ${SCAN})
  fi
  if [ -n "$found" ]; then
    what=commit; [ "$hook" = pre-push ] && what=push
    printf 'Caveman Code refused this %s: it adds the value of a repository secret:\\n' "$what" >&2
    printf '%s\\n' "$found" | sed 's/^/  /' >&2
    printf 'Use the variable instead of its value, and keep the value out of the repository.\\n' >&2
    exit 1
  fi
fi
# The repository's own hooks directory: its core.hooksPath, else <common-dir>/hooks, without the runtime's override.
own=$(GIT_CONFIG_COUNT=0 git rev-parse --git-path hooks </dev/null 2>/dev/null) || exit 0
[ "$(cd "$own" 2>/dev/null && pwd -P)" = "$(cd "$here" && pwd -P)" ] && exit 0
[ -x "$own/$hook" ] || exit 0
if [ -n "$replay" ]; then printf '%s' "$input" | "$own/$hook" "$@"; exit $?; fi
exec "$own/$hook" "$@"
`;

const README = `Caveman Code's commit hooks: engines' git runs them (core.hooksPath, set through GIT_CONFIG_COUNT).
They add Caveman's co-author trailer while Settings > General > Git says so, refuse a commit or push that adds
the value of one of the repository's secrets, then run the repository's own hooks.
They are read-only. To install a repository's own hooks from an engine's shell (pre-commit install,
lefthook install), run the installer with GIT_CONFIG_COUNT=0: it then sees the repository's hooks directory.
`;
const FILES: ReadonlyArray<readonly [name: string, body: string, mode: number]> = [
  ...HOOK_NAMES.map((name) => [name, script, 0o555] as const),
  ["README", README, 0o444],
];

/**
 * The runtime's hooks directory (each hook is the same script, named for its hook), written read-only.
 * Called on every session start: whatever an engine's tools changed or added there is put back.
 */
export function writeCoAuthorHooks(stateDir: string): string {
  const dir = path.join(stateDir, "git-hooks");
  fs.mkdirSync(dir, { recursive: true });
  // Anything this runtime does not write (an older runtime's hook, an installer's file); the directory is the runtime's own.
  for (const name of fs.readdirSync(dir)) {
    if (name !== FLAG && !FILES.some(([own]) => own === name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  for (const [name, body, mode] of FILES) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat?.isFile() && fs.readFileSync(file, "utf8") === body) {
      if ((stat.mode & 0o777) !== mode) fs.chmodSync(file, mode);
      continue;
    }
    fs.rmSync(file, { recursive: true, force: true });
    fs.writeFileSync(`${file}.tmp`, body, { mode });
    fs.renameSync(`${file}.tmp`, file);
  }
  // A real path: the hook compares directories physically, so it never runs itself as the repository's hook.
  return fs.realpathSync(dir);
}

/**
 * On a Cloud computer engines' tools run in its tools container, which cannot read the runtime's state directory:
 * the same hooks live in the tools user's home there (git expands `~` in core.hooksPath).
 */
export const TOOLS_HOOKS_DIR = "~/.caveman/git-hooks";
const TOOLS_HOOKS_SHELL_DIR = '"$HOME/.caveman/git-hooks"';
// The bodies cross without their last newline: `$(cat file)` drops it too, so an unchanged file is left alone.
const toolsWrite = `d=${TOOLS_HOOKS_SHELL_DIR}
mkdir -p "$d" || exit 1
for f in "$d"/* "$d"/.[!.]*; do
  [ -e "$f" ] || continue
  case " $CAVEMAN_HOOK_NAMES README ${FLAG} " in *" \${f##*/} "*) ;; *) rm -rf "$f" ;; esac
done
for n in $CAVEMAN_HOOK_NAMES README; do
  if [ "$n" = README ]; then body=$CAVEMAN_HOOK_README; mode=444; else body=$CAVEMAN_HOOK; mode=555; fi
  [ -f "$d/$n" ] && [ "$(cat "$d/$n")" = "$body" ] && continue
  rm -rf "$d/$n" && printf '%s\n' "$body" > "$d/.$n.tmp" && chmod $mode "$d/.$n.tmp" && mv -f "$d/.$n.tmp" "$d/$n" || exit 1
done
if [ "$1" = on ]; then : > "$d/${FLAG}"; else rm -f "$d/${FLAG}"; fi
`;

/** writeCoAuthorHooks and setCoAuthorFlag in a Cloud computer's tools container (TOOLS_HOOKS_DIR); false when tools could not. */
export const writeToolsCoAuthorHooks = (socket: string, on: boolean): Promise<boolean> =>
  toolsRun(socket, "/", ["sh", "-c", toolsWrite, "sh", on ? "on" : "off"], {
    CAVEMAN_HOOK: script.trimEnd(),
    CAVEMAN_HOOK_README: README.trimEnd(),
    CAVEMAN_HOOK_NAMES: HOOK_NAMES.join(" "),
  }).then((result) => result.code === 0, () => false);

/** Settings > General > Git in a Cloud computer's tools container, where its hooks are (a session start writes them). */
export const setToolsCoAuthorFlag = (socket: string, on: boolean): Promise<boolean> =>
  toolsRun(socket, "/", ["sh", "-c", `d=${TOOLS_HOOKS_SHELL_DIR}; [ -d "$d" ] || exit 0; if [ "$1" = on ]; then : > "$d/${FLAG}"; else rm -f "$d/${FLAG}"; fi`, "sh", on ? "on" : "off"]).then(
    (result) => result.code === 0,
    () => false,
  );

/** Settings > General > Git, as the commit-msg hook reads it on each commit. */
export function setCoAuthorFlag(dir: string, on: boolean): void {
  const flag = path.join(dir, FLAG);
  if (on) fs.writeFileSync(flag, "");
  else fs.rmSync(flag, { force: true });
}

/**
 * The variables that point an engine's tool processes at the hooks directory, appended after any
 * GIT_CONFIG_COUNT entries in `base` (copied along, for engines that do not inherit the environment).
 */
export function coAuthorGitEnv(dir: string, base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const count = Number(base.GIT_CONFIG_COUNT);
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    for (const name of [`GIT_CONFIG_KEY_${i}`, `GIT_CONFIG_VALUE_${i}`]) if (base[name] !== undefined) out[name] = base[name]!;
  }
  return { ...out, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: "core.hooksPath", [`GIT_CONFIG_VALUE_${n}`]: dir };
}
