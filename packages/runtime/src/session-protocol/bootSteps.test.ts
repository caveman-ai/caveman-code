// A Cloud computer's boot steps (bootSteps.ts), each on real git repositories in a temp dir: a bare repository stands
// for GitHub, a clone of it for the clone a build left on the computer (with the build's git-excluded marker), and
// the fetch is git's own from that origin, where a computer's goes through Cloud's git proxy. Commands are real
// processes.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, test } from "vitest";

import { TOOLS_EXEC } from "../cloudLink/tools.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  defaultBranchOf,
  firstMessageGate,
  installedKey,
  makeBootSteps,
  type BootSteps,
  type BootStepsDeps,
  type BootWait,
} from "./bootSteps.ts";
import { parseComputerConfig, sharedEnv } from "./computerConfig.ts";
import { bootNote } from "./environments.ts";
import { git as runGit, startScript } from "./lifecycle.ts";
import { git, makeRepo, tempRoot, until } from "./testHarness.ts";

type Driver = GitVcsDriver.GitVcsDriver["Service"];

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "sp-boot-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

/** GitHub (a bare repository), someone who pushes to it, and the computer's clone as a build left it. */
const world = (files: Record<string, string>, options: { readonly marker?: boolean } = {}) => {
  const dir = tempRoot("sp-boot-");
  const author = makeRepo(dir, files);
  const origin = path.join(dir, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", author, origin]);
  git(author, "remote", "add", "origin", origin);
  const clone = path.join(dir, "clone");
  execFileSync("git", ["clone", "-q", origin, clone]);
  const head = (at = clone, ref = "HEAD") => git(at, "rev-parse", ref).trim();
  if (options.marker !== false) {
    fs.appendFileSync(path.join(clone, ".git/info/exclude"), ".caveman/snapshot.json\n");
    fs.mkdirSync(path.join(clone, ".caveman"), { recursive: true });
    fs.writeFileSync(
      path.join(clone, ".caveman/snapshot.json"),
      JSON.stringify({
        hash: "h",
        commit: head(),
        branch: "main",
        built_at: new Date().toISOString(),
      }),
    );
  }
  /** A commit pushed to GitHub's main after the build; answers its sha. */
  const push = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(author, file)), { recursive: true });
    fs.writeFileSync(path.join(author, file), text);
    git(author, "add", file);
    git(author, "commit", "-qm", `change ${file}`);
    git(author, "push", "-q", "origin", "main");
    return head(author);
  };
  const lines = (file: string) =>
    fs.existsSync(path.join(clone, file))
      ? fs.readFileSync(path.join(clone, file), "utf8").trim().split("\n")
      : [];
  return { dir, clone, push, head, lines };
};

/** The computer's small state, kept across boots. */
const disk = () => {
  const kv = new Map<string, string>();
  return {
    kv,
    kvGet: (key: string) => Effect.sync(() => kv.get(key)),
    kvSet: (key: string, value: string) => Effect.sync(() => void kv.set(key, value)),
  };
};

/** The fetch as a computer does it, but from the origin directly. */
const fetchFrom = (driver: Driver) => (root: string, branch: string) =>
  runGit(driver, root, [
    "fetch",
    "-q",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]).pipe(
    Effect.asVoid,
    Effect.mapError((error) => new Error(error.message)),
  );

/**
 * One boot of the runtime: its boot steps, begun by `body`, and ended (every started command with them) when `body`
 * is done. `over`: what this boot does differently (a chat that holds the clone, a fetch that fails).
 */
const boot = <A>(
  state: ReturnType<typeof disk>,
  body: (steps: BootSteps) => Effect.Effect<A>,
  over: (driver: Driver) => Partial<BootStepsDeps> = () => ({}),
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const steps = yield* makeBootSteps({
        driver,
        kvGet: state.kvGet,
        kvSet: state.kvSet,
        fetch: fetchFrom(driver),
        hold: () => Effect.succeed(true),
        release: () => Effect.void,
        upAfterMs: 300,
        ...over(driver),
      });
      return yield* body(steps);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
/** A boot that runs the steps for one clone to their end and answers what they noted. */
const wake = (
  state: ReturnType<typeof disk>,
  clone: string,
  over?: (driver: Driver) => Partial<BootStepsDeps>,
) =>
  boot(
    state,
    (steps) =>
      steps.begin(clone).pipe(
        Effect.andThen(steps.settled(clone)),
        Effect.map(() => steps.notes()),
      ),
    over,
  );

const SETUP = `[setup]\nrun = ['echo "$NODE_ENV $CAVEMAN_PORT" >> setup-ran.txt']\ninputs = ["package.json"]\n\n[run]\nports = ["web", "api"]\n\n[env]\nNODE_ENV = "development"\n`;
const FILES = {
  ".caveman/computer.toml": SETUP,
  "package.json": "{}\n",
  "README.md": "hi\n",
  ".gitignore": "*.txt\n*.pid\n",
};

describe("on_wake: the fetch, and the install when a lockfile changed since the build", () => {
  test("a free, clean clone is fast-forwarded to what was fetched; setup runs there only when a file it watches changed, once per commit", async () => {
    const { clone, push, head, lines } = world(FILES);
    const state = disk();
    const built = head();

    // Nothing new on GitHub: nothing moves, nothing runs.
    expect(await wake(state, clone)).toEqual([]);
    expect([head(), lines("setup-ran.txt")]).toEqual([built, []]);

    // A commit that changes nothing setup watches: the clone moves forward, setup does not run.
    const readme = push("README.md", "hello\n");
    expect(await wake(state, clone)).toEqual([]);
    expect(head()).toBe(readme);
    expect(lines("setup-ran.txt")).toEqual([]);
    expect(state.kv.size).toBe(0);

    // A lockfile changed since the build: the clone moves forward and setup runs in it, once, with what a build's
    // setup gets ([env] as written, the first [run] port numbered from 3000).
    const bumped = push("package.json", '{"dependencies":{"dep":"2"}}\n');
    expect(await wake(state, clone)).toEqual([]);
    expect(head()).toBe(bumped);
    expect(lines("setup-ran.txt")).toEqual(["development 3000"]);
    expect(JSON.parse(state.kv.get(installedKey(clone))!).commit).toBe(bumped);

    // The next boot, the same commit: not again. Nor after a commit that changes nothing setup watches.
    expect(await wake(state, clone)).toEqual([]);
    push("README.md", "hello again\n");
    expect(await wake(state, clone)).toEqual([]);
    expect(lines("setup-ran.txt")).toEqual(["development 3000"]);

    // Another lockfile change: once more, at that commit.
    const again = push("package.json", '{"dependencies":{"dep":"3"}}\n');
    expect(await wake(state, clone)).toEqual([]);
    expect(lines("setup-ran.txt")).toEqual(["development 3000", "development 3000"]);
    expect(JSON.parse(state.kv.get(installedKey(clone))!).commit).toBe(again);
    // The build's marker is the build's: never rewritten here.
    expect(
      JSON.parse(fs.readFileSync(path.join(clone, ".caveman/snapshot.json"), "utf8")).commit,
    ).toBe(built);
  });

  test("a clone a chat holds, or one with a tracked change, stays where it is: no fast-forward and no install, and nothing is said", async () => {
    const held = world(FILES);
    const bumped = held.push("package.json", '{"dependencies":{"dep":"2"}}\n');
    const built = held.head();
    let asked = 0;
    let released = 0;
    // The computer's first chat works in the clone itself.
    expect(
      await wake(disk(), held.clone, () => ({
        hold: () => Effect.sync(() => (asked++, false)),
        release: () => Effect.sync(() => void released++),
      })),
    ).toEqual([]);
    expect([asked, released]).toEqual([1, 0]);
    expect(held.head()).toBe(built);
    expect(held.lines("setup-ran.txt")).toEqual([]);
    // The fetch still happened: a chat cut from origin's branch has the new commit.
    expect(held.head(held.clone, "refs/remotes/origin/main")).toBe(bumped);

    // A tracked file someone edited in the clone: left alone, and the clone given back.
    const dirty = world(FILES);
    dirty.push("package.json", '{"dependencies":{"dep":"2"}}\n');
    fs.writeFileSync(path.join(dirty.clone, "README.md"), "edited here\n");
    const before = dirty.head();
    released = 0;
    expect(
      await wake(disk(), dirty.clone, () => ({
        release: () => Effect.sync(() => void released++),
      })),
    ).toEqual([]);
    expect(released).toBe(1);
    expect(dirty.head()).toBe(before);
    expect(fs.readFileSync(path.join(dirty.clone, "README.md"), "utf8")).toBe("edited here\n");
    expect(dirty.lines("setup-ran.txt")).toEqual([]);

    // A clone that is free again is given back once the install is over, whatever it did.
    const free = world(FILES);
    free.push("package.json", '{"dependencies":{"dep":"2"}}\n');
    const taken: Array<string> = [];
    expect(
      await wake(disk(), free.clone, () => ({
        hold: () => Effect.sync(() => (taken.push("hold"), true)),
        release: () =>
          Effect.sync(
            () => void taken.push(`release after ${free.lines("setup-ran.txt").length} install`),
          ),
      })),
    ).toEqual([]);
    expect(taken).toEqual(["hold", "release after 1 install"]);
  });

  test("a clone on a chat's branch is not moved, but its default branch is, as a ref, unless a worktree has it checked out or it left GitHub's", async () => {
    // The first chat's branch is checked out in the clone; main is checked out nowhere.
    const a = world(FILES);
    git(a.clone, "checkout", "-q", "-b", "caveman/first");
    const first = a.head();
    const pushed = a.push("package.json", '{"dependencies":{"dep":"2"}}\n');
    let asked = 0;
    expect(
      await wake(disk(), a.clone, () => ({ hold: () => Effect.sync(() => (asked++, true)) })),
    ).toEqual([]);
    // The next chat is cut from main: it starts from what GitHub has. The clone's own checkout and files are as they were.
    expect(a.head(a.clone, "refs/heads/main")).toBe(pushed);
    expect([a.head(), git(a.clone, "symbolic-ref", "--short", "HEAD").trim()]).toEqual([
      first,
      "caveman/first",
    ]);
    expect([asked, a.lines("setup-ran.txt")]).toEqual([0, []]);

    // main is checked out in a chat's worktree: that chat's to move.
    const b = world(FILES);
    git(b.clone, "checkout", "-q", "-b", "caveman/first");
    git(b.clone, "worktree", "add", "-q", path.join(b.dir, "on-main"), "main");
    const before = b.head(b.clone, "refs/heads/main");
    b.push("README.md", "hello\n");
    expect(await wake(disk(), b.clone)).toEqual([]);
    expect(b.head(b.clone, "refs/heads/main")).toBe(before);

    // main here has a commit GitHub's does not: never rewound, never merged.
    const c = world(FILES);
    fs.writeFileSync(path.join(c.clone, "local.md"), "made here\n");
    git(c.clone, "add", "local.md");
    git(c.clone, "commit", "-qm", "made here");
    const local = c.head();
    c.push("README.md", "hello\n");
    expect(await wake(disk(), c.clone)).toEqual([]);
    expect(c.head()).toBe(local);
    git(c.clone, "checkout", "-q", "-b", "caveman/first");
    expect(await wake(disk(), c.clone)).toEqual([]);
    expect(c.head(c.clone, "refs/heads/main")).toBe(local);
  });

  test("a clone no build filled is fetched and moved forward, and setup is not run there: nothing was baked in to keep current", async () => {
    const plain = world(FILES, { marker: false });
    const bumped = plain.push("package.json", '{"dependencies":{"dep":"2"}}\n');
    expect(await wake(disk(), plain.clone)).toEqual([]);
    expect(plain.head()).toBe(bumped);
    expect(plain.lines("setup-ran.txt")).toEqual([]);
    // A marker the repository commits is no build's either, though it names a commit the clone has and a lockfile changed since.
    const committed = world(FILES, { marker: false });
    committed.push(".caveman/snapshot.json", JSON.stringify({ commit: committed.head() }));
    const moved = committed.push("package.json", '{"dependencies":{"dep":"2"}}\n');
    expect(await wake(disk(), committed.clone)).toEqual([]);
    expect(committed.head()).toBe(moved);
    expect(fs.existsSync(path.join(committed.clone, ".caveman/snapshot.json"))).toBe(true);
    expect(committed.lines("setup-ran.txt")).toEqual([]);
  });

  test("a fetch that fails, or never answers, is said and stops nothing: the project's on_wake and start commands still run", async () => {
    const files = {
      ...FILES,
      ".caveman/computer.toml": `${SETUP}\n[on_wake]\nrun = ["echo woke >> woke.txt"]\n\n[start]\nrun = ["echo started >> started.txt"]\n`,
    };
    const offline = world(files);
    const pushed = offline.push("package.json", '{"dependencies":{"dep":"2"}}\n');
    const built = offline.head();
    expect(
      await wake(disk(), offline.clone, () => ({
        fetch: () => Effect.fail(new Error("Could not resolve host: cloud.example.")),
      })),
    ).toEqual([
      "Could not fetch main from GitHub, so this computer has it as of its last fetch: Could not resolve host: cloud.example.",
    ]);
    // Nothing was fetched, so nothing moved and nothing was installed; what the project asked for at every boot ran.
    expect(offline.head()).toBe(built);
    expect(offline.head(offline.clone, "refs/remotes/origin/main")).not.toBe(pushed);
    expect([
      offline.lines("setup-ran.txt"),
      offline.lines("woke.txt"),
      offline.lines("started.txt"),
    ]).toEqual([[], ["woke"], ["started"]]);

    const silent = world(files);
    expect(
      await wake(disk(), silent.clone, () => ({ fetch: () => Effect.never, fetchTimeoutMs: 200 })),
    ).toEqual([
      "Could not fetch main from GitHub, so this computer has it as of its last fetch: it did not answer in time.",
    ]);
    expect([silent.lines("woke.txt"), silent.lines("started.txt")]).toEqual([
      ["woke"],
      ["started"],
    ]);
  });

  test("the project's [on_wake].run runs after the fetch and the install, in the clone; a command that fails is said, and a setup that fails is said and tried at the next boot", async () => {
    const files = {
      ...FILES,
      ".caveman/computer.toml": `[setup]\nrun = ["echo installed >> order.txt", "test -f allow-setup.txt"]\ninputs = ["package.json"]\n\n[on_wake]\nrun = ["echo woke at $(git rev-parse --short HEAD) >> order.txt", "echo no migrations >&2; exit 7", "echo never >> order.txt"]\n`,
    };
    const w = world(files);
    const bumped = w.push("package.json", '{"dependencies":{"dep":"2"}}\n');
    const state = disk();
    const noted = await wake(state, w.clone);
    expect(noted).toEqual([
      "Setup ([setup].run) failed in this computer's clone after a lockfile changed: `test -f allow-setup.txt`.",
      "`echo no migrations >&2; exit 7` ([on_wake]) failed. It said: no migrations",
    ]);
    // In order: the install at the commit that was fetched, then the project's commands, stopping at the one that failed.
    expect(w.lines("order.txt")).toEqual(["installed", `woke at ${bumped.slice(0, 7)}`]);
    // A setup that failed is not recorded as done: the next boot runs it again, and records the one that passes.
    expect(state.kv.size).toBe(0);
    fs.writeFileSync(path.join(w.clone, "allow-setup.txt"), "");
    expect(await wake(state, w.clone)).toEqual([
      "`echo no migrations >&2; exit 7` ([on_wake]) failed. It said: no migrations",
    ]);
    expect(w.lines("order.txt")).toEqual([
      "installed",
      `woke at ${bumped.slice(0, 7)}`,
      "installed",
      `woke at ${bumped.slice(0, 7)}`,
    ]);
    expect(JSON.parse(state.kv.get(installedKey(w.clone))!).commit).toBe(bumped);
  });

  test("a computer.toml with an error is said once, and nothing of the project's runs", async () => {
    const w = world({
      ...FILES,
      ".caveman/computer.toml": `[start]\nrnu = ["echo started >> started.txt"]\n`,
    });
    expect(await wake(disk(), w.clone)).toEqual([
      'computer.toml has an error, so its on_wake and start commands did not run: .caveman/computer.toml:2: unknown key "start.rnu".',
    ]);
    expect(w.lines("started.txt")).toEqual([]);
  });

  test("the default branch is the one origin/HEAD names, else the one the build's marker names", async () => {
    const w = world(FILES);
    const asked = (root: string) =>
      Effect.runPromise(
        Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) => defaultBranchOf(driver, root)).pipe(
          Effect.provide(layer),
        ),
      );
    expect(await asked(w.clone)).toBe("main");
    git(w.clone, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
    expect(await asked(w.clone)).toBe("main");
    fs.writeFileSync(
      path.join(w.clone, ".caveman/snapshot.json"),
      JSON.stringify({ commit: w.head(), branch: "HEAD" }),
    );
    expect(await asked(w.clone)).toBeUndefined();
    // Nothing names one: said, and the project's commands still run.
    expect(await wake(disk(), w.clone)).toEqual([
      "This clone names no default branch (origin/HEAD), so nothing was fetched.",
    ]);
  });
});

describe("start: services and dev servers, every boot", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("each command starts once per boot and is left running; one that exits with an error is said; all end with the runtime", async () => {
    const w = world({
      ...FILES,
      ".caveman/computer.toml": `[run]\nports = ["web"]\n\n[env]\nNODE_ENV = "development"\n\n[start]\nrun = ['echo "$NODE_ENV $PORT" >> starts.txt; echo $$ > server.pid; exec sleep 60', "echo no such service >&2; exit 3", "echo up >> third.txt"]\n`,
    });
    let pid = 0;
    const noted = await boot(disk(), (steps) =>
      Effect.gen(function* () {
        // Begun twice (the runtime's start, and anything that names the clone again): started once.
        yield* steps.begin(w.clone);
        yield* steps.begin(`${w.clone}${path.sep}`);
        yield* steps.settled(w.clone);
        yield* steps.begin(w.clone);
        yield* steps.settled(w.clone);
        pid = Number(fs.readFileSync(path.join(w.clone, "server.pid"), "utf8"));
        // The first is still running, with the clone's environment; the one after the failure started too.
        expect(alive(pid)).toBe(true);
        expect(w.lines("starts.txt")).toEqual(["development 3000"]);
        expect(w.lines("third.txt")).toEqual(["up"]);
        return steps.notes();
      }),
    );
    expect(noted).toHaveLength(1);
    expect(noted[0]).toMatch(
      /^`echo no such service >&2; exit 3` \(\[start\]\) exited with code 3 after \d+\.\d s\. It said: no such service$/,
    );
    // The runtime stopped: what it started is gone, and that is no failure to report.
    await until(() => !alive(pid), 10_000);
  });

  test("a command that dies later is said then, for the next chat", async () => {
    const w = world({
      ...FILES,
      ".caveman/computer.toml": `[start]\nrun = ["sleep 1; echo crashed >&2; exit 9"]\n`,
    });
    await boot(disk(), (steps) =>
      Effect.gen(function* () {
        yield* steps.begin(w.clone);
        yield* steps.settled(w.clone);
        // Up for a moment: counted as started, and nothing to say yet.
        expect(steps.notes()).toEqual([]);
        yield* Effect.promise(() => until(() => steps.notes().length > 0, 10_000));
        expect(steps.notes([w.clone])[0]).toMatch(
          /^`sleep 1; echo crashed >&2; exit 9` \(\[start\]\) exited with code 9 after 1\.\d s\. It said: crashed$/,
        );
        // Asked for another clone's: none of this one's.
        expect(steps.notes([w.dir])).toEqual([]);
      }),
    );
  });

  test("start begins once the fetch is done, beside on_wake's own commands; with [on_wake].wait it begins after them", async () => {
    const config = (wait: boolean) =>
      `[on_wake]\nrun = ["sleep 1; echo woke >> order.txt"]\nwait = ${wait}\n\n[start]\nrun = ["echo started >> order.txt"]\n`;
    const order = async (wait: boolean) => {
      const w = world({ ...FILES, ".caveman/computer.toml": config(wait) });
      await wake(disk(), w.clone, (driver) => ({
        fetch: (root, branch) =>
          Effect.sync(() => fs.appendFileSync(path.join(root, "order.txt"), "fetched\n")).pipe(
            Effect.andThen(fetchFrom(driver)(root, branch)),
          ),
      }));
      return w.lines("order.txt");
    };
    expect(await order(false)).toEqual(["fetched", "started", "woke"]);
    expect(await order(true)).toEqual(["fetched", "woke", "started"]);
  });
});

// A Cloud computer's tools channel is a Unix socket: none on Windows.
test.skipIf(process.platform === "win32")(
  "a started command runs in the tools container on a Cloud computer, says how it ended, and ends when it is stopped",
  async () => {
    const dir = tempRoot("sp-boot-tools-");
    const socket = path.join(dir, "tools.sock");
    // The tools container's exec channel, as the computers service starts it; TOOLS_SIDE marks what ran there.
    const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], {
      env: { ...process.env, TOOLS_SIDE: "tools" },
      stdio: "ignore",
    });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await until(() => fs.existsSync(socket));
      process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;
      // It runs there, in the folder and with the variables it was given, and what it wrote comes back with its code.
      const failed = await startScript(
        'echo "$TOOLS_SIDE $GREETING in $(basename "$PWD")"; echo broken >&2; exit 4',
        dir,
        { GREETING: "hello" },
      ).done;
      expect(failed.code).toBe(4);
      expect(failed.output).toContain(`tools hello in ${path.basename(dir)}`);
      expect(failed.output).toContain("broken");
      // One left running is ended whole by stop: the shell and what it started.
      const server = startScript(
        "echo $$ > server.pid; sleep 300 & echo $! > child.pid; wait",
        dir,
        {},
      );
      await until(
        () =>
          fs.existsSync(path.join(dir, "child.pid")) &&
          fs.readFileSync(path.join(dir, "child.pid"), "utf8").trim() !== "",
      );
      const pids = ["server.pid", "child.pid"].map((file) =>
        Number(fs.readFileSync(path.join(dir, file), "utf8")),
      );
      expect(pids.map(alive)).toEqual([true, true]);
      server.stop();
      expect((await server.done).code).not.toBe(0);
      await until(() => !pids.some(alive), 10_000);
    } finally {
      delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
      tools.kill();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a started command on a computer without a tools container is its own process group: stop ends the shell and what it started",
  async () => {
    const dir = tempRoot("sp-boot-local-");
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const ended = await startScript('echo "$GREETING in $(basename "$PWD")"; exit 5', dir, {
      GREETING: "hello",
    }).done;
    expect(ended).toEqual({ code: 5, output: `hello in ${path.basename(dir)}\n` });
    const server = startScript(
      "echo $$ > server.pid; sleep 300 & echo $! > child.pid; wait",
      dir,
      {},
    );
    await until(
      () =>
        fs.existsSync(path.join(dir, "child.pid")) &&
        fs.readFileSync(path.join(dir, "child.pid"), "utf8").trim() !== "",
    );
    const pids = ["server.pid", "child.pid"].map((file) =>
      Number(fs.readFileSync(path.join(dir, file), "utf8")),
    );
    expect(pids.map(alive)).toEqual([true, true]);
    server.stop();
    // Ended by a signal: 128 and its number.
    expect((await server.done).code).toBe(128 + 15);
    await until(() => !pids.some(alive), 10_000);
  },
);

describe("a chat's first message waits for on_wake or start only where the project says so", () => {
  const waitOf = (what: string) => {
    const done = Deferred.makeUnsafe<void>();
    let isDone = false;
    const wait: BootWait = { what, done: Deferred.await(done), isDone: () => isDone };
    return {
      wait,
      finish: Effect.sync(() => void (isDone = true)).pipe(
        Effect.andThen(Deferred.succeed(done, undefined)),
      ),
    };
  };

  test("nothing to wait for: it answers at once; something: until it is done; past the bound: it answers anyway and names what was late", async () => {
    expect(await Effect.runPromise(firstMessageGate([]))).toEqual({ waited: false, late: [] });
    // Done already (the computer woke long before the chat): at once too.
    const past = waitOf("on_wake");
    await Effect.runPromise(past.finish);
    expect(await Effect.runPromise(firstMessageGate([past.wait]))).toEqual({
      waited: false,
      late: [],
    });

    // Still running: the message waits for it, and for every one of them.
    const [onWake, start] = [waitOf("on_wake"), waitOf("start")];
    const began = Date.now();
    const gate = Effect.runPromise(firstMessageGate([onWake.wait, start.wait], 60_000));
    setTimeout(() => void Effect.runPromise(onWake.finish), 150);
    setTimeout(() => void Effect.runPromise(start.finish), 400);
    expect(await gate).toEqual({ waited: true, late: [] });
    expect(Date.now() - began).toBeGreaterThanOrEqual(390);

    // The bound: what is not done by then is named, and the message starts.
    const [slow, quick] = [waitOf("web: start"), waitOf("on_wake")];
    setTimeout(() => void Effect.runPromise(quick.finish), 50);
    const bounded = Date.now();
    expect(await Effect.runPromise(firstMessageGate([slow.wait, quick.wait], 300))).toEqual({
      waited: true,
      late: ["web: start"],
    });
    expect(Date.now() - bounded).toBeLessThan(5_000);
  });

  test("the boot steps offer a wait only for what says wait = true: on_wake until it finished, start until each command exited or was up", async () => {
    const files = (onWake: boolean, start: boolean) => ({
      ...FILES,
      ".caveman/computer.toml": `[on_wake]\nrun = ["sleep 1; echo woke >> woke.txt"]\nwait = ${onWake}\n\n[start]\nrun = ["echo $$ > server.pid; exec sleep 60"]\nwait = ${start}\n`,
    });
    // The default: nothing to wait for, though both are still running. The first message starts as it always did.
    const quiet = world(files(false, false));
    await boot(disk(), (steps) =>
      Effect.gen(function* () {
        yield* steps.begin(quiet.clone);
        expect(steps.waits([quiet.clone])).toEqual([]);
        expect(yield* firstMessageGate(steps.waits([quiet.clone]))).toEqual({
          waited: false,
          late: [],
        });
        expect(quiet.lines("woke.txt")).toEqual([]);
      }),
    );

    // [on_wake].wait: the message waits until on_wake's commands are over.
    const waking = world(files(true, false));
    await boot(disk(), (steps) =>
      Effect.gen(function* () {
        yield* steps.begin(waking.clone);
        expect(steps.waits([waking.clone]).map((wait) => wait.what)).toEqual(["on_wake"]);
        expect(yield* firstMessageGate(steps.waits([waking.clone]))).toEqual({
          waited: true,
          late: [],
        });
        expect(waking.lines("woke.txt")).toEqual(["woke"]);
        // A chat that starts later finds it done.
        expect(yield* firstMessageGate(steps.waits([waking.clone]))).toEqual({
          waited: false,
          late: [],
        });
        // A chat in a clone the steps never began (This Mac, or a clone made since): nothing to wait for.
        expect(steps.waits([waking.dir])).toEqual([]);
      }),
    );

    // [start].wait: until the command has been up for a moment; it is still running then.
    const serving = world(files(false, true));
    await boot(disk(), (steps) =>
      Effect.gen(function* () {
        yield* steps.begin(serving.clone, "acme/web");
        expect(steps.waits([serving.clone]).map((wait) => wait.what)).toEqual(["acme/web: start"]);
        expect(yield* firstMessageGate(steps.waits([serving.clone]))).toEqual({
          waited: true,
          late: [],
        });
        expect(fs.existsSync(path.join(serving.clone, "server.pid"))).toBe(true);
        expect(serving.lines("woke.txt")).toEqual([]);
      }),
    );

    // The bound, on the real steps: on_wake is still running, so the message starts and says what it did not wait out.
    const slow = world(files(true, true));
    await boot(disk(), (steps) =>
      Effect.gen(function* () {
        yield* steps.begin(slow.clone);
        expect(yield* firstMessageGate(steps.waits([slow.clone]), 200)).toEqual({
          waited: true,
          late: ["on_wake", "start"],
        });
      }),
    );
  });
});

test("what a clone's own commands run with: [env] as written and the build's port numbers, nothing of a workspace's", () => {
  const config = parseComputerConfig(
    `[run]\nports = ["web", "api"]\n\n[env]\nNODE_ENV = "development"\nDATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres"\n\n[services]\npostgres = "16"\n`,
  );
  expect(sharedEnv(config)).toEqual({
    NODE_ENV: "development",
    // A service URL stays at the address every workspace shares: no workspace's database is the clone's.
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
    CAVEMAN_PORT_WEB: "3000",
    CAVEMAN_PORT_API: "3001",
    CAVEMAN_PORT: "3000",
    PORT: "3000",
  });
  expect(sharedEnv(null)).toEqual({});
  expect(sharedEnv(parseComputerConfig(`[env]\nA = "1"\n`))).toEqual({ A: "1" });
});

test("a chat's boot note carries what the computer's last wake could not do, after what it booted from", () => {
  const booted = {
    marker: { commit: "0123456789abcdef", built_at: "2026-11-10T00:00:00Z" },
    services: [],
    now: Date.parse("2026-11-10T02:00:00Z"),
  } as const;
  expect(bootNote({ ...booted, setup: "skipped" })).toBe(
    "[Caveman Code] This Cloud computer booted from the repo's snapshot built 2 h ago at 0123456. Setup skipped: nothing it installs changed since.",
  );
  expect(bootNote({ ...booted, setup: "skipped", steps: [] })).toBe(
    bootNote({ ...booted, setup: "skipped" }),
  );
  // A chat in a worktree of the clone the build filled: setup is not run, what it installed is copied in.
  expect(bootNote({ ...booted, setup: "copying" })).toBe(
    "[Caveman Code] This Cloud computer booted from the repo's snapshot built 2 h ago at 0123456. Setup is not run again: what it installed is being copied into this chat's checkout now; a note says when it is there.",
  );
  expect(
    bootNote({
      ...booted,
      setup: "skipped",
      steps: [
        "Could not fetch main from GitHub, so this computer has it as of its last fetch: no route to host.",
        "`pnpm dev` ([start]) exited with code 1 after 0.4 s. It said: EADDRINUSE",
      ],
    }),
  ).toBe(
    "[Caveman Code] This Cloud computer booted from the repo's snapshot built 2 h ago at 0123456. Setup skipped: nothing it installs changed since. When it last woke: Could not fetch main from GitHub, so this computer has it as of its last fetch: no route to host. `pnpm dev` ([start]) exited with code 1 after 0.4 s. It said: EADDRINUSE",
  );
});
