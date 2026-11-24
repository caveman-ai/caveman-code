// Starts a plugin process (MCP server, hook, LSP server or monitor) contained:
// - Environment: only the names in `keep` from what the engine passed, plus the
//   plugin's own variables. Those arrive as CAVEMAN_PLUGIN_ENV_<NAME> so they
//   never configure this node process (a plugin's NODE_OPTIONS would otherwise
//   run its code here, before anything is filtered).
// - Credentials: `secrets` names a 0600 JSON file of brokered values. They are
//   read here and set for the child only, so they never sit in the engine's
//   config, in this process's environment or in any argv.
// - Files: `deny` paths are neither readable nor writable; `read` paths (inside
//   a denied one) are readable again. With `write`, the process writes only
//   there (`writeRoots`): the session's worktree minus `PROTECTED`, and `cache`
//   (set as its XDG_CACHE_HOME and npm cache, with a private temp dir set as
//   TMPDIR; the user's TMPDIR and /tmp stay read-only). `sandbox` says how:
//   "macos" (sandbox-exec; also refuses signals to anything outside this
//   sandbox), "bwrap" (bubblewrap, Linux; also hides other
//   processes), or "none" (the environment filter alone).
// Run with --disable-sigusr1: a SIGUSR1 must not open an inspector in this
// unsandboxed process, where it would hand the plugin its way out.
// Usage: node sandboxLaunch.mjs '{"keep":[...],"deny":[...],"read":[...],"write":[...],"cache":"...","worktrees":"...","sandbox":"...","secrets":"..."}' <command> [args...]
// (or the same JSON as base64url:<base64url>, how a hook's crosses Git Bash on Windows).
// Plain .mjs with no local imports so it runs unchanged beside a packaged runtime.
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { constants, homedir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PREFIX = "CAVEMAN_PLUGIN_ENV_";
/** What any Windows process needs, kept beside `keep` there (as @caveman-app/shared/processEnv's list). None is a credential. */
const WINDOWS_ESSENTIAL_ENV = ["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];

/**
 * The names in `keep` from `source`, plus on Windows its essentials. Windows matches names ignoring case (its
 * `Path` is PATH) and keeps each under the name `source` uses.
 */
export function keptEnv(source, keep, platform = process.platform) {
  const env = {};
  const wanted = new Set((platform === "win32" ? [...keep, ...WINDOWS_ESSENTIAL_ENV] : keep).map((name) => (platform === "win32" ? name.toUpperCase() : name)));
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && wanted.has(platform === "win32" ? name.toUpperCase() : name)) env[name] = value;
  }
  return env;
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const envGet = (env, name) => env[Object.keys(env).find((key) => key.toUpperCase() === name) ?? name];
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/** One argument for cmd.exe's /s /c line and the program's CommandLineToArgvW (as shared/shell's escapeWindowsShellArg). */
const cmdArg = (arg) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(CMD_META, "^$1");

/**
 * How Windows starts `command`: found on the child's PATH with PATHEXT when it names no directory (an MCP server
 * is often `npx` or `uvx`), and a .cmd or .bat shim, which CreateProcess cannot run, through cmd.exe as one
 * escaped line (as shared/shell's resolveSpawnCommand). Elsewhere `command` as it is.
 */
export function spawnTarget(command, args, env, platform = process.platform, exists = isFile) {
  if (platform !== "win32") return { file: command, args, shell: false };
  const win = path.win32;
  const extensions = (envGet(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const named = win.extname(command) === "" ? extensions.map((e) => command + e) : [command];
  const candidates =
    command.includes("/") || command.includes("\\")
      ? named
      : (envGet(env, "PATH") ?? "").split(";").filter(Boolean).flatMap((dir) => named.map((name) => win.join(dir.replace(/^"|"$/g, ""), name)));
  const found = candidates.find(exists) ?? command;
  if (![".cmd", ".bat"].includes(win.extname(found).toLowerCase())) return { file: found, args, shell: false };
  return { file: [found, ...args].map(cmdArg).join(" "), args: [], shell: true };
}
/**
 * Entries of a write root that stay read-only: what the runtime or an engine
 * later runs outside the sandbox. A worktree's .git (hooks, config, the gitdir
 * pointer), .caveman (computer.toml [setup]/[run]/[archive] and [env]) and
 * .claude (project settings hooks Claude Agent loads).
 */
export const PROTECTED = [".git", ".caveman", ".claude"];

/** The real path of `p`, resolving the part that exists (sandboxes match real paths). */
export function real(p) {
  let rest = "";
  for (let dir = p; ; ) {
    try {
      return path.join(realpathSync(dir), rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return p;
      rest = path.join(path.basename(dir), rest);
      dir = parent;
    }
  }
}

const strictlyInside = (dir, p) => p.startsWith(dir + path.sep);
const within = (dir, p) => dir !== undefined && p !== undefined && strictlyInside(real(dir), real(p));
/** A path Claude Code hands a hook in `name`: read only when the policy keeps it (servers never do, hooks do). */
const handed = (policy, env, name) => ((policy.keep ?? []).includes(name) && path.isAbsolute(env[name] ?? "") ? env[name] : undefined);
/** The session's worktree a hook is handed (CLAUDE_PROJECT_DIR), only inside `worktrees`. */
const projectDir = (policy, env) => {
  const project = handed(policy, env, "CLAUDE_PROJECT_DIR");
  return within(policy.worktrees, project) ? project : undefined;
};

/**
 * Where a process may write, or undefined for no limit (a policy without
 * `write`): the policy's roots and its cache, plus what Claude Code hands a
 * hook, each only where Claude puts it so an inherited value opens nothing
 * more: the session's worktree (CLAUDE_PROJECT_DIR, inside `worktrees`),
 * CLAUDE_PLUGIN_DATA (inside <claude config>/plugins/data) and the
 * CLAUDE_ENV_FILE directory (inside <claude config>/session-env). Only names
 * in `keep` are read: servers never get them, hooks do.
 */
export function writeRoots(policy, env) {
  if (policy.write === undefined) return undefined;
  const roots = [...policy.write];
  if (policy.cache !== undefined) roots.push(policy.cache);
  const from = (name) => handed(policy, env, name);
  // HOME is not set on Windows: the profile directory, as Claude Code finds it.
  const home = env.HOME || (process.platform === "win32" ? homedir() : undefined);
  const claude = env.CLAUDE_CONFIG_DIR || (home ? path.join(home, ".claude") : undefined);
  const project = projectDir(policy, env);
  if (project !== undefined) roots.push(project);
  const data = from("CLAUDE_PLUGIN_DATA");
  if (claude !== undefined && within(path.join(claude, "plugins", "data"), data)) roots.push(data);
  const envFile = from("CLAUDE_ENV_FILE");
  const envDir = envFile === undefined ? undefined : path.dirname(envFile);
  if (claude !== undefined && within(path.join(claude, "session-env"), envDir)) roots.push(envDir);
  return roots;
}

/**
 * The write roots a session works in, whose `PROTECTED` entries something
 * later runs: the policy's own and the worktree a hook is handed. Not the
 * cache, CLAUDE_PLUGIN_DATA or the CLAUDE_ENV_FILE dir.
 */
export function workFolders(policy, env) {
  if (policy.write === undefined) return [];
  const project = projectDir(policy, env);
  return [...policy.write, ...(project === undefined ? [] : [project])];
}

/**
 * sandbox-exec argv for `command` (the last matching rule wins): with `write`,
 * no writes but under those roots and /dev, never into a root's `PROTECTED`
 * entries (a planted git hook, config or gitdir pointer runs at the next git
 * command); then the denied paths, then read rules. Signals reach only
 * processes in this sandbox: a SIGUSR1 to a same-user Node process outside
 * (the runtime, the desktop app) would open an inspector there.
 */
export function sandboxExecArgv(deny, read, command, args, write) {
  const params = [];
  const rules = ["(version 1)", "(allow default)"];
  const denied = deny.map(real);
  const gits = [];
  if (write !== undefined) {
    rules.push("(deny file-write*)", '(allow file-write* (subpath "/dev"))');
    write.map(real).forEach((p, i) => {
      params.push("-D", `W${i}=${p}`);
      rules.push(`(allow file-write* (subpath (param "W${i}")))`);
      for (const name of PROTECTED) gits.push(real(path.join(p, name)));
    });
    // After every allow: a root inside another root's .git stays read-only.
    gits.forEach((p, i) => {
      params.push("-D", `G${i}=${p}`);
      rules.push(`(deny file-write* (subpath (param "G${i}")))`);
    });
  }
  denied.forEach((p, i) => {
    params.push("-D", `D${i}=${p}`);
    // Metadata stays readable: path lookups (realpath, stat) walk through these directories.
    rules.push(`(deny file-read-data file-read-xattr file-write* (subpath (param "D${i}")))`);
    // A denied dir may hold an agent socket (gpg-agent lives under ~/.gnupg): block it too.
    rules.push(`(deny network-outbound (remote unix-socket (subpath (param "D${i}"))))`);
  });
  // Block renaming or replacing any ancestor of a denied path or a .git. `(subpath)` matches
  // the path text, so moving a parent aside would leave the secret at a path the deny no
  // longer matches; `(literal ancestor)` refuses the rename at its source.
  const ancestors = new Set();
  for (const p of [...denied, ...gits]) for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) ancestors.add(d);
  [...ancestors].forEach((p, i) => {
    params.push("-D", `A${i}=${p}`);
    rules.push(`(deny file-write* (literal (param "A${i}")))`);
  });
  read.forEach((p, i) => {
    params.push("-D", `R${i}=${real(p)}`);
    rules.push(`(allow file-read-data file-read-xattr (subpath (param "R${i}")))`);
  });
  // No reaching the user's agents over their launchd sockets even when the path is guessed
  // (SSH_AUTH_SOCK is filtered from the environment, but its path is predictable).
  rules.push(
    `(deny network-outbound` +
      ` (remote unix-socket (path-regex #"^/private/var/run/com\\.apple\\.launchd\\."))` +
      ` (remote unix-socket (path-regex #"^/private/tmp/com\\.apple\\.launchd\\.")))`,
  );
  // No LaunchServices opens: `open x.command` runs a script in Terminal, outside the sandbox.
  rules.push("(deny lsopen)");
  // Signals only inside this sandbox (itself and every descendant, so tree and group kills
  // work): never a sibling plugin or a same-user process outside, whose SIGUSR1 opens an inspector.
  rules.push("(deny signal)", "(allow signal (target same-sandbox))");
  return ["/usr/bin/sandbox-exec", [...params, "-p", rules.join("\n"), "--", command, ...args]];
}

const kindOf = (p) => {
  try {
    return lstatSync(p).isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
};

/** The directories and files in `dir`, never a link: bubblewrap would bind where it leads. */
const entriesOf = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() || entry.isFile() ? [entry.name] : []));
  } catch {
    return [];
  }
};

/**
 * bwrap argv for `command`: the host filesystem (read-only with `write`, then
 * each existing write root bound writable and its existing `PROTECTED`
 * entries bound back read-only; `main` creates a worktree's missing ones),
 * a denied directory replaced by an empty read-only tmpfs and a denied file by
 * /dev/null, `read` paths bound back read-only, and a fresh pid namespace so
 * /proc shows no other process (and so no other process's environment), a
 * fresh session so it cannot inject keystrokes into the controlling terminal
 * (TIOCSTI). Paths that do not exist are skipped: bwrap would create them on
 * the host. A mount point cannot be renamed, so no parent can be moved aside.
 * One of the `folders` (`workFolders`) without a .git gets nothing made in
 * it: an empty .git would make it read as a repository (a project's no_git,
 * a Cloud checkout still to clone). Instead its top level stays read-only and
 * each thing already in it but a `PROTECTED` entry is bound writable, so
 * nothing can be added, removed or renamed there.
 */
export function bwrapArgv(deny, read, command, args, kind = kindOf, write, folders = [], entries = entriesOf) {
  const argv =
    write === undefined ? ["--dev-bind", "/", "/"] : ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev"];
  argv.push("--unshare-pid", "--proc", "/proc", "--new-session", "--die-with-parent");
  if (write !== undefined) {
    const roots = write.map(real).filter((p) => kind(p) === "dir");
    const plain = new Set(folders.map(real).filter((p) => kind(path.join(p, ".git")) === undefined));
    for (const p of roots) {
      if (!plain.has(p)) argv.push("--bind", p, p);
      else for (const name of entries(p)) if (!PROTECTED.includes(name)) argv.push("--bind", path.join(p, name), path.join(p, name));
    }
    for (const p of roots.flatMap((r) => PROTECTED.map((name) => real(path.join(r, name))))) {
      if (kind(p) !== undefined) argv.push("--ro-bind", p, p);
    }
  }
  const dirs = [];
  for (const p of deny.map(real)) {
    const k = kind(p);
    if (k === "dir") {
      argv.push("--tmpfs", p);
      dirs.push(p);
    } else if (k === "file") argv.push("--ro-bind", "/dev/null", p);
  }
  for (const p of read.map(real)) if (kind(p) !== undefined) argv.push("--ro-bind", p, p);
  for (const p of dirs) argv.push("--remount-ro", p);
  return ["bwrap", [...argv, "--", command, ...args]];
}

/**
 * Where the user's agents listen (ssh-agent, gpg-agent, the session bus under
 * XDG_RUNTIME_DIR): bubblewrap hides each behind a tmpfs, after the write
 * binds. A socket straight in a shared dir (/tmp) is hidden on its own, never
 * the dir: a tmpfs over /tmp would hide repositories cloned there.
 */
export function agentSocketPaths(env, kind = kindOf) {
  const shared = new Set(["/", "/tmp", "/var/tmp", "/run", "/var/run"]);
  const out = [];
  for (const p of [env.XDG_RUNTIME_DIR, env.GNUPGHOME, env.SSH_AUTH_SOCK, env.GPG_AGENT_INFO?.split(":")[0]]) {
    if (typeof p !== "string" || !path.isAbsolute(p) || shared.has(path.resolve(p))) continue;
    const dir = kind(p) === "dir" ? p : path.dirname(p);
    out.push(shared.has(path.resolve(dir)) ? p : dir);
  }
  return [...new Set(out)];
}

function main() {
  const refuse = (message) => {
    process.stderr.write(`sandboxLaunch: ${message}\n`);
    process.exit(2);
  };
  const [policyArg = "", command, ...args] = process.argv.slice(2);
  if (command === undefined) refuse("usage: sandboxLaunch.mjs <policy json> <command> [args...]");
  // A hook's policy on Windows crosses Git Bash as base64url JSON (resolve.ts's POLICY_BASE64).
  const policyJson = policyArg.startsWith("base64url:") ? Buffer.from(policyArg.slice("base64url:".length), "base64url").toString("utf8") : policyArg;
  let policy;
  try {
    policy = JSON.parse(policyJson);
  } catch {
    refuse("the policy is not JSON");
  }
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) refuse("the policy is not an object");
  const list = (value) =>
    Array.isArray(value) && value.every((v) => typeof v === "string") ? value : null;
  const keep = list(policy?.keep ?? []);
  const deny = list(policy?.deny ?? []);
  const read = list(policy?.read ?? []);
  if (keep === null || !keep.every((name) => NAME.test(name))) refuse("keep must be variable names");
  const write = policy?.write === undefined ? [] : list(policy.write);
  const dirs = [policy?.cache, policy?.worktrees].filter((p) => p !== undefined);
  if (deny === null || read === null || write === null || ![...deny, ...read, ...write, ...dirs].every((p) => typeof p === "string" && path.isAbsolute(p))) {
    refuse("deny, read, write, cache and worktrees must be absolute paths");
  }
  // Policies written before `sandbox` existed meant sandbox-exec on macOS.
  const sandbox = policy?.sandbox ?? (process.platform === "darwin" ? "macos" : "none");
  if (!["macos", "bwrap", "none"].includes(sandbox)) refuse("sandbox must be macos, bwrap or none");

  const env = keptEnv(process.env, keep);
  if (policy.cache !== undefined) {
    // HOME is not writable: package managers get a cache they can write (npx, uvx).
    // The user's TMPDIR and /tmp are not either (executables there run outside, such as a
    // terminal's CLI shims): temp files go to a private dir.
    // ponytail: one temp dir for every plugin, like the cache; per session if that matters.
    const tmp = path.join(policy.cache, "tmp");
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    env.XDG_CACHE_HOME = policy.cache;
    env.npm_config_cache = path.join(policy.cache, "npm");
    env.TMPDIR = env.TMP = env.TEMP = tmp;
  }
  for (const [name, value] of Object.entries(process.env)) {
    const own = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : "";
    if (NAME.test(own)) env[own] = value;
  }
  if (policy?.secrets !== undefined) {
    const file = policy.secrets;
    if (typeof file !== "string" || !path.isAbsolute(file)) refuse("secrets must be an absolute path");
    let values;
    try {
      // Only a file nobody else can read: the runtime writes it 0600. Windows has no mode bits (every file
      // reads 0666): there the state dir's place in the person's profile, whose ACL is theirs, keeps it.
      if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) refuse("the secrets file is readable by others");
      values = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      refuse("cannot read the secrets file");
    }
    for (const [name, value] of Object.entries(values ?? {})) {
      if (NAME.test(name) && typeof value === "string") env[name] = value;
    }
  }

  const roots = writeRoots(policy, process.env);
  if (sandbox === "bwrap" && roots !== undefined) {
    // bubblewrap can only bind what exists: a worktree gets its protected dirs, empty
    // (git does not see an empty dir), so the plugin cannot create them.
    for (const root of roots) {
      if (kindOf(path.join(root, ".git")) === undefined) continue;
      for (const name of PROTECTED) {
        try {
          mkdirSync(path.join(root, name));
        } catch {
          // Already there (bound read-only as it is), or the root is gone.
        }
      }
    }
  }
  const [file, argv] =
    sandbox === "macos" && (deny.length > 0 || roots !== undefined)
      ? sandboxExecArgv(deny, read, command, args, roots)
      : sandbox === "bwrap"
        ? bwrapArgv([...deny, ...agentSocketPaths(process.env)], read, command, args, undefined, roots, workFolders(policy, process.env))
        : [command, args];

  const target = spawnTarget(file, argv, env);
  const child = spawn(target.file, target.args, { stdio: "inherit", env, shell: target.shell, windowsHide: true });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    process.stderr.write(`${command}: ${error.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) =>
    process.exit(signal === null ? (code ?? 1) : 128 + (constants.signals[signal] ?? 0)),
  );
}

// Run as a script; imported (tests) it only exports the argv builders.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(real(process.argv[1])).href) main();
