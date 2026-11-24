// Real git commits through the runtime's hooks directory, as an engine's tool processes make them.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TOOLS_EXEC, toolsRun } from "../cloudLink/tools.ts";
import { CAVEMAN_CO_AUTHOR } from "./coAuthor.ts";
import { coAuthorGitEnv, SECRET_NAMES_ENV, setCoAuthorFlag, setToolsCoAuthorFlag, TOOLS_HOOKS_DIR, writeCoAuthorHooks, writeToolsCoAuthorHooks } from "./coAuthorHooks.ts";

const CLAUDE = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
let root: string;
let repo: string;
let hooks: string;
// The user's own environment: no GIT_CONFIG_* of theirs, a fixed identity, no global or system config.
const userEnv = () => ({
  PATH: process.env.PATH ?? "",
  HOME: root,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
  GIT_AUTHOR_NAME: "U",
  GIT_AUTHOR_EMAIL: "u@example.com",
  GIT_COMMITTER_NAME: "U",
  GIT_COMMITTER_EMAIL: "u@example.com",
});
const agentEnv = () => ({ ...userEnv(), ...coAuthorGitEnv(hooks, userEnv()) });
const git = (cwd: string, args: string[], env: Record<string, string> = userEnv()) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
const commit = (cwd: string, message: string, env = agentEnv()) => {
  fs.appendFileSync(path.join(cwd, "f.txt"), `${message}\n`);
  git(cwd, ["add", "f.txt"], env);
  return spawnSync("git", ["commit", "-q", "-m", message], { cwd, env, encoding: "utf8" });
};
const lastMessage = (cwd: string) => git(cwd, ["log", "-1", "--format=%B"]).trimEnd();
const ownHook = (dir: string, name: string, body: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "co-author-hooks-")));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(root, "gitconfig"), "");
  git(repo, ["init", "-q", "-b", "main"]);
  hooks = writeCoAuthorHooks(path.join(root, "state"));
  setCoAuthorFlag(hooks, true);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const shims = () => Object.fromEntries(fs.readdirSync(hooks).map((name) => [name, fs.readFileSync(path.join(hooks, name), "utf8")]));

describe("the runtime's commit-msg hook", () => {
  it("adds Caveman's trailer to an agent's commit once, keeping its other trailers", () => {
    expect(commit(repo, `feat: a\n\n${CLAUDE}`).status).toBe(0);
    expect(lastMessage(repo)).toBe(`feat: a\n\n${CLAUDE}\n${CAVEMAN_CO_AUTHOR}`);
    // Already there (any case): not added again.
    expect(commit(repo, `feat: b\n\n${CAVEMAN_CO_AUTHOR.toLowerCase()}`).status).toBe(0);
    expect(lastMessage(repo)).toBe(`feat: b\n\n${CAVEMAN_CO_AUTHOR.toLowerCase()}`);
    expect(git(repo, ["commit", "-q", "--amend", "--no-edit"], agentEnv())).toBe("");
    expect(lastMessage(repo).match(/co-authored-by: caveman/gi)?.length).toBe(1);
  });

  it("leaves the user's own commits alone, and follows the setting at commit time", () => {
    expect(commit(repo, "feat: mine", userEnv()).status).toBe(0);
    expect(lastMessage(repo)).toBe("feat: mine");
    setCoAuthorFlag(hooks, false);
    expect(commit(repo, "feat: off").status).toBe(0);
    expect(lastMessage(repo)).toBe("feat: off");
    setCoAuthorFlag(hooks, true);
    expect(commit(repo, "feat: on").status).toBe(0);
    expect(lastMessage(repo)).toBe(`feat: on\n\n${CAVEMAN_CO_AUTHOR}`);
  });

  it("runs the repository's own hooks with their exit codes, from .git/hooks or its core.hooksPath", () => {
    ownHook(path.join(repo, ".git", "hooks"), "commit-msg", 'echo "Signed-off-by: Hook <h@example.com>" >> "$1"');
    expect(commit(repo, "feat: chained").status).toBe(0);
    expect(lastMessage(repo)).toBe(`feat: chained\n\n${CAVEMAN_CO_AUTHOR}\nSigned-off-by: Hook <h@example.com>`);

    // A husky-style local core.hooksPath (relative) still runs, and its refusal stops the commit.
    git(repo, ["config", "core.hooksPath", ".husky"]);
    ownHook(path.join(repo, ".husky"), "pre-commit", "echo refused >&2; exit 3");
    const refused = commit(repo, "feat: refused");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("refused");
    expect(lastMessage(repo)).toBe(`feat: chained\n\n${CAVEMAN_CO_AUTHOR}\nSigned-off-by: Hook <h@example.com>`);
  });

  it("works in a linked worktree, whose hooks live in the common directory", () => {
    expect(commit(repo, "chore: base", userEnv()).status).toBe(0);
    const tree = path.join(root, "tree");
    git(repo, ["worktree", "add", "-q", "-b", "agent", tree]);
    ownHook(path.join(repo, ".git", "hooks"), "post-commit", `touch "${path.join(root, "post-commit-ran")}"`);
    expect(commit(tree, "feat: in a worktree").status).toBe(0);
    expect(lastMessage(tree)).toBe(`feat: in a worktree\n\n${CAVEMAN_CO_AUTHOR}`);
    expect(fs.existsSync(path.join(root, "post-commit-ran"))).toBe(true);
  });

  it("keeps an empty message an aborted commit", () => {
    for (const env of [userEnv(), agentEnv()]) {
      fs.appendFileSync(path.join(repo, "f.txt"), "x\n");
      git(repo, ["add", "f.txt"], env);
      const empty = spawnSync("git", ["commit", "-q", "-m", ""], { cwd: repo, env, encoding: "utf8" });
      expect(empty.status).not.toBe(0);
      expect(empty.stderr).toContain("empty commit message");
      // An editor that leaves only the template's comments.
      const edited = spawnSync("git", ["commit", "-q"], { cwd: repo, env: { ...env, GIT_EDITOR: "true" }, encoding: "utf8" });
      expect(edited.status).not.toBe(0);
    }
    expect(spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, env: userEnv() }).status).not.toBe(0);
  });

  it("refuses a hook installer run from an engine's shell instead of letting it replace the hooks; GIT_CONFIG_COUNT=0 installs into the repository", () => {
    const before = shims();
    // What lefthook and the like do: write their hook where git says the hooks are.
    const install = (env: Record<string, string>) =>
      spawnSync("sh", ["-c", 'printf "#!/bin/sh\necho installed-hook-ran >&2\n" > "$(git rev-parse --git-path hooks)/pre-commit" && chmod +x "$(git rev-parse --git-path hooks)/pre-commit"'], { cwd: repo, env, encoding: "utf8" });
    expect(install(agentEnv()).status).not.toBe(0);
    expect(shims()).toEqual(before);
    expect(fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(fs.readFileSync(path.join(hooks, "README"), "utf8")).toContain("GIT_CONFIG_COUNT=0");
    // As the README says: the installer then sees the repository's own hooks directory, and engines' commits run what it wrote.
    expect(install({ ...agentEnv(), GIT_CONFIG_COUNT: "0" }).status).toBe(0);
    expect(shims()).toEqual(before);
    const ran = commit(repo, "feat: after install");
    expect(ran.status).toBe(0);
    expect(ran.stderr).toContain("installed-hook-ran");
    expect(lastMessage(repo)).toBe(`feat: after install\n\n${CAVEMAN_CO_AUTHOR}`);
    expect(spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: repo, env: userEnv() }).status).toBe(1);
  });

  it.skipIf(spawnSync("pre-commit", ["--version"]).status !== 0)("leaves the user's repository as it was when pre-commit install runs from an engine's shell", () => {
    const before = shims();
    const run = spawnSync("pre-commit", ["install"], { cwd: repo, env: agentEnv(), encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(shims()).toEqual(before);
    expect(fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: repo, env: userEnv() }).status).toBe(1);
    expect(spawnSync("pre-commit", ["install"], { cwd: repo, env: { ...agentEnv(), GIT_CONFIG_COUNT: "0" }, encoding: "utf8" }).status).toBe(0);
    expect(fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(shims()).toEqual(before);
  });

  it("puts back a hook something replaced, and drops what it added, on the next write", () => {
    const before = shims();
    // A rename-based installer can still swap a file in (the directory stays writable, so state cleanup works).
    // Windows refuses a rename over a read-only file, so an installer there deletes it first.
    fs.writeFileSync(path.join(hooks, "x.tmp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    if (process.platform === "win32") fs.rmSync(path.join(hooks, "commit-msg"));
    fs.renameSync(path.join(hooks, "x.tmp"), path.join(hooks, "commit-msg"));
    fs.writeFileSync(path.join(hooks, "lefthook-runner"), "");
    expect(writeCoAuthorHooks(path.join(root, "state"))).toBe(hooks);
    expect(shims()).toEqual(before);
    // Windows keeps only a read-only flag, which reads as 0444.
    expect(fs.statSync(path.join(hooks, "commit-msg")).mode & 0o777).toBe(process.platform === "win32" ? 0o444 : 0o555);
  });

  it("leaves out the hooks git runs several times per commit, and drops ones an older runtime wrote", () => {
    fs.writeFileSync(path.join(hooks, "reference-transaction"), "#!/bin/sh\n", { mode: 0o755 });
    expect(writeCoAuthorHooks(path.join(root, "state"))).toBe(hooks);
    const names = fs.readdirSync(hooks);
    expect(names).toContain("commit-msg");
    expect(names).toContain("co-author-on");
    expect(names).not.toContain("reference-transaction");
    expect(names).not.toContain("post-index-change");
  });

  it("appends after the environment's own GIT_CONFIG entries instead of replacing them", () => {
    const base = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "From Env" };
    expect(coAuthorGitEnv(hooks, base)).toEqual({ ...base, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: hooks });
    const env = { ...userEnv(), GIT_COMMITTER_NAME: "", ...coAuthorGitEnv(hooks, base) };
    delete (env as Record<string, string>).GIT_COMMITTER_NAME;
    expect(commit(repo, "feat: env", env as never).status).toBe(0);
    expect(git(repo, ["log", "-1", "--format=%cn"]).trim()).toBe("From Env");
    expect(lastMessage(repo)).toBe(`feat: env\n\n${CAVEMAN_CO_AUTHOR}`);
  });
});

describe("the runtime's secret scan on engines' commits and pushes", () => {
  const TOKEN = "cvs-live-4f9a2b7c1d8e6a3f";
  const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n-----END PRIVATE KEY-----";
  // What the runtime gives an engine: the values, and the hidden ones' names (EngineEgress engineSecretEnv).
  const secretEnv = () => ({ ...agentEnv(), DEPLOY_TOKEN: TOKEN, TLS_KEY: PEM, [SECRET_NAMES_ENV]: "DEPLOY_TOKEN TLS_KEY" });
  const stage = (cwd: string, file: string, text: string, env: Record<string, string>) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.appendFileSync(path.join(cwd, file), text);
    git(cwd, ["add", file], env);
  };
  const tryCommit = (cwd: string, message: string, env: Record<string, string>) => spawnSync("git", ["commit", "-q", "-m", message], { cwd, env, encoding: "utf8" });
  const head = (cwd: string) => spawnSync("git", ["rev-parse", "-q", "--verify", "HEAD"], { cwd, env: userEnv(), encoding: "utf8" }).stdout.trim();

  it("refuses an engine's commit that adds a secret's value, naming the secret and file but never the value", () => {
    expect(commit(repo, "chore: base", secretEnv()).status).toBe(0);
    const before = head(repo);
    stage(repo, "config/deploy.ts", `export const token = "${TOKEN}";\n`, secretEnv());
    const refused = tryCommit(repo, "feat: deploy", secretEnv());
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Caveman Code refused this commit");
    expect(refused.stderr).toContain("DEPLOY_TOKEN in config/deploy.ts");
    expect(refused.stderr + refused.stdout).not.toContain(TOKEN);
    expect(head(repo)).toBe(before);
    // A line of a multi-line value (a PEM key) is caught too.
    git(repo, ["reset", "-q"], userEnv());
    fs.rmSync(path.join(repo, "config"), { recursive: true });
    stage(repo, "certs/key.pem", `${PEM.split("\n")[1]}\n`, secretEnv());
    expect(tryCommit(repo, "feat: key", secretEnv()).stderr).toContain("TLS_KEY in certs/key.pem");
    // Using the variable is fine.
    git(repo, ["reset", "-q"], userEnv());
    fs.rmSync(path.join(repo, "certs"), { recursive: true });
    stage(repo, "config/deploy.ts", "export const token = process.env.DEPLOY_TOKEN;\n", secretEnv());
    expect(tryCommit(repo, "feat: deploy from env", secretEnv()).status).toBe(0);
  });

  it("leaves the person's own commits, a value already in the repository and a commit removing it alone", () => {
    // The person commits the value themselves: their git has no names, so nothing is refused.
    stage(repo, "legacy.env.example", `TOKEN=${TOKEN}\n`, userEnv());
    expect(tryCommit(repo, "chore: theirs", userEnv()).status).toBe(0);
    // An engine's unrelated change in the same repository, then its removal of the value.
    stage(repo, "README.md", "hello\n", secretEnv());
    expect(tryCommit(repo, "docs: readme", secretEnv()).status).toBe(0);
    fs.writeFileSync(path.join(repo, "legacy.env.example"), "TOKEN=\n");
    git(repo, ["add", "legacy.env.example"], secretEnv());
    expect(tryCommit(repo, "fix: drop the token", secretEnv()).status).toBe(0);
  });

  it("refuses an engine's push of commits that add a value, hands the refs on to the repository's own pre-push hook, and lets a clean push through", () => {
    const remote = path.join(root, "remote.git");
    git(root, ["init", "-q", "--bare", "remote.git"]);
    git(repo, ["remote", "add", "origin", remote]);
    expect(commit(repo, "chore: base", userEnv()).status).toBe(0);
    git(repo, ["push", "-q", "origin", "main"], userEnv());
    // Committed past the hook (--no-verify), then pushed by the engine.
    stage(repo, "src/app.ts", `const t = "${TOKEN}";\n`, secretEnv());
    expect(spawnSync("git", ["commit", "-q", "--no-verify", "-m", "feat: app"], { cwd: repo, env: secretEnv() }).status).toBe(0);
    const refused = spawnSync("git", ["push", "-q", "origin", "main"], { cwd: repo, env: secretEnv(), encoding: "utf8" });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Caveman Code refused this push");
    expect(refused.stderr).toContain("DEPLOY_TOKEN in src/app.ts");
    expect(refused.stderr).not.toContain(TOKEN);
    // A new branch is scanned against what the remote already has.
    expect(spawnSync("git", ["push", "-q", "origin", "main:topic"], { cwd: repo, env: secretEnv(), encoding: "utf8" }).stderr).toContain("DEPLOY_TOKEN in src/app.ts");

    // Fixed in a new commit on a clean branch: the push goes through, and the repository's own hook gets the refs.
    git(repo, ["reset", "-q", "--hard", "origin/main"], userEnv());
    ownHook(path.join(repo, ".git", "hooks"), "pre-push", `cat > "${path.join(root, "pre-push-stdin")}"`);
    stage(repo, "src/app.ts", "const t = process.env.DEPLOY_TOKEN;\n", secretEnv());
    expect(tryCommit(repo, "feat: app from env", secretEnv()).status).toBe(0);
    const pushed = spawnSync("git", ["push", "-q", "origin", "main"], { cwd: repo, env: secretEnv(), encoding: "utf8" });
    expect(pushed.status).toBe(0);
    const refs = fs.readFileSync(path.join(root, "pre-push-stdin"), "utf8");
    expect(refs).toMatch(/^refs\/heads\/main [0-9a-f]{40} refs\/heads\/main [0-9a-f]{40}\n$/);
  });
});

// Skipped on Windows: a Cloud computer is a Linux pod, and its tools channel is a Unix socket.
describe.skipIf(process.platform === "win32")("on a Cloud computer, the hooks in its tools container", () => {
  // A tools side as the exec channel serves it, with a home of its own (the runtime's state directory is not there).
  let toolsRoot: string;
  let toolsHome: string;
  let socket: string;
  let server: ChildProcess;
  beforeAll(async () => {
    toolsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "co-author-tools-")));
    toolsHome = path.join(toolsRoot, "home");
    fs.mkdirSync(toolsHome);
    socket = path.join(toolsRoot, "tools.sock");
    server = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { PATH: process.env.PATH ?? "", HOME: toolsHome, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(socket) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  });
  afterAll(() => {
    server.kill();
    fs.rmSync(toolsRoot, { recursive: true, force: true });
  });
  const identity = { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" };
  const toolsCommit = async (message: string) => {
    fs.appendFileSync(path.join(repo, "f.txt"), `${message}\n`);
    const env = { ...identity, ...coAuthorGitEnv(TOOLS_HOOKS_DIR, {}) };
    expect((await toolsRun(socket, repo, ["git", "add", "f.txt"], env)).code).toBe(0);
    return toolsRun(socket, repo, ["git", "commit", "-q", "-m", message], env);
  };

  it("are written read-only under the tools user's home, follow the flag, and run the repository's own hooks", async () => {
    expect(await writeToolsCoAuthorHooks(socket, true)).toBe(true);
    const dir = path.join(toolsHome, ".caveman", "git-hooks");
    expect(fs.readFileSync(path.join(dir, "commit-msg"), "utf8")).toBe(fs.readFileSync(path.join(hooks, "commit-msg"), "utf8"));
    expect(fs.statSync(path.join(dir, "commit-msg")).mode & 0o777).toBe(0o555);
    expect(fs.existsSync(path.join(dir, "co-author-on"))).toBe(true);
    ownHook(path.join(repo, ".git", "hooks"), "commit-msg", 'echo "Hook-Ran: repo" >> "$1"');
    expect((await toolsCommit("feat: on a computer")).code).toBe(0);
    expect(lastMessage(repo)).toBe(`feat: on a computer\n\n${CAVEMAN_CO_AUTHOR}\nHook-Ran: repo`);

    expect(await setToolsCoAuthorFlag(socket, false)).toBe(true);
    expect((await toolsCommit("feat: off")).code).toBe(0);
    expect(lastMessage(repo)).toBe("feat: off\nHook-Ran: repo");

    // The next session start puts back a swapped hook and drops what was added, and sets the flag as the setting reads.
    fs.renameSync(path.join(dir, "commit-msg"), path.join(dir, "commit-msg.old"));
    fs.writeFileSync(path.join(dir, "commit-msg"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await writeToolsCoAuthorHooks(socket, true)).toBe(true);
    expect(fs.readdirSync(dir)).not.toContain("commit-msg.old");
    expect(fs.readFileSync(path.join(dir, "commit-msg"), "utf8")).toBe(fs.readFileSync(path.join(hooks, "commit-msg"), "utf8"));
    expect((await toolsCommit("feat: on again")).code).toBe(0);
    expect(lastMessage(repo)).toBe(`feat: on again\n\n${CAVEMAN_CO_AUTHOR}\nHook-Ran: repo`);
  });
});
