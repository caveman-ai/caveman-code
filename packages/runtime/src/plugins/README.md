# Plugin containment: what holds and what stays open

Every plugin process (stdio MCP server, command hook, LSP server, monitor)
starts through `sandboxLaunch.mjs` with a `LaunchPolicy` built in `resolve.ts`.
This file says what that buys and, plainly, what it does not. UI text
(`PluginInfo.containment`, the Plugins page) must not claim more than this.

## What holds

- **Environment.** A plugin process sees only `BASE_ENV_ALLOWLIST`, the names
  in Settings' env allowlist, its own declared variables, and credentials the
  broker granted to its marketplace (read from a 0600 file by the launcher, never in
  argv or the engine's config).
- **Files it cannot read** (macOS sandbox-exec, Linux bubblewrap): the
  runtime's state dir (secrets, sessions, brokered files) except marketplace
  checkouts and plugin copies, and the credential files in `containmentFor`
  (ssh, netrc, cloud CLIs, Kubernetes, Docker, registries, other agents'
  logins). That list is best effort; the write allowlist below does not
  depend on it.
- **Where it can write** (macOS, bubblewrap): only the session's worktree
  and a shared package cache (`<base>/caches/plugins`, set as
  `XDG_CACHE_HOME` and the npm cache so `npx`/`uvx` servers work), whose
  `tmp/` is the plugin's `TMPDIR`, `TMP` and `TEMP`; plus for hooks what
  Claude Code hands them: `CLAUDE_PROJECT_DIR` inside the runtime's
  worktrees dir, `CLAUDE_PLUGIN_DATA` inside `<claude config>/plugins/data`,
  the `CLAUDE_ENV_FILE` dir inside `<claude config>/session-env`. A chat
  outside the worktrees dir (a plain folder, a Cloud computer's workspace)
  names its folder in its hooks' policy instead, so their Claude Agent
  plugin copy is that folder's own.
  - Not the user's `TMPDIR` or `/tmp`: executables there run outside the
    sandbox (a terminal's CLI shims, such as cmux's `claude` in
    `$TMPDIR/cmux-cli-shims`, which the runtime finds on PATH), and so does
    a repo cloned there.
  - Never a worktree's `.git` (hooks, config, the gitdir pointer),
    `.caveman` (`computer.toml`: the runtime runs `[setup]`, `[run]` and
    `[archive]` and hands `[env]` to the engines' commands) or `.claude`
    (project settings, whose hooks Claude Agent runs). Never the
    repository's own git dir (it is outside every root). On Linux the
    launcher creates a missing `.caveman` or `.claude` in the worktree,
    empty, so it can bind it read-only (git does not show an empty dir).
    In a folder without git (a plain-folder chat) it makes nothing, since
    an empty `.git` would make the folder read as a repository: there the
    folder's top level stays read-only, and what is already in it (but
    those three) is writable.
  - HOME, shell rc files, `~/.gitconfig`, LaunchAgents, `~/Library/Caches`
    and tool dirs such as `/opt/homebrew/bin` are read-only to it. A parent
    of a denied path or of a protected entry cannot be renamed aside.
  - What breaks, with "Operation not permitted" (or "Read-only file
    system"): `git commit` and `git add` in the worktree (`git status` and
    `diff` work); tools that write elsewhere in HOME (uv's managed Pythons
    in `~/.local/share`, `npm install -g`); a hook that writes under
    `$CLAUDE_PROJECT_DIR/.claude`; tools that hard-code `/tmp`; on Linux,
    making, removing or renaming anything at the top of a folder without
    git (a file in place there, and anything in its subfolders, still
    writes); and on macOS the system `mktemp` without a directory (it asks
    `confstr`, not `TMPDIR`; `mktemp -p "$TMPDIR"` works). Node, Python, Go
    and Rust honour `TMPDIR`.
  - Known MCP servers that fail on macOS: Playwright MCP
    (`@playwright/mcp` 0.0.83, run here through the launcher: "EPERM:
    operation not permitted, mkdir '~/Library'": it keeps a server
    registry in `~/Library/Caches/ms-playwright/b`, also with
    `--isolated`; it works on Linux, where it follows `XDG_CACHE_HOME`).
    That dir also holds the browsers Playwright runs outside the sandbox,
    so it stays read-only. stdio OAuth bridges such as `mcp-remote`
    (read in its source, not run) store tokens in `~/.mcp-auth` unless
    `MCP_REMOTE_CONFIG_DIR` points elsewhere, and their `open` is refused
    (the sign-in URL goes only to the server's stderr): use the marketplace's
    remote server with connector credentials instead.
- **No LaunchServices** (macOS): `open` is refused, so a plugin cannot run a
  `.command` script in Terminal. An MCP server that opens a browser for
  sign-in must print the URL instead.
- **No signals out** (a SIGUSR1 opens an inspector in any Node process that
  lacks `--disable-sigusr1`, which is code execution there). On macOS the
  profile refuses signals to any process outside the plugin's own sandbox
  (it still signals its own descendants, by pid or process group). With
  bubblewrap the pid namespace hides every other process. Belt and braces:
  the launcher, the ACP bridge (`selfInvocationArgs`), the runtime that
  `caveman code` starts and the desktop app's runtime all run with
  `--disable-sigusr1`. With the environment filter alone (no sandbox) a
  plugin can signal any of the user's processes.
- **Copies are re-hashed.** A marketplace checkout is hashed when made and
  re-hashed the first time a runtime uses it (hashing every checkout on every
  read took seconds); one gone from disk is fetched again. The Claude Agent
  plugin copy (`<state>/plugins/claude/<name>-<key>`) is hashed when made and
  re-hashed when its stat stamp moves. A changed one is rebuilt.
  The digest sits beside the copy, so this catches accidental change, not
  tampering: plugin processes cannot write either (the state dir is
  read-only to them), but anything that can rewrite the copy, such as the
  agent's unsandboxed Bash, can rewrite the digest too.

## What stays open, and why

- **Same-user environment reads on macOS.** Any process of the user,
  including a sandboxed plugin, can read another process's environment via
  `sysctl(KERN_PROCARGS2)` (what `ps eww` uses). `(deny process-info*)` and
  `(deny sysctl-read (sysctl-name "kern.procargs2"))` do not stop it; denying
  all sysctl reads breaks every program. So a credential granted to one plugin
  is visible to the other plugins running at the same time, and any API key in
  an engine's environment is visible to plugins. On Linux with bubblewrap the
  pid namespace hides other processes.
- **Keychain items with permissive ACLs (macOS).** `security
  find-generic-password` reaches the login keychain through securityd even
  under `(deny mach-lookup)`; items whose ACL allows any app are readable.
  The keychain files themselves are denied.
- **Linux without user namespaces** (unprivileged containers, hardened
  hosts): bubblewrap cannot start, so plugins fall back to the environment
  filter alone: no file read or write containment. `PluginInfo.containment`
  says `env_filter` and the UI shows it as a warning. Landlock is not used.
- **`CLAUDE_ENV_FILE` is code in the engine's shell.** Claude Code runs that
  file before each Bash command, outside the plugin sandbox. Claude 2.1.300
  hands a writable one to `SessionStart`, `Setup`, `CwdChanged` and
  `FileChanged` hooks, which may append to it by design (that is how plugins
  set up environments), so a hostile hook of any of those four events can
  run code in the agent's next Bash command. The sandbox opens only the
  directory Claude names under its `session-env`, never a user-set path.
- **The worktree's contents run later, outside the sandbox.** A plugin that
  can edit the code can plant code in it: package scripts,
  `node_modules/.bin`, a Makefile, `.envrc`, `.mcp.json`, symlinks. The
  agent, terminals and the Run button run or follow them unsandboxed, as
  they would a teammate's commit. Only what runs without anyone choosing it
  (`.git`, `.caveman`, `.claude`) is protected.
- **IPC beyond files (macOS).** sandbox-exec here allows everything it does
  not deny. Apple Events (`osascript`) need the user's Automation consent,
  which macOS prompts for. Not denied and not verified: preference writes
  through `cfprefsd` (`defaults write` to another app's domain) and launchd
  jobs submitted over IPC (`launchctl submit`).
- **One package cache and temp dir for all plugins.** A plugin can plant a
  package in the shared cache that another plugin's `npx` then runs, with
  that plugin's granted credentials, or tamper with another plugin's temp
  files. Per-plugin caches would close it.
- **Network.** Plugin processes keep full network access (unix sockets to the
  user's launchd agents and to sockets under denied dirs are refused).
- **Engines are not sandboxed by this.** Claude Agent and Codex run with the
  user's environment minus the runtime's own variables (`withoutRuntimeEnv`),
  ACP agents with an allowlisted environment and a home of their own, each
  under its own permission mode; this file covers plugin processes only.
