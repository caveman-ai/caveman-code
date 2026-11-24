// A Cloud computer made from its project's environment (cloud-computers SPEC §6): setup is baked into the clone the
// build filled, and never runs again there. Its first chat works in that clone; every chat beside it and every
// builder works in a worktree of it, which is ready once what setup installed is copied in from the clone, and runs
// setup only when its branch changed a file setup watches since the build. At every boot the computer fetches its
// clone through Cloud's git proxy, installs there when a lockfile changed since the build, and runs the project's
// on_wake and start commands (bootSteps.ts). Proved through the Session Protocol client on a runtime started as a
// Cloud computer, on real git repositories, with a stand-in Cloud whose git proxy serves a real repository.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";
import { startTestCloud } from "./testCloud.ts";

// Skipped on Windows: a Cloud computer is Linux; with its git in a tools container over a Unix socket, or else only
// where owner uid and mode bits show the agent cannot write the checkout (gitTrusts).
const onComputer = test.skipIf(process.platform === "win32");

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Note {
  readonly title: string;
  readonly body: string;
}

/**
 * A runtime started as the Cloud computer whose clone is `checkout`, and what its chats are told. `github`: the
 * repositories Cloud's git proxy serves (bare, under owner/name.git); without it the proxy refuses every fetch.
 */
const computer = async (checkout: string, github?: string) => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  cloud.state.gitBackend = github;
  const linkDir = path.join(tempRoot("ready-env-link-"), "link");
  const identity = await enroll({
    dir: linkDir,
    cloudUrl: cloud.url,
    bearer: cloud.state.personToken,
    name: "computer",
  });
  const config = await makeConfig();
  // The link's state is the runtime's own: a second boot of the same computer starts with a new one.
  const start = () =>
    startRuntime(config, "fake-claude", undefined, {
      provide: Layer.mergeAll(
        Layer.succeed(CloudComputer, {
          linkDir,
          computerId: identity.computerId,
          workspaceRoot: checkout,
        }),
        Layer.succeed(CloudLinkState, {}),
      ) as unknown as Layer.Layer<any>,
    });
  let runtime = await start();
  let client = connect(runtime.url, runtime.token);
  const stop = async () => {
    client.close();
    await runtime.close();
  };
  cleanups.push(() => stop());
  /** The computer sleeps and wakes: its runtime stops and a new one starts on the same disk. */
  const reboot = async () => {
    await stop();
    runtime = await start();
    client = connect(runtime.url, runtime.token);
  };
  let n = 0;
  /**
   * A chat on the computer, with the setup notes it was told once setup settled, and where it works. `started`
   * false: answered as soon as the chat is made, without waiting for its start to end (a first message that waits
   * for the computer holds the start open).
   */
  const chat = async (extra: Record<string, unknown> = {}, started = true) => {
    n += 1;
    const params = {
      request_id: `w-${n}`,
      repo: { url: "https://github.com/acme/widgets" },
      title: `Chat ${n}`,
      engine: "claude-agent" as const,
      options: { model: MODEL },
      ...extra,
    };
    const workspace: Workspace = started
      ? await createReady(client, params)
      : await client.call("workspace.create", params);
    const notes: Array<Note> = [];
    /** When its first turn started, as this test saw it. */
    const turn = { startedAt: 0 };
    await client.attach(workspace.session_id, 0, (event: SessionEvent) => {
      if (event.type === "notification")
        notes.push({ title: event.payload.title, body: event.payload.body ?? "" });
      if (event.type === "turn.started" && turn.startedAt === 0) turn.startedAt = Date.now();
    });
    await until(
      () => notes.some((note) => /^Setup (skipped|finished|failed)/.test(note.title)),
      30_000,
    );
    // Its checkout: the clone itself, or the worktree git lists on its branch.
    const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: checkout,
      encoding: "utf8",
    }).split("\n\n");
    const at = listed
      .find((entry) => entry.includes(`branch refs/heads/${workspace.branch}`))
      ?.split("\n")[0]
      ?.slice("worktree ".length);
    return { workspace, notes, at: at!, turn };
  };
  return { cloud, chat, reboot, stop };
};

/** What a build leaves at a clone's root: the git-excluded marker, naming the commit and the setup it ran. */
const mark = (checkout: string, marker: Record<string, unknown> = {}) => {
  const git = (...args: Array<string>) =>
    execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  // As a clone of GitHub's repository has it (one this test cloned from a stand-in is pointed there).
  git(
    "remote",
    git("remote").includes("origin") ? "set-url" : "add",
    "origin",
    "https://github.com/acme/widgets.git",
  );
  fs.appendFileSync(path.join(checkout, ".git/info/exclude"), ".caveman/snapshot.json\n");
  fs.mkdirSync(path.join(checkout, ".caveman"), { recursive: true });
  fs.writeFileSync(
    path.join(checkout, ".caveman/snapshot.json"),
    JSON.stringify({
      hash: "h",
      commit: git("rev-parse", "HEAD"),
      branch: "main",
      built_at: new Date().toISOString(),
      ...marker,
    }),
  );
  return git;
};
const ranIn = (at: string) =>
  fs.existsSync(path.join(at, "setup-ran.txt"))
    ? fs.readFileSync(path.join(at, "setup-ran.txt"), "utf8").trim().split("\n").length
    : 0;

onComputer(
  "setup is baked in: a chat's worktree gets what setup installed from the clone and never runs it; a changed lockfile runs it once, there",
  async () => {
    const checkout = makeRepo(tempRoot("ready-env-"), {
      ".caveman/computer.toml":
        '[setup]\nrun = ["echo ran >> setup-ran.txt"]\ncache = ["node_modules"]\ninputs = ["package.json"]\n',
      "package.json": "{}\n",
      ".gitignore": "setup-ran.txt\nnode_modules\n",
    });
    const git = mark(checkout);
    // What the build's setup installed, in the clone.
    fs.mkdirSync(path.join(checkout, "node_modules/dep"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "node_modules/dep/index.js"), "module.exports = 1;\n");
    // A branch that changed a file setup watches since the build (the clone itself stays on the build's commit).
    const scratch = path.join(tempRoot("ready-env-scratch-"), "moved");
    git("worktree", "add", "-q", "-b", "moved", scratch);
    fs.writeFileSync(path.join(scratch, "package.json"), '{"dependencies":{"dep":"2"}}\n');
    execFileSync("git", ["commit", "-qam", "bump dep"], { cwd: scratch });
    git("worktree", "remove", scratch);
    const { chat } = await computer(checkout);

    // The computer's first chat works in the clone: nothing to run, nothing to copy.
    const first = await chat();
    expect(fs.realpathSync(first.at)).toBe(fs.realpathSync(checkout));
    expect(first.notes).toEqual([
      { title: "Setup skipped: this disk is ready (its snapshot matches)", body: "" },
    ]);

    // A chat beside it works in a worktree of the clone: what setup installed is copied in, and setup does not run.
    const second = await chat();
    expect(fs.realpathSync(second.at)).not.toBe(fs.realpathSync(checkout));
    expect(second.notes).toHaveLength(1);
    expect(second.notes[0]!.title).toBe("Setup skipped: this disk is ready (its snapshot matches)");
    expect(second.notes[0]!.body).toMatch(
      /^(Cloned|Hard-linked) from the first checkout: node_modules$/,
    );
    expect(fs.readFileSync(path.join(second.at, "node_modules/dep/index.js"), "utf8")).toBe(
      "module.exports = 1;\n",
    );
    // The build git-excludes its marker: the worktree was decided on the clone's.
    expect(fs.existsSync(path.join(second.at, ".caveman/snapshot.json"))).toBe(false);
    expect([ranIn(checkout), ranIn(second.at)]).toEqual([0, 0]);

    // A chat cut from the branch whose lockfile changed since the build: the caches come first, then setup runs once, there.
    const third = await chat({ base_ref: "moved" });
    expect(third.notes).toHaveLength(1);
    expect(third.notes[0]!.title).toMatch(/^Setup finished in /);
    expect(third.notes[0]!.body).toMatch(
      /^(Cloned|Hard-linked) from the first checkout: node_modules$/,
    );
    expect(fs.existsSync(path.join(third.at, "node_modules/dep/index.js"))).toBe(true);
    expect([ranIn(checkout), ranIn(second.at), ranIn(third.at)]).toEqual([0, 0, 1]);
  },
  180_000,
);

onComputer(
  "a setup that names no cache says nothing of what it installed, so a worktree still runs it; the setup is the build's when the repo has no file",
  async () => {
    // The organization's Cloud copy, as the drafter writes one: no computer.toml in the repo, no [setup].cache.
    const checkout = makeRepo(tempRoot("ready-env-"), {
      "package.json": "{}\n",
      ".gitignore": "setup-ran.txt\n",
    });
    mark(checkout, { config: '[setup]\nrun = ["echo ran >> setup-ran.txt"]\n' });
    const { chat } = await computer(checkout);

    const first = await chat();
    expect(first.notes.map((note) => note.title)).toEqual([
      "Setup skipped: this disk is ready (its snapshot matches)",
    ]);
    // The worktree reads the build's setup from the clone's marker, and runs it: nothing says what to copy instead.
    const second = await chat();
    expect(second.notes).toHaveLength(1);
    expect(second.notes[0]!.title).toMatch(/^Setup finished in /);
    expect([ranIn(checkout), ranIn(second.at)]).toEqual([0, 1]);
  },
  180_000,
);

onComputer(
  "every boot: the clone is fetched through the git proxy and moved forward, a changed lockfile installs there once, on_wake and start run, and a first message waits where the project says so",
  async () => {
    // GitHub behind Cloud's git proxy: acme/widgets, with the project's setup and what it does at every boot.
    const github = tempRoot("ready-env-github-");
    const bare = path.join(github, "acme/widgets.git");
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
    const author = makeRepo(tempRoot("ready-env-author-"), {
      ".caveman/computer.toml": [
        "[setup]",
        'run = ["echo ran >> setup-ran.txt"]',
        'cache = ["node_modules"]',
        'inputs = ["package.json"]',
        "",
        "[on_wake]",
        'run = ["sleep 6; echo woke >> woke.txt"]',
        "wait = true",
        "",
        "[start]",
        "run = ['echo $$ >> server.pid; exec sleep 300', 'echo no such service >&2; exit 3']",
        "",
      ].join("\n"),
      "package.json": "{}\n",
      ".gitignore": "*.txt\n*.pid\nnode_modules\n",
    });
    const inAuthor = (...args: Array<string>) =>
      execFileSync("git", args, { cwd: author, encoding: "utf8" }).trim();
    inAuthor("push", "-q", bare, "main");
    // The computer's clone as its environment's build left it: cloned on the default branch, the marker at its root.
    const checkout = path.join(tempRoot("ready-env-"), "workspace");
    execFileSync("git", ["clone", "-q", bare, checkout]);
    const git = mark(checkout);
    const built = git("rev-parse", "HEAD");
    fs.mkdirSync(path.join(checkout, "node_modules/dep"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "node_modules/dep/index.js"), "module.exports = 1;\n");
    // Since the build, someone pushed a lockfile change to GitHub.
    fs.writeFileSync(path.join(author, "package.json"), '{"dependencies":{"dep":"2"}}\n');
    inAuthor("commit", "-qam", "bump dep");
    inAuthor("push", "-q", bare, "main");
    const pushed = inAuthor("rev-parse", "HEAD");
    const pids = () =>
      fs.existsSync(path.join(checkout, "server.pid"))
        ? fs.readFileSync(path.join(checkout, "server.pid"), "utf8").trim().split("\n").map(Number)
        : [];
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const woke = path.join(checkout, "woke.txt");

    const { cloud, chat, reboot, stop } = await computer(checkout, github);
    const wakes = () =>
      fs.existsSync(woke) ? fs.readFileSync(woke, "utf8").trim().split("\n").length : 0;

    // The first boot, with no chat yet. The fetch goes through Cloud's git proxy with the runtime's token, and the
    // clone, free and clean on its default branch, moves to what GitHub has.
    await until(() => git("rev-parse", "HEAD") === pushed, 30_000);
    expect(
      cloud.state.gitRequests.some(
        (request) =>
          request.url.startsWith("/relay/v1/git/acme/widgets.git/info/refs") &&
          /^Bearer ccrt_/.test(request.authorization ?? ""),
      ),
    ).toBe(true);
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
    // Then, in the clone and in order: setup once for the changed lockfile, the project's on_wake command, and start
    // (after on_wake, as [on_wake].wait says), whose first command is left running.
    await until(() => wakes() === 1 && pids().length === 1, 45_000);
    expect(ranIn(checkout)).toBe(1);
    const stamp = (file: string) => fs.statSync(path.join(checkout, file)).mtimeMs;
    expect(stamp("setup-ran.txt")).toBeLessThanOrEqual(stamp("woke.txt"));
    expect(stamp("woke.txt")).toBeLessThanOrEqual(stamp("server.pid"));
    const [first] = pids();
    expect(alive(first!)).toBe(true);
    // The build's marker is as the build left it.
    expect(
      JSON.parse(fs.readFileSync(path.join(checkout, ".caveman/snapshot.json"), "utf8")).commit,
    ).toBe(built);

    // The computer sleeps and wakes. What start left running went with the runtime, and this boot starts it again;
    // on_wake's own command runs at every boot; the commit already installed is not installed again.
    await reboot();
    await until(() => !alive(first!), 15_000);
    // A chat started while the computer is still waking, with a first message: the project said it waits for on_wake.
    const early = await chat({ task: { text: "hello" } }, false);
    const wokeWhenMade = wakes();
    const startedWhenMade = early.turn.startedAt;
    await until(() => wakes() === 2 && pids().length === 2, 45_000);
    await until(() => early.turn.startedAt > 0, 60_000);
    // Its first turn started only once on_wake had finished, and nothing had to be said about waiting.
    expect([wokeWhenMade, startedWhenMade]).toEqual([1, 0]);
    expect(early.turn.startedAt).toBeGreaterThanOrEqual(Math.floor(stamp("woke.txt")));
    expect(early.notes.map((note) => note.title)).not.toContain(
      "Started before this computer was ready",
    );
    expect(alive(pids()[1]!)).toBe(true);

    // A chat started once the computer is awake waits for nothing.
    const late = await chat({ task: { text: "hello again" } });
    await until(() => late.turn.startedAt > 0, 60_000);
    expect(late.notes.map((note) => note.title)).not.toContain(
      "Started before this computer was ready",
    );
    await stop();
    await until(() => !alive(pids()[1]!), 15_000);
  },
  240_000,
);
