// The exec channel as the runtime uses it on a Cloud computer: every child but
// the runtime's own node goes to the tools side, with its cwd and the env it
// added; the runtime token never crosses; remote git runs on the runtime's
// mirror and tools only trades bundles with it. Here both sides are this uid;
// the kind proof runs them as two.
import { execFileSync, spawn, type ChildProcess as NodeChild } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";

import { ClaudeSettings } from "@caveman-app/protocol";
import { AgentScope } from "@caveman-app/shared/AgentScope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { checkClaudeProviderStatus, probeClaudeCapabilities } from "../provider/ClaudeProvider.ts";
import { gitOf, SAFE_GIT_CONFIG } from "../automations/steps.ts";
import { git as runtimeGit, runScripts, snapshotWorkInProgress } from "../session-protocol/lifecycle.ts";
import { FAKE_CLAUDE, makeRepo, tempRoot } from "../session-protocol/testHarness.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { ToolsEnv } from "@caveman-app/provider-caveman/server";

import { EngineCloudKeys, type EngineCloudKeysShape } from "./engineKeys.ts";
import { agentScope, envDelta, fetchViaMirror, githubCloneUrl, gitEnv, gitSaid, gitVerb, isPlumbing, pinnedLaunch, pushViaMirror, RUNTIME_GIT_EMAIL, spawnerLayer, TOOLS_EXEC, TOOLS_SHELL_ENV, toolsCommand, toolsExecutionBackend, toolsGit, toolsStream } from "./tools.ts";

const root = tempRoot("cloud-tools-");
const socket = path.join(root, "tools.sock");
// The tools side's own temp dir: what it makes there, it removes. Like a computer's, its git has no identity.
const toolsTmp = fs.mkdtempSync(path.join(root, "tools-tmp-"));
let server: NodeChild | undefined;

/** Runs `body` with `name` set to `value` in this process's environment. */
async function withEnv<A>(name: string, value: string, body: () => Promise<A>): Promise<A> {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}
/** As a Cloud computer's runtime: the computers service sets the tools address. */
const asCloudComputer = <A>(body: () => Promise<A>) => withEnv("CAVEMAN_RUNTIME_TOOLS_ADDRESS", socket, body);

// Skipped on Windows: a Cloud computer is Linux, and its tools channel is a Unix socket (net on Windows serves named pipes).
const WIN = process.platform === "win32";
const toolsSide = it.skipIf(WIN);

beforeAll(async () => {
  if (WIN) return;
  // TOOLS_SIDE marks a process the server started.
  server = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...process.env, TOOLS_SIDE: "yes", TMPDIR: toolsTmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(socket) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
});
afterAll(() => {
  server?.kill();
});

const layer = Layer.provideMerge(spawnerLayer(socket), Layer.mergeAll(NodeServices.layer, NodeCrypto.layer));
const output = (command: ChildProcess.Command) =>
  Effect.runPromise(Effect.flatMap(Effect.service(ChildProcessSpawner.ChildProcessSpawner), (spawner) => spawner.string(command)).pipe(Effect.provide(layer)));

toolsSide("runs a child on the tools side with its cwd and what its env adds; the runtime's own node stays here", async () => {
  const repo = makeRepo(tempRoot("cloud-tools-repo-"), { "a.txt": "a\n" });
  const routed = await output(ChildProcess.make("sh", ["-c", 'echo "$TOOLS_SIDE $PWD $ADDED"'], { cwd: repo, env: { ADDED: "added" } }));
  expect(routed.trim()).toBe(`yes ${fs.realpathSync(repo)} added`);
  expect((await output(ChildProcess.make("git", ["rev-parse", "--show-toplevel"], { cwd: repo }))).trim()).toBe(fs.realpathSync(repo));
  const own = await output(ChildProcess.make(process.execPath, ["-e", "console.log(process.env.TOOLS_SIDE ?? 'here')"]));
  expect(own.trim()).toBe("here");
});

toolsSide("a spawned child runs over the channel from here: stdin, stdout and stderr, its exit code, and a closed scope ends it", async () => {
  const dir = fs.mkdtempSync(path.join(root, "handle-"));
  const run = <A>(body: (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) => Effect.Effect<A, unknown, never>) =>
    Effect.runPromise(Effect.flatMap(Effect.service(ChildProcessSpawner.ChildProcessSpawner), body).pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);
  // Piped stdin reaches the command; both streams and the code come back.
  const got = await run((spawner) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", 'cat; echo "$TOOLS_SIDE" >&2; exit 4'], { cwd: dir }));
        yield* Stream.run(Stream.make(new TextEncoder().encode("piped in")), child.stdin);
        const [out, err, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(child.stdout)), Stream.mkString(Stream.decodeText(child.stderr)), child.exitCode], { concurrency: "unbounded" });
        return { out, err, code };
      }),
    ),
  );
  expect(got).toEqual({ out: "piped in", err: "yes\n", code: 4 });
  // A scope that closes while the command runs ends its process group.
  await run((spawner) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", `sleep 300 & echo $! > ${dir}/child; wait`], { cwd: dir }));
        for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, "child")); i++) yield* Effect.sleep("50 millis");
        expect(yield* child.isRunning).toBe(true);
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const pid = fs.readFileSync(path.join(dir, "child"), "utf8").trim();
  expect((await run((spawner) => spawner.exitCode(ChildProcess.make("kill", ["-0", pid])))) === 0).toBe(false);
});

toolsSide("starts an engine or terminal (AgentScope) in the directory its caller started it in, with the env it added", async () => {
  const repo = makeRepo(tempRoot("cloud-tools-agent-"), { "a.txt": "a\n" });
  const env = { ...process.env, ENGINE_KEY: "engine-secret" };
  const launch = await Effect.runPromise(agentScope(socket).wrap({ command: "sh", args: ["-c", 'echo "$TOOLS_SIDE $PWD $ENGINE_KEY"'], name: "claude", env }));
  // The caller starts the client with `env`: argv names the key, never its value.
  expect(launch.args.join(" ")).not.toContain("engine-secret");
  const out = execFileSync(launch.command, launch.args, { cwd: repo, encoding: "utf8", env });
  expect(out.trim()).toBe(`yes ${fs.realpathSync(repo)} engine-secret`);
});

toolsSide("starts git, claude and codex as the image's binaries, system directories first: a git left in the tools home never stands in", async () => {
  const repo = makeRepo(tempRoot("cloud-tools-pin-"), { "a.txt": "a\n" });
  const home = tempRoot("cloud-tools-home-");
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local/bin/git"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
  const planted = { ...process.env, PATH: `${path.join(home, ".local/bin")}:${process.env.PATH}` };
  // As the runtime's own git does, and the agent's shell: the planted one comes first on the tools PATH.
  expect(execFileSync("sh", ["-c", "git --version"], { env: planted, encoding: "utf8" }).trim()).toBe("planted");
  expect((await output(ChildProcess.make("git", ["rev-parse", "--show-toplevel"], { cwd: repo, env: planted }))).trim()).toBe(fs.realpathSync(repo));
  // What git itself starts (an alias, a hook) finds the system's git first too.
  expect((await output(ChildProcess.make("git", ["-c", "alias.v=!git --version", "v"], { cwd: repo, env: planted }))).trim()).toMatch(/^git version /);

  const tools = "/home/tools/.local/share/mise/shims:/home/tools/.local/bin:/usr/local/bin:/usr/bin:/bin";
  const system = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/tools/.local/share/mise/shims:/home/tools/.local/bin";
  expect(pinnedLaunch("claude", ["--version"], { PATH: tools }, {})).toEqual({ command: "/usr/bin/env", args: [`PATH=${system}`, `CLAUDE_ENV_FILE=${TOOLS_SHELL_ENV}`, "/usr/local/bin/claude", "--version"] });
  expect(pinnedLaunch("codex", ["app-server"], undefined, { PATH: tools })).toEqual({
    command: "/usr/bin/env",
    args: [`PATH=${system}`, "/usr/local/bin/codex", "-c", `shell_environment_policy.set.PATH="${tools}"`, "app-server"],
  });
  expect(pinnedLaunch(FAKE_CLAUDE, [], undefined, { PATH: tools })).toEqual({ command: FAKE_CLAUDE, args: [] });
  // A path the runtime resolved in its own container stays, with the system directories first all the same.
  expect(pinnedLaunch("/usr/local/bin/claude", [], { PATH: tools }, {}).args.slice(0, 3)).toEqual([`PATH=${system}`, `CLAUDE_ENV_FILE=${TOOLS_SHELL_ENV}`, "/usr/local/bin/claude"]);
  // Claude Agent's own commands get the tools PATH back: mise's toolchains first.
  const shell = execFileSync("sh", ["-c", `. "${TOOLS_SHELL_ENV}"; echo "$PATH"`], { env: { HOME: "/home/tools", PATH: system }, encoding: "utf8" }).trim();
  expect(shell).toBe(`/home/tools/.local/share/mise/shims:/home/tools/.local/bin:${system}`);
});

it("never hands the runtime token to the tools side", () => {
  const proxy = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://cloud/relay/v1/git/.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: Bearer ccrt_secret", KEEP: "1" };
  const delta = envDelta(proxy, {});
  expect(delta).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://cloud/relay/v1/git/.extraHeader", KEEP: "1" });
  expect(JSON.stringify(delta)).not.toContain("ccrt_");
  expect(envDelta({ CAVEMAN_RUNTIME_TOOLS_ADDRESS: "/s", CAVEMAN_CLOUD_LINK_DIR: "/l", PATH: process.env.PATH })).toEqual({});
});

toolsSide("pushes and fetches through the runtime's mirror; tools only sees bundles", async () => {
  // origin is github.com; the proxy env sends github.com to a local bare repo and adds a header only the mirror's git gets.
  const remotes = tempRoot("cloud-tools-remote-");
  const bare = path.join(remotes, "acme/widgets.git");
  execFileSync("git", ["init", "--bare", "-q", bare]);
  const repo = makeRepo(tempRoot("cloud-tools-checkout-"), { "a.txt": "a\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });
  const proxyEnv = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
    GIT_CONFIG_KEY_1: "http.extraHeader",
    GIT_CONFIG_VALUE_1: "Authorization: Bearer ccrt_secret",
  };
  const stateDir = tempRoot("cloud-tools-state-");
  const pushed = await pushViaMirror({ socket, stateDir, worktree: repo, source: "HEAD", target: "refs/heads/caveman/x", proxyEnv });
  expect(pushed.code, pushed.stderr).toBe(0);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  expect(execFileSync("git", ["rev-parse", "refs/heads/caveman/x"], { cwd: bare, encoding: "utf8" }).trim()).toBe(head);
  // The mirror is the runtime's, outside the checkout, and keeps no bundle.
  expect(fs.readdirSync(path.join(stateDir, "git-mirror")).filter((f) => f.endsWith(".bundle"))).toEqual([]);
  expect(fs.statSync(path.join(stateDir, "git-mirror")).mode & 0o077).toBe(0);

  // Another commit on the remote comes back into the checkout as a ref.
  const other = makeRepo(tempRoot("cloud-tools-other-"), { "b.txt": "b\n" });
  execFileSync("git", ["push", "-q", bare, "HEAD:refs/heads/caveman/y"], { cwd: other });
  const fetched = await fetchViaMirror({ socket, stateDir, worktree: repo, source: "refs/heads/caveman/y", target: "refs/heads/caveman/y", proxyEnv });
  expect(fetched.code, fetched.stderr).toBe(0);
  expect((await toolsGit(socket, repo, ["rev-parse", "refs/heads/caveman/y"])).stdout.trim()).toBe(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: other, encoding: "utf8" }).trim(),
  );

  // origin must be a github.com https URL: the proxy serves nothing else.
  execFileSync("git", ["remote", "set-url", "origin", "file:///etc"], { cwd: repo });
  await expect(pushViaMirror({ socket, stateDir, worktree: repo, source: "HEAD", target: "refs/heads/caveman/x", proxyEnv })).rejects.toThrow(/github\.com/);
});

// Audit K (shared staged ref): every push staged in one refs/caveman/push and every fetch in one refs/caveman/fetch, so
// two chats on one computer pushing or fetching at once could send or take each other's commits. Each call stages under
// its own name now, removed when it is done; a mirror from before, with the shared refs, keeps working.
toolsSide("concurrent pushes and fetches through one mirror each land their own commit and leave nothing staged", async () => {
  const remotes = tempRoot("cloud-tools-race-remote-");
  const bare = path.join(remotes, "acme/widgets.git");
  execFileSync("git", ["init", "--bare", "-q", bare]);
  const proxyEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/" };
  const stateDir = tempRoot("cloud-tools-race-state-");
  const head = (repo: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const checkouts = Array.from({ length: 8 }, (_, i) => {
    const repo = makeRepo(tempRoot("cloud-tools-race-"), { [`chat-${i}.txt`]: `${i}\n` });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });
    return repo;
  });
  // A mirror an older runtime left: its shared staged refs are still there.
  const mirrorDir = path.join(stateDir, "git-mirror");
  execFileSync("git", ["init", "--bare", "-q", mirrorDir]);
  execFileSync("git", ["fetch", "-q", checkouts[0]!, "HEAD:refs/caveman/push"], { cwd: mirrorDir });
  execFileSync("git", ["update-ref", "refs/caveman/fetch", "refs/caveman/push"], { cwd: mirrorDir });

  const pushed = await Promise.all(checkouts.map((repo, i) => pushViaMirror({ socket, stateDir, worktree: repo, source: "HEAD", target: `refs/heads/caveman/p${i}`, proxyEnv })));
  for (const result of pushed) expect(result.code, result.stderr).toBe(0);
  const landed = checkouts.map((_, i) => execFileSync("git", ["rev-parse", `refs/heads/caveman/p${i}`], { cwd: bare, encoding: "utf8" }).trim());
  expect(landed).toEqual(checkouts.map(head));

  // Eight commits on the remote, each fetched at once into its own checkout.
  const others = checkouts.map((_, i) => {
    const other = makeRepo(tempRoot("cloud-tools-race-other-"), { [`remote-${i}.txt`]: `${i}\n` });
    execFileSync("git", ["push", "-q", bare, `HEAD:refs/heads/caveman/f${i}`], { cwd: other });
    return head(other);
  });
  const fetched = await Promise.all(checkouts.map((repo, i) => fetchViaMirror({ socket, stateDir, worktree: repo, source: `refs/heads/caveman/f${i}`, target: `refs/heads/caveman/f${i}`, proxyEnv })));
  for (const result of fetched) expect(result.code, result.stderr).toBe(0);
  const took = checkouts.map((repo, i) => execFileSync("git", ["rev-parse", `refs/heads/caveman/f${i}`], { cwd: repo, encoding: "utf8" }).trim());
  expect(took).toEqual(others);

  expect(execFileSync("git", ["for-each-ref", "refs/caveman/"], { cwd: mirrorDir, encoding: "utf8" })).toBe("");
  expect(fs.readdirSync(mirrorDir).filter((file) => file.endsWith(".bundle"))).toEqual([]);
}, 120_000);

// A runtime killed in the middle of a push or fetch (out of memory, its pod stopped) leaves that call's staged ref and
// bundle in the mirror on the computer's volume, each pinning its objects. The next runtime clears them before its
// first call stages anything.
toolsSide("a push clears the staged refs and bundles a runtime killed mid-call left", async () => {
  const remotes = tempRoot("cloud-tools-left-remote-");
  const bare = path.join(remotes, "acme/widgets.git");
  execFileSync("git", ["init", "--bare", "-q", bare]);
  const proxyEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/" };
  const repo = makeRepo(tempRoot("cloud-tools-left-"), { "a.txt": "a\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });
  const stateDir = tempRoot("cloud-tools-left-state-");
  const mirrorDir = path.join(stateDir, "git-mirror");
  execFileSync("git", ["init", "--bare", "-q", mirrorDir]);
  for (const kind of ["push", "fetch"]) {
    for (const id of ["0b9d2f5e-1111-4c1e-9a52-9c4b1f0e7a10", "5f3e8c2a-2222-4d7b-8e61-0a9f6b3c2d41"]) {
      execFileSync("git", ["fetch", "-q", repo, `HEAD:refs/caveman/${kind}/${id}`], { cwd: mirrorDir });
      fs.writeFileSync(path.join(mirrorDir, `${kind}-${id}.bundle`), "a bundle a killed call left");
    }
  }
  const pushed = await pushViaMirror({ socket, stateDir, worktree: repo, source: "HEAD", target: "refs/heads/caveman/left", proxyEnv });
  expect(pushed.code, pushed.stderr).toBe(0);
  expect(execFileSync("git", ["for-each-ref", "refs/caveman/"], { cwd: mirrorDir, encoding: "utf8" })).toBe("");
  expect(fs.readdirSync(mirrorDir).filter((file) => file.endsWith(".bundle"))).toEqual([]);
});

toolsSide("runs [setup].run and [archive].run on the tools side, in the worktree, with the workspace env", async () => {
  const repo = makeRepo(tempRoot("cloud-tools-scripts-"), { "a.txt": "a\n" });
  const result = await asCloudComputer(() =>
    runScripts(['echo "$TOOLS_SIDE $PWD $CAVEMAN_PORT" > setup.txt', 'echo "$TOOLS_SIDE" > archive.txt', "false", "echo never > never.txt"], repo, { CAVEMAN_PORT: "42100" }),
  );
  expect(result).toMatchObject({ ok: false, failed: "false" });
  expect(fs.readFileSync(path.join(repo, "setup.txt"), "utf8").trim()).toBe(`yes ${fs.realpathSync(repo)} 42100`);
  expect(fs.readFileSync(path.join(repo, "archive.txt"), "utf8").trim()).toBe("yes");
  expect(fs.existsSync(path.join(repo, "never.txt"))).toBe(false);
});

toolsSide("makes every temporary git index on the tools side: commit context, review diff, checkpoint, park", async () => {
  const repo = makeRepo(tempRoot("cloud-tools-index-"), { "a.txt": "a\n" });
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
  // Every call the runtime's own file system gets while git works.
  const touched: Array<string> = [];
  const recording = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(Effect.service(FileSystem.FileSystem), (files) =>
      new Proxy(files, {
        get: (target, key) => {
          const value = Reflect.get(target, key);
          return typeof value === "function"
            ? (...args: Array<unknown>) => {
                touched.push(`${String(key)} ${String(args[0])}`);
                return value.apply(target, args);
              }
            : value;
        },
      }),
    ),
  );
  const services = Layer.provideMerge(spawnerLayer(socket), Layer.provideMerge(recording, Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  const program = Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const vcs = yield* VcsDriver.VcsDriver;
    touched.length = 0;
    // The runtime's TMPDIR is its own; here it does not even exist.
    return yield* Effect.promise(() =>
      withEnv("TMPDIR", path.join(root, "runtime-tmp-that-does-not-exist"), () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const selected = yield* driver.prepareCommitContext(repo, ["a.txt"]);
            const all = yield* driver.prepareCommitContext(repo);
            const preview = yield* driver.getReviewDiffPreview({ cwd: repo, baseRef: "main" });
            yield* vcs.checkpoints!.captureCheckpoint({ cwd: repo, checkpointRef: CheckpointRef.make("refs/t3/checkpoints/cloud") });
            const { commit: wip } = yield* snapshotWorkInProgress(driver, repo, "refs/caveman/sessions/cloud", "wip");
            return { selected, all, preview, wip };
          }),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(GitVcsDriver.layer, GitVcsDriver.layerVcs).pipe(
        Layer.provide(ServerConfig.layerTest(repo, { prefix: "cloud-tools-config-" })),
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(services),
      ),
    ),
  );
  const result = await asCloudComputer(() => Effect.runPromise(program));
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

  expect(result.selected?.stagedSummary).toBe("M\ta.txt");
  expect(result.all?.stagedSummary).toBe("M\ta.txt\nA\tb.txt");
  expect(result.preview.sources[0]?.diff).toContain("+++ b/b.txt");
  expect(git("show", "refs/t3/checkpoints/cloud:b.txt")).toBe("new\n");
  expect(git("show", `${result.wip}:a.txt`)).toBe("changed\n");
  expect(git("log", "-1", "--format=%an", result.wip)).toBe("Caveman Code\n");
  // The runtime made no temp file and copied, stamped or removed nothing: the checkout is the agent's.
  expect(touched.filter((call) => /^(copy|copyFile|utimes|remove|rename|writeFile|makeTemp|makeDirectory|truncate|chmod|symlink|link)/.test(call))).toEqual([]);
  // The tools side cleaned up after itself, in its temp dir and in .git; the user's index is untouched.
  expect(fs.readdirSync(toolsTmp)).toEqual([]);
  expect(fs.readdirSync(path.join(repo, ".git")).filter((name) => name.startsWith("t3-checkpoint-index"))).toEqual([]);
  expect(git("status", "--porcelain")).toBe(" M a.txt\n?? b.txt\n");
});

toolsSide("the Caveman engine's tools run on the tools side: commands, reads and writes", async () => {
  const backend = toolsExecutionBackend(socket);
  const dir = fs.mkdtempSync(path.join(root, "engine-"));
  const run = await backend.exec({ command: "sh", args: ["-c", 'echo "$TOOLS_SIDE $ADDED"; pwd; echo err >&2; exit 3'], cwd: dir, env: { ADDED: "on top" }, timeoutMs: 10_000, maxOutputBytes: 4096 });
  expect(run).toMatchObject({ code: 3, timedOut: false, truncated: false, stderr: "err\n" });
  expect(run.stdout).toBe(`yes on top\n${fs.realpathSync(dir)}\n`);

  // A secret in the env reaches the command but never any process's argv (ps shows argv to everyone): the
  // command lists every command line on this host. The runtime speaks the channel itself, so no exec client
  // process runs for the call (under gVisor its Node boot was most of a call's time).
  const canary = `canary-${process.pid}-${Date.now()}`;
  const listed = await backend.exec({ command: "sh", args: ["-c", 'echo "$CANARY_SECRET"; ps -A -ww -o args='], cwd: dir, env: { CANARY_SECRET: canary }, timeoutMs: 10_000, maxOutputBytes: 1 << 20 });
  const [echoed, ...commandLines] = listed.stdout.split("\n");
  expect(echoed).toBe(canary);
  expect(commandLines.filter((line) => line.includes("toolsExec.mjs exec"))).toEqual([]);
  expect(commandLines.filter((line) => line.includes(canary))).toEqual([]);

  // Output past the cap is cut and says so; a command past its time is killed.
  const big = await backend.exec({ command: "sh", args: ["-c", "head -c 10000 /dev/zero"], cwd: dir, env: {}, timeoutMs: 10_000, maxOutputBytes: 100 });
  expect(big).toMatchObject({ code: 0, truncated: true });
  expect(big.stdout.length).toBe(100);
  const slow = await backend.exec({ command: "sleep", args: ["30"], cwd: dir, env: {}, timeoutMs: 300, maxOutputBytes: 100 });
  expect(slow).toMatchObject({ code: null, timedOut: true });
  expect((await backend.exec({ command: "no-such-command-here", args: [], cwd: dir, env: {}, timeoutMs: 10_000, maxOutputBytes: 100 })).code).toBe(127);

  // Files: written and read on the tools side, parents made; a missing one is ENOENT.
  const file = path.join(dir, "deep", "a.txt");
  await backend.writeFile(file, new TextEncoder().encode("héllo"));
  expect(fs.readFileSync(file, "utf8")).toBe("héllo");
  expect(new TextDecoder().decode(await backend.readFile(file))).toBe("héllo");
  expect(new TextDecoder().decode(await backend.readFile(file, { maxBytes: 1 }))).toBe("h");
  await expect(backend.readFile(path.join(dir, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

toolsSide("a command's background children outlive it, as on This Mac; a timeout or an abort still ends its whole group", async () => {
  const backend = toolsExecutionBackend(socket);
  const dir = fs.mkdtempSync(path.join(root, "background-"));
  const exec = (script: string, more: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    backend.exec({ command: "sh", args: ["-c", script], cwd: dir, env: {}, timeoutMs: more.timeoutMs ?? 10_000, maxOutputBytes: 4096, ...(more.signal ? { signal: more.signal } : {}) });
  const alive = async (pid: string) => (await exec(`kill -0 ${pid}`)).code === 0;
  const pids: Array<string> = [];
  try {
    // `cmd &` holding the command's stdout: the call answers at once, and the child lives on, still writing.
    const started = Date.now();
    // Make the child write before the parent reports its PID: stdout is shared, not a PID channel.
    const held = await exec("(echo tick; : > child-ready; while :; do echo tick; sleep 0.05; done) & echo $! > held.pid; while [ ! -f child-ready ]; do sleep 0.01; done; cat held.pid");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(held).toMatchObject({ code: 0, timedOut: false });
    expect(held.stdout.startsWith("tick\n")).toBe(true);
    pids.push(fs.readFileSync(path.join(dir, "held.pid"), "utf8").trim());
    // Output redirected: the child is not killed with the command either.
    const quiet = await exec("sleep 300 >/dev/null 2>&1 & echo $!");
    pids.push(quiet.stdout.trim());
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const pid of pids) expect(await alive(pid)).toBe(true);

    // A command past its time takes its background children along; so does an abort.
    const slow = await exec(`sleep 300 & echo $! > ${dir}/slow; wait`, { timeoutMs: 500 });
    expect(slow).toMatchObject({ code: null, timedOut: true });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 500);
    await exec(`sleep 300 & echo $! > ${dir}/aborted; wait`, { signal: abort.signal });
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const file of ["slow", "aborted"]) expect(await alive(fs.readFileSync(path.join(dir, file), "utf8").trim())).toBe(false);
  } finally {
    // Even a failed output assertion must clean up the child this fixture started.
    const heldPid = path.join(dir, "held.pid");
    if (fs.existsSync(heldPid)) pids.push(fs.readFileSync(heldPid, "utf8").trim());
    for (const pid of new Set(pids)) if (/^\d+$/.test(pid)) await exec(`kill ${pid}`);
  }
});

toolsSide("the Caveman harness's env runs on the tools side: a long command yields a handle, files go there too", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, "harness-")));
  const env = await ToolsEnv.connect({ stream: toolsStream(socket), cwd: dir, env: { ADDED: "on top" } });
  try {
    // A command runs in tools, in the workspace, with what the thread adds; stderr arrives in order on the output.
    const quick = await env.exec('echo "$TOOLS_SIDE $ADDED"; pwd; echo err >&2; exit 3');
    expect(quick).toMatchObject({ exitCode: 3, running: false, output: `yes on top\n${dir}\nerr\n` });

    // Past its yield it keeps running under a handle; what it printed so far comes back, then the rest on wait.
    const started = await env.exec("echo first; sleep 1; echo second", { yieldMs: 300 });
    expect(started).toMatchObject({ running: true, output: "first\n" });
    const finished = await env.wait(started.handle!, 10_000);
    expect(finished).toMatchObject({ running: false, exitCode: 0, output: "second\n" });
    await expect(env.poll(started.handle!)).rejects.toThrow(/no background process/);

    // Live output reaches the watcher as text, a character split across two writes whole.
    const live: string[] = [];
    const split = await env.exec("printf '\\303'; sleep 0.3; printf '\\251\\n'", { onOutput: (chunk) => live.push(chunk) });
    expect(split.output).toBe("é\n");
    expect(live.join("")).toBe("é\n");

    // kill ends it (its whole group); a timeout does the same and says so.
    const sleeper = await env.exec("sleep 30", { background: true });
    expect(sleeper.running).toBe(true);
    expect(await env.kill(sleeper.handle!)).toMatchObject({ running: false, exitCode: null, killed: true });
    expect(await env.exec("sleep 30", { timeoutMs: 300 })).toMatchObject({ running: false, exitCode: null, timedOut: true });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    expect(await env.exec("sleep 30", { signal: abort.signal })).toMatchObject({ running: false, killed: true });

    // Files: written with their parents, read whole or by range, listed, stat'ed; missing ones are ENOENT.
    await env.writeFile("deep/a.txt", "héllo");
    expect(fs.readFileSync(path.join(dir, "deep", "a.txt"), "utf8")).toBe("héllo");
    expect(Buffer.from(await env.readFile("deep/a.txt")).toString("utf8")).toBe("héllo");
    expect(Buffer.from(await env.readFile("deep/a.txt", { offset: 1, length: 2 })).toString("utf8")).toBe("é");
    await expect(env.readFile("missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(env.readFile("deep")).rejects.toMatchObject({ code: "EISDIR" });
    const many = await env.readFiles(["deep/a.txt", "missing.txt"]);
    expect(Buffer.from(many[0] as Uint8Array).toString("utf8")).toBe("héllo");
    expect(many[1]).toMatchObject({ code: "ENOENT" });
    expect(await env.stat("deep/a.txt")).toMatchObject({ kind: "file", size: Buffer.byteLength("héllo") });
    expect(await env.stat("deep")).toMatchObject({ kind: "directory" });
    expect(await env.stat("missing.txt")).toBeUndefined();
    expect(await env.listDir(".")).toEqual([{ name: "deep", kind: "directory" }]);
    await expect(env.listDir("deep/a.txt")).rejects.toMatchObject({ code: "ENOTDIR" });
    const scratch = await env.scratchDir();
    expect((await env.exec(`test -d ${scratch} && echo there`)).output).toBe("there\n");
  } finally {
    await env.close();
  }
  expect(env.liveHandles()).toEqual([]);
});

// The tools container is Linux: close() finds what a run left behind through /proc.
it.skipIf(WIN || !fs.existsSync("/proc/self/environ"))("closing the harness's env ends what its commands left running", async () => {
  const dir = fs.mkdtempSync(path.join(root, "harness-close-"));
  const env = await ToolsEnv.connect({ stream: toolsStream(socket), cwd: dir });
  const left = await env.exec("sleep 300 >/dev/null 2>&1 & echo $!");
  const running = await env.exec("sleep 300", { background: true });
  expect(running.running).toBe(true);
  await env.close();
  const backend = toolsExecutionBackend(socket);
  const alive = await backend.exec({ command: "sh", args: ["-c", `kill -0 ${left.output.trim()} 2>/dev/null && echo alive || echo gone`], cwd: dir, env: {}, timeoutMs: 10_000, maxOutputBytes: 100 });
  expect(alive.stdout.trim()).toBe("gone");
});

// CAVEMAN_TEST_DESKTOP_TOOLS=<host:port>: a real tools container (a kind pod under gVisor through a port-forward).
const realTools = process.env.CAVEMAN_TEST_DESKTOP_TOOLS;
it.skipIf(!realTools)("on a real tools container a dev server started with & outlives its call and answers the next ones", { timeout: 300_000 }, async () => {
  const backend = toolsExecutionBackend(realTools!);
  const exec = (script: string) => backend.exec({ command: "sh", args: ["-c", script], cwd: "/tmp", env: {}, timeoutMs: 120_000, maxOutputBytes: 1 << 16 });
  const timed = async (script: string) => {
    const started = Date.now();
    const run = await exec(script);
    return { ...run, ms: Date.now() - started };
  };
  const sleeper = await timed("sleep 300 & echo $!");
  expect(sleeper).toMatchObject({ code: 0, timedOut: false });
  expect(sleeper.ms).toBeLessThan(5_000);
  // A real server, logging every request to the call's stdout, which nobody reads any more.
  const server = await timed("cd /tmp && npx --yes http-server@14 -p 8765 & echo started");
  expect(server).toMatchObject({ code: 0, timedOut: false });
  expect(server.ms).toBeLessThan(5_000);
  const deadline = Date.now() + 180_000;
  let page = await exec("curl -fsS http://127.0.0.1:8765/");
  while (page.code !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    page = await exec("curl -fsS http://127.0.0.1:8765/");
  }
  expect(page.code).toBe(0);
  for (let i = 0; i < 3; i++) expect((await exec("curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/")).stdout).toBe("200");
  expect((await exec(`kill -0 ${sleeper.stdout.trim()} && echo alive`)).stdout.trim()).toBe("alive");
  console.log(`background: sleep answered in ${sleeper.ms} ms, npx http-server in ${server.ms} ms; both alive on later calls`);
  await exec(`kill ${sleeper.stdout.trim()}; pkill -f http-server; true`);
});

toolsSide("probes Claude Agent where its sessions run: the version and the login, with this computer's vault key", async () => {
  // A claude on PATH-free ground (no script extension, so the SDK runs it as a binary): the stand-in, marking where it ran.
  const dir = fs.mkdtempSync(path.join(root, "claude-"));
  const mark = path.join(dir, "ran");
  const claude = path.join(dir, "claude");
  fs.writeFileSync(claude, `#!/bin/sh\necho "\${TOOLS_SIDE:-runtime} \${ANTHROPIC_API_KEY:+with-key} $1" >> '${mark}'\nexec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`, { mode: 0o755 });
  const settings = Schema.decodeSync(ClaudeSettings)({ binaryPath: claude });
  const tools = Layer.mergeAll(spawnerLayer(socket), Layer.succeed(AgentScope, agentScope(socket))).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  const probe = (keys?: EngineCloudKeysShape) =>
    Effect.runPromise(
      checkClaudeProviderStatus(settings, (s) => probeClaudeCapabilities(s, process.env, dir, false).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))), process.env, dir).pipe(
        Effect.provide(keys ? Layer.merge(tools, Layer.succeed(EngineCloudKeys, keys)) : tools),
      ),
    );

  const signedIn = await probe();
  expect(signedIn).toMatchObject({ installed: true, version: "2.1.111", status: "ready", auth: { status: "authenticated", email: "smoke@example.invalid" } });
  // `--version` (ChildProcessSpawner) and the SDK's init probe (AgentScope) both ran on the tools side.
  expect(fs.readFileSync(mark, "utf8").trim().split("\n").map((line) => line.split(" ")[0])).toEqual(["yes", "yes"]);

  // The person's Anthropic key from the vault reaches the probe's claude on the tools side, never argv.
  fs.rmSync(mark);
  await probe({ get: (engine) => Effect.succeed(engine === "claude-agent" ? "sk-ant-canary" : undefined), set: () => Effect.void });
  expect(fs.readFileSync(mark, "utf8").trim().split("\n").at(-1)).toMatch(/^yes with-key /);
}, 60_000);

toolsSide("keeps the tools container's own git config when a routed git brings its own (safe.directory survives)", async () => {
  // As on a computer: the container trusts the checkout through GIT_CONFIG_*, and the runtime's git adds safe.bareRepository.
  const own = path.join(root, "own.sock");
  const server = spawn(process.execPath, [TOOLS_EXEC, "serve", own], { env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }, stdio: "ignore" });
  try {
    for (let i = 0; i < 200 && !fs.existsSync(own); i++) await new Promise((r) => setTimeout(r, 50));
    const routed = toolsCommand(own, "sh", ["-c", 'echo "$GIT_CONFIG_COUNT $GIT_CONFIG_KEY_0=$GIT_CONFIG_VALUE_0 $GIT_CONFIG_KEY_1=$GIT_CONFIG_VALUE_1"'], root, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" }, {});
    const out = execFileSync(routed.command, routed.args, { env: { ...process.env, ...routed.env }, encoding: "utf8" });
    expect(out.trim()).toBe("2 safe.directory=* safe.bareRepository=explicit");
  } finally {
    server.kill();
  }
});

it("a servers address nothing answers on is no servers container (a pod from before it): servers stay in tools", async () => {
  const { liveServersSocket } = await import("./tools.ts");
  const dead = path.join(fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "servers-")), "none.sock");
  expect(await liveServersSocket({ CAVEMAN_RUNTIME_SERVERS_ADDRESS: dead })).toBeUndefined();
  expect(await liveServersSocket({})).toBeUndefined();
});

it("names a GitHub repository the git proxy can clone, and says what git said in one clause", () => {
  expect(githubCloneUrl("https://github.com/acme/widgets")).toBe("https://github.com/acme/widgets.git");
  expect(githubCloneUrl("https://github.com/acme/widgets.git/")).toBe("https://github.com/acme/widgets.git");
  expect(githubCloneUrl("git@github.com:acme/widgets.git")).toBeUndefined();
  expect(githubCloneUrl("https://gitlab.com/acme/widgets")).toBeUndefined();
  expect(gitSaid("remote: Repository not found.\nfatal: repository 'https://cloud.example/relay/v1/git/acme/widgets.git/' not found\n")).toBe("repository not found");
  expect(gitSaid("fatal: Authentication failed for 'https://cloud.example/relay/v1/git/acme/widgets.git/'\n")).toBe("Authentication failed");
  expect(gitSaid("remote: Write access to repository not granted. Ask an admin.\n")).toBe("Write access to repository not granted");
  expect(gitSaid("warning: something\n")).toBeUndefined();
  // Caveman's git proxy refuses with its reason as text; git prints it as remote: lines above its bare HTTP status.
  expect(
    gitSaid(
      "remote: This computer also runs another person's work, so Cloud's git proxy reaches no repository from it. Move the work to a computer of its own.\nfatal: unable to access 'https://cloud.example/relay/v1/git/acme/widgets.git/': The requested URL returned error: 403\n",
    ),
  ).toBe("This computer also runs another person's work, so Cloud's git proxy reaches no repository from it. Move the work to a computer of its own");
  expect(gitSaid("fatal: unable to access 'https://cloud.example/relay/v1/git/acme/widgets.git/': The requested URL returned error: 403\n")).toBe("unable to access: The requested URL returned error: 403");
});

it("the runtime's own git carries a fallback email: never on a person's commit, never over an identity the command sets", async () => {
  // EMAIL is below every identity anyone set and above git's guess from the machine's name (which asks its resolver).
  // One the machine's own environment names stays (a person's shell may export theirs); the rest of this test has none.
  const shells = process.env.EMAIL;
  onTestFinished(() => void (shells === undefined ? delete process.env.EMAIL : (process.env.EMAIL = shells)));
  process.env.EMAIL = "shell@person.example";
  expect(gitEnv()).toEqual({ EMAIL: "shell@person.example" });
  expect(gitEnv({ EMAIL: "own@example.com" })).toEqual({ EMAIL: "own@example.com" });
  delete process.env.EMAIL;
  expect(gitEnv()).toEqual({ EMAIL: RUNTIME_GIT_EMAIL });
  expect(gitEnv({ GIT_COMMITTER_NAME: "Own", GIT_COMMITTER_EMAIL: "own@example.com" })).toEqual({ GIT_COMMITTER_NAME: "Own", GIT_COMMITTER_EMAIL: "own@example.com", EMAIL: RUNTIME_GIT_EMAIL });
  expect(gitEnv({ EMAIL: "own@example.com" })).toEqual({ EMAIL: "own@example.com" });
  // The command, past git's own options: a ref or a path named like one is not it.
  expect(gitVerb([...SAFE_GIT_CONFIG, "checkout", "-f", "-B", "commit", "abc^", "--"])).toBe("checkout");
  expect(gitVerb(["-C", "/repo", "--git-dir", "/repo/.git", "-c", "user.name=commit", "commit", "-m", "x"])).toBe("commit");
  expect(gitVerb(["--no-pager"])).toBeUndefined();
  expect(isPlumbing(["fetch", "-q", "origin"])).toBe(true);
  expect(isPlumbing(["commit-tree", "abc", "-m", "x"])).toBe(true);
  expect(isPlumbing(["-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "--quiet", "-m", "x"])).toBe(false);

  // The session-protocol's helper and an automation run's git, as each hands a command to the driver.
  const seen: Array<{ readonly args: ReadonlyArray<string>; readonly env?: NodeJS.ProcessEnv }> = [];
  const driver = {
    execute: (input: { readonly args: ReadonlyArray<string>; readonly env?: NodeJS.ProcessEnv }) => {
      seen.push({ args: input.args, ...(input.env ? { env: input.env } : {}) });
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false });
    },
  } as unknown as GitVcsDriver.GitVcsDriver["Service"];
  const identity = { GIT_AUTHOR_NAME: "Caveman Code", GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com", GIT_COMMITTER_NAME: "Caveman Code", GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com" };
  // The adopt's git, in the order it runs it: the clone, the worktree, the checkout onto the chat's branch.
  const adopt: ReadonlyArray<ReadonlyArray<string>> = [
    ["init", "-q", "-b", "main"],
    ["remote", "add", "origin", "https://github.com/acme/widgets.git"],
    ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
    ["checkout", "-q", "-B", "main", "refs/remotes/origin/main"],
    [...SAFE_GIT_CONFIG, "worktree", "prune"],
    [...SAFE_GIT_CONFIG, "worktree", "add", "--detach", "--", "/worktrees/chat", "abc^"],
    [...SAFE_GIT_CONFIG, "checkout", "-f", "-B", "caveman/chat", "abc^", "--"],
    [...SAFE_GIT_CONFIG, "clean", "-fdq"],
    [...SAFE_GIT_CONFIG, "restore", "--source=abc", "--worktree", "--", "."],
  ];
  for (const args of adopt) await Effect.runPromise(runtimeGit(driver, "/repo", args));
  expect(seen.map((ran) => ran.env?.EMAIL)).toEqual(adopt.map(() => RUNTIME_GIT_EMAIL));
  seen.length = 0;
  // A commit of the runtime's own is by the identity it names, whole; the fallback sits under it, unused.
  await Effect.runPromise(runtimeGit(driver, "/repo", ["commit-tree", "abc", "-m", "x"], { env: identity }));
  expect(seen[0]!.env).toEqual({ ...identity, EMAIL: RUNTIME_GIT_EMAIL });
  // A person's commit gets nothing of the runtime's: their settings, or git's own guess, as before.
  await Effect.runPromise(runtimeGit(driver, "/repo", ["commit", "--allow-empty", "--no-verify", "-q", "-m", "Initial commit"]));
  expect(seen[1]!.env).toBeUndefined();
  seen.length = 0;
  const run = gitOf(driver);
  await Effect.runPromise(run("/repo", [...SAFE_GIT_CONFIG, "worktree", "add", "--detach", "--", "/worktrees/run", "abc"]));
  await Effect.runPromise(run("/repo", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "--quiet", "--no-verify", "-m", "x"]));
  expect(seen.map((ran) => ran.env)).toEqual([{ EMAIL: RUNTIME_GIT_EMAIL }, undefined]);
});

toolsSide("git under an identity someone set is by that identity, whatever the runtime's fallback says", async () => {
  // Real git, with no identity in any config and the fallback in its environment: a person's settings (config, or -c)
  // and a command's own GIT_* come first; only with neither does a reflog entry say the fallback.
  const repo = makeRepo(tempRoot("cloud-tools-identity-"), { "a.txt": "a\n" });
  const bare = { PATH: process.env.PATH, HOME: tempRoot("cloud-tools-nohome-"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", EMAIL: RUNTIME_GIT_EMAIL };
  const git = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) => execFileSync("git", ["-C", repo, ...args], { env: { ...bare, ...env }, encoding: "utf8" });
  const lastEntry = () => /^[0-9a-f]+ [0-9a-f]+ (.*) \d+ [+-]\d{4}\t/.exec(fs.readFileSync(path.join(repo, ".git", "logs", "HEAD"), "utf8").trim().split("\n").at(-1)!)?.[1];
  // The person's own settings in the repository: theirs, with the fallback present.
  git(["config", "user.name", "Ada Person"]);
  git(["config", "user.email", "ada@person.example"]);
  const own = "Ada Person <ada@person.example>";
  git(["checkout", "-q", "-B", "one"]);
  expect(lastEntry()).toBe(own);
  git(["commit", "-q", "--allow-empty", "-m", "theirs"]);
  expect(git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).trim()).toBe(`${own}|${own}`);
  // No identity in any config: the fallback email, and no guess from the machine's name.
  git(["config", "--unset", "user.email"]);
  git(["checkout", "-q", "-B", "two"]);
  expect(lastEntry()).toBe(`Ada Person <${RUNTIME_GIT_EMAIL}>`);
  // A command's own identity still wins over it.
  git(["checkout", "-q", "-B", "three"], { GIT_COMMITTER_NAME: "Own", GIT_COMMITTER_EMAIL: "own@example.com" });
  expect(lastEntry()).toBe("Own <own@example.com>");
  git(["-c", "user.name=Grace", "-c", "user.email=grace@example.com", "checkout", "-q", "-B", "four"]);
  expect(lastEntry()).toBe("Grace <grace@example.com>");
});
